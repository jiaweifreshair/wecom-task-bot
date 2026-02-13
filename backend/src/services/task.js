const db = require('../models/db');
const wecom = require('./wecom');
const {
  TASK_STATUS,
  REMINDER_KIND,
  normalizeText,
  parseGlobalVerifiers,
  normalizeActionKey,
  canUserCompleteTask,
  canUserVerifyTask,
  getReminderKind,
  shouldSendReminder,
} = require('./task-lifecycle');
const { resolveCalendarIdByUser } = require('./calendar-mapping');
const { logWithTrace, createTraceId } = require('../utils/logger');

class TaskOperationError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = 'TaskOperationError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

// createManualScheduleId
// 是什么：手动任务日程ID生成函数。
// 做什么：为Web端创建的任务生成唯一 `wecom_schedule_id`。
// 为什么：数据库字段要求唯一，且需与企微同步任务共享同一标识语义。
const createManualScheduleId = () => {
  return `manual_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
};

// parseIsoDate
// 是什么：ISO日期解析函数。
// 做什么：将输入值解析为合法日期对象，失败时返回 `null`。
// 为什么：创建任务接口需校验开始/截止时间合法性，避免脏数据写入数据库。
const parseIsoDate = (value) => {
  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }

  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date;
};

// toUnixSeconds
// 是什么：时间戳转换函数。
// 做什么：将 Date 转换为企业微信日程接口使用的秒级时间戳。
// 为什么：`oa/schedule/add` 要求 `start_time/end_time` 为 Unix 秒，避免时区与格式歧义。
const toUnixSeconds = (dateValue) => {
  if (!(dateValue instanceof Date)) {
    return 0;
  }
  return Math.floor(dateValue.getTime() / 1000);
};

const runSql = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) {
        reject(err);
        return;
      }

      resolve({
        changes: this.changes || 0,
        lastID: this.lastID,
      });
    });
  });
};

const getSql = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(row || null);
    });
  });
};

const allSql = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(rows || []);
    });
  });
};

class TaskService {
  getGlobalVerifiers() {
    return parseGlobalVerifiers(process.env.GLOBAL_VERIFIERS || '');
  }

  async getTaskById(taskId) {
    return getSql(`SELECT * FROM tasks WHERE id = ?`, [taskId]);
  }

  async getTaskByScheduleId(wecomScheduleId) {
    return getSql(`SELECT * FROM tasks WHERE wecom_schedule_id = ?`, [wecomScheduleId]);
  }

  async listPendingTasks() {
    return allSql(`SELECT * FROM tasks WHERE status = ?`, [TASK_STATUS.PENDING]);
  }

  buildVerifierRecipients(task) {
    const extraVerifiers = this.getGlobalVerifiers();
    const recipientSet = new Set([normalizeText(task.creator_userid), ...extraVerifiers].filter(Boolean));
    return Array.from(recipientSet).join('|');
  }

  async sendExecutorActionCard(task, title, description, buttons = []) {
    const touser = normalizeText(task.executor_userid);
    if (!touser) {
      return;
    }

    await wecom.sendTemplateCard({
      touser,
      task_id: task.wecom_schedule_id,
      title,
      description,
      sub_title: normalizeText(task.title),
      details: [
        {
          keyname: '截止时间',
          value: normalizeText(task.end_time),
        },
      ],
      buttons,
    });
  }

  async sendVerifierCard(task) {
    const touser = this.buildVerifierRecipients(task);
    if (!touser) {
      return;
    }

    await wecom.sendTemplateCard({
      touser,
      task_id: task.wecom_schedule_id,
      title: '✅ 任务验收请求',
      description: `${task.executor_userid} 已提交任务，等待验收`,
      sub_title: normalizeText(task.title),
      details: [
        {
          keyname: '任务状态',
          value: '待验收',
        },
      ],
      buttons: [
        { id: 'ACTION_PASS', text: '确认通过' },
        { id: 'ACTION_REJECT', text: '驳回重做' },
      ],
    });
  }

  async sendVerificationResultCard(task, isApproved, rejectReason = '') {
    const message = isApproved
      ? `🎉 任务 [${task.title}] 已通过验收。`
      : `⚠️ 任务 [${task.title}] 被驳回：${rejectReason || '请补充后重新提交'}`;

    await this.sendExecutorActionCard(
      task,
      isApproved ? '任务闭环通知' : '任务驳回通知',
      message,
      isApproved ? [] : [{ id: 'ACTION_COMPLETE', text: '再次提交' }]
    );
  }

  ensureTaskForComplete(task, userId) {
    if (!task) {
      throw new TaskOperationError('TASK_NOT_FOUND', '任务不存在', 404);
    }

    if (!canUserCompleteTask(task, userId)) {
      throw new TaskOperationError('TASK_COMPLETE_FORBIDDEN', '仅执行人可提交待执行任务', 403);
    }
  }

  ensureTaskForVerify(task, userId) {
    if (!task) {
      throw new TaskOperationError('TASK_NOT_FOUND', '任务不存在', 404);
    }

    if (!canUserVerifyTask(task, userId, this.getGlobalVerifiers())) {
      throw new TaskOperationError('TASK_VERIFY_FORBIDDEN', '当前用户无验收权限或状态不正确', 403);
    }
  }

  async submitForVerification(wecomScheduleId, executorId, source = 'wecom_card') {
    const traceId = createTraceId();
    const task = await this.getTaskByScheduleId(wecomScheduleId);
    this.ensureTaskForComplete(task, executorId);

    const updateResult = await runSql(
      `UPDATE tasks
       SET status = ?, completion_time = datetime('now'), completed_by_userid = ?, reject_reason = NULL, updated_at = datetime('now')
       WHERE wecom_schedule_id = ? AND status = ?`,
      [TASK_STATUS.WAITING_VERIFY, normalizeText(executorId), wecomScheduleId, TASK_STATUS.PENDING]
    );

    if (updateResult.changes === 0) {
      throw new TaskOperationError('TASK_STATUS_CONFLICT', '任务状态已变更，请刷新后重试', 409);
    }

    const updatedTask = await this.getTaskByScheduleId(wecomScheduleId);

    try {
      await this.sendVerifierCard(updatedTask);
    } catch (error) {
      logWithTrace(traceId, 'task-service', 'submit_for_verification.notify_error', {
        wecomScheduleId,
        source,
        message: error.message,
      });
    }

    logWithTrace(traceId, 'task-service', 'submit_for_verification.success', {
      wecomScheduleId,
      executorId,
      source,
    });

    return {
      message: '任务已提交验收',
      task: updatedTask,
    };
  }

  async verifyTask(wecomScheduleId, managerId, isApproved, rejectReason = '', source = 'wecom_card') {
    const traceId = createTraceId();
    const task = await this.getTaskByScheduleId(wecomScheduleId);
    this.ensureTaskForVerify(task, managerId);

    const normalizedReason = normalizeText(rejectReason) || '领导驳回';
    const sql = isApproved
      ? `UPDATE tasks
         SET status = ?, verify_time = datetime('now'), verified_by_userid = ?, reject_reason = NULL, updated_at = datetime('now')
         WHERE wecom_schedule_id = ? AND status = ?`
      : `UPDATE tasks
         SET status = ?, verify_time = datetime('now'), verified_by_userid = ?, reject_reason = ?, redo_count = COALESCE(redo_count, 0) + 1, updated_at = datetime('now')
         WHERE wecom_schedule_id = ? AND status = ?`;

    const params = isApproved
      ? [TASK_STATUS.COMPLETED, normalizeText(managerId), wecomScheduleId, TASK_STATUS.WAITING_VERIFY]
      : [TASK_STATUS.PENDING, normalizeText(managerId), normalizedReason, wecomScheduleId, TASK_STATUS.WAITING_VERIFY];

    const updateResult = await runSql(sql, params);
    if (updateResult.changes === 0) {
      throw new TaskOperationError('TASK_STATUS_CONFLICT', '任务状态已变更，请刷新后重试', 409);
    }

    const updatedTask = await this.getTaskByScheduleId(wecomScheduleId);

    try {
      await this.sendVerificationResultCard(updatedTask, isApproved, normalizedReason);
    } catch (error) {
      logWithTrace(traceId, 'task-service', 'verify_task.notify_error', {
        wecomScheduleId,
        managerId,
        source,
        message: error.message,
      });
    }

    logWithTrace(traceId, 'task-service', 'verify_task.success', {
      wecomScheduleId,
      managerId,
      isApproved,
      source,
    });

    return {
      message: isApproved ? '任务已验收通过' : '任务已驳回并退回执行',
      task: updatedTask,
    };
  }

  async completeTaskById(taskId, executorId, source = 'web') {
    const task = await this.getTaskById(taskId);
    if (!task) {
      throw new TaskOperationError('TASK_NOT_FOUND', '任务不存在', 404);
    }

    return this.submitForVerification(task.wecom_schedule_id, executorId, source);
  }

  async verifyTaskById(taskId, managerId, isApproved, rejectReason = '', source = 'web') {
    const task = await this.getTaskById(taskId);
    if (!task) {
      throw new TaskOperationError('TASK_NOT_FOUND', '任务不存在', 404);
    }

    return this.verifyTask(task.wecom_schedule_id, managerId, isApproved, rejectReason, source);
  }

  // createManualTask
  // 是什么：手动任务创建函数。
  // 做什么：将Web端输入的任务信息入库，并通知执行人开始处理。
  // 为什么：补齐“产品页面新建任务”能力，形成从创建到验收的完整闭环。
  async createManualTask(payload = {}, creatorUserId, source = 'web_api') {
    const traceId = createTraceId();
    const title = normalizeText(payload.title);
    const description = normalizeText(payload.description);
    const executorUserId = normalizeText(payload.executor_userid);
    const startTime = parseIsoDate(payload.start_time) || new Date();
    const endTime = parseIsoDate(payload.end_time);
    const creatorId = normalizeText(creatorUserId);

    if (!creatorId) {
      throw new TaskOperationError('TASK_CREATOR_INVALID', '创建人不能为空', 400);
    }

    if (!title) {
      throw new TaskOperationError('TASK_TITLE_REQUIRED', '任务标题不能为空', 400);
    }

    if (!executorUserId) {
      throw new TaskOperationError('TASK_EXECUTOR_REQUIRED', '执行人不能为空', 400);
    }

    if (!endTime) {
      throw new TaskOperationError('TASK_END_TIME_INVALID', '截止时间格式不正确', 400);
    }

    if (endTime.getTime() <= startTime.getTime()) {
      throw new TaskOperationError('TASK_TIME_RANGE_INVALID', '截止时间必须晚于开始时间', 400);
    }

    const ownerUserId = executorUserId || creatorId;
    const ownerCalendarId = resolveCalendarIdByUser(ownerUserId, {
      defaultCalId: process.env.DEFAULT_CAL_ID || '',
      userCalendarMapRaw: process.env.USER_CALENDAR_MAP || '',
    });

    let scheduleId = createManualScheduleId();

    // buildScheduleAttendees
    // 是什么：任务创建参与人构建逻辑。
    // 做什么：将执行人与创建人组装为企业微信日程参与人数组并去重。
    // 为什么：确保任务日程在个人日历可见，同时减少重复成员导致的接口风险。
    const scheduleAttendees = Array.from(new Set([executorUserId, creatorId].filter(Boolean))).map((userid) => ({
      userid,
    }));

    if (ownerCalendarId) {
      try {
        const scheduleResult = await wecom.createSchedule({
          organizer: ownerUserId,
          summary: title,
          description,
          start_time: toUnixSeconds(startTime),
          end_time: toUnixSeconds(endTime),
          attendees: scheduleAttendees,
          cal_id: ownerCalendarId,
        });

        if (scheduleResult && scheduleResult.errcode === 0 && normalizeText(scheduleResult.schedule_id)) {
          scheduleId = normalizeText(scheduleResult.schedule_id);
        } else {
          logWithTrace(traceId, 'task-service', 'manual_task.schedule_create_reject', {
            creatorId,
            ownerCalendarId,
            errcode: scheduleResult && scheduleResult.errcode,
            errmsg: scheduleResult && scheduleResult.errmsg,
          });
        }
      } catch (error) {
        logWithTrace(traceId, 'task-service', 'manual_task.schedule_create_error', {
          creatorId,
          ownerCalendarId,
          message: error.message,
        });
      }
    }

    const insertResult = await runSql(
      `INSERT INTO tasks (
        wecom_schedule_id,
        title,
        description,
        creator_userid,
        executor_userid,
        owner_userid,
        owner_cal_id,
        start_time,
        end_time,
        status,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime(?), datetime(?), ?, datetime('now'))`,
      [
        scheduleId,
        title,
        description,
        creatorId,
        executorUserId,
        ownerUserId,
        ownerCalendarId,
        startTime.toISOString(),
        endTime.toISOString(),
        TASK_STATUS.PENDING,
      ]
    );

    const createdTask = await this.getTaskById(insertResult.lastID);

    try {
      await this.sendExecutorActionCard(
        createdTask,
        '📌 新任务待执行',
        `请按计划完成任务：${createdTask.title}`,
        [{ id: 'ACTION_COMPLETE', text: '我已完成' }]
      );
    } catch (error) {
      logWithTrace(traceId, 'task-service', 'manual_task.notify_error', {
        scheduleId,
        creatorId,
        executorUserId,
        source,
        message: error.message,
      });
    }

    logWithTrace(traceId, 'task-service', 'manual_task.create_success', {
      taskId: createdTask && createdTask.id,
      scheduleId,
      creatorId,
      executorUserId,
      ownerUserId,
      ownerCalendarId,
      source,
    });

    return {
      message: '任务创建成功',
      task: createdTask,
    };
  }

  pickExecutor(schedule) {
    const organizer = normalizeText(
      (schedule.organizer && schedule.organizer.userid) || schedule.organizer || schedule.creator_userid
    );

    const attendees = Array.isArray(schedule.attendees)
      ? schedule.attendees
      : Array.isArray(schedule.attendee)
      ? schedule.attendee
      : [];

    const attendeeUserIds = attendees
      .map((item) => normalizeText((item && item.userid) || item))
      .filter(Boolean);

    const primaryAttendee = attendeeUserIds.find((item) => item !== organizer);
    return primaryAttendee || attendeeUserIds[0] || organizer;
  }

  async syncScheduleTask(schedule, calendarContext = {}) {
    const traceId = createTraceId();
    const scheduleId = normalizeText(schedule && schedule.schedule_id);
    if (!scheduleId) {
      return {
        inserted: false,
        updated: false,
        skipped: true,
        reason: 'missing_schedule_id',
      };
    }

    const executorUserId = this.pickExecutor(schedule);
    const taskPayload = {
      wecom_schedule_id: scheduleId,
      title: normalizeText(schedule.summary) || '未命名任务',
      description: normalizeText(schedule.description),
      creator_userid: normalizeText(
        (schedule.organizer && schedule.organizer.userid) || schedule.organizer || schedule.creator_userid
      ),
      executor_userid: executorUserId,
      owner_userid: normalizeText(calendarContext.user_id) || executorUserId,
      start_time: Number(schedule.start_time || 0),
      end_time: Number(schedule.end_time || 0),
      owner_cal_id: normalizeText(schedule.cal_id || schedule.calendar_id || calendarContext.cal_id),
    };

    if (!taskPayload.creator_userid || !taskPayload.executor_userid) {
      return {
        inserted: false,
        updated: false,
        skipped: true,
        reason: 'missing_creator_or_executor',
      };
    }

    const existedTask = await this.getTaskByScheduleId(scheduleId);

    if (!existedTask) {
      await runSql(
        `INSERT INTO tasks (
          wecom_schedule_id, title, description, creator_userid, executor_userid, owner_userid, owner_cal_id, start_time, end_time, status, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, datetime(?, 'unixepoch'), datetime(?, 'unixepoch'), ?, datetime('now')
        )`,
        [
          taskPayload.wecom_schedule_id,
          taskPayload.title,
          taskPayload.description,
          taskPayload.creator_userid,
          taskPayload.executor_userid,
          taskPayload.owner_userid,
          taskPayload.owner_cal_id,
          taskPayload.start_time,
          taskPayload.end_time,
          TASK_STATUS.PENDING,
        ]
      );

      const insertedTask = await this.getTaskByScheduleId(scheduleId);

      try {
        await this.sendExecutorActionCard(
          insertedTask,
          '📌 新任务待执行',
          `请按日程完成任务：${insertedTask.title}`,
          [{ id: 'ACTION_COMPLETE', text: '我已完成' }]
        );
      } catch (error) {
        logWithTrace(traceId, 'task-service', 'sync_schedule.notify_insert_error', {
          scheduleId,
          message: error.message,
        });
      }

      return {
        inserted: true,
        updated: false,
        skipped: false,
        task: insertedTask,
      };
    }

    await runSql(
      `UPDATE tasks
       SET title = ?,
           description = ?,
           creator_userid = ?,
           executor_userid = ?,
           owner_userid = ?,
           owner_cal_id = ?,
           start_time = datetime(?, 'unixepoch'),
           end_time = datetime(?, 'unixepoch'),
           updated_at = datetime('now')
       WHERE wecom_schedule_id = ?`,
      [
        taskPayload.title,
        taskPayload.description,
        taskPayload.creator_userid,
        taskPayload.executor_userid,
        taskPayload.owner_userid,
        taskPayload.owner_cal_id,
        taskPayload.start_time,
        taskPayload.end_time,
        scheduleId,
      ]
    );

    const updatedTask = await this.getTaskByScheduleId(scheduleId);
    return {
      inserted: false,
      updated: true,
      skipped: false,
      task: updatedTask,
    };
  }

  async dispatchTaskReminder(task, source = 'sync_cron') {
    const traceId = createTraceId();
    const reminderKind = getReminderKind(task);
    if (!shouldSendReminder(task, reminderKind)) {
      return {
        sent: false,
        kind: reminderKind,
      };
    }

    const reminderDescription =
      reminderKind === REMINDER_KIND.OVERDUE
        ? `任务已逾期，请尽快处理：${task.title}`
        : `任务将在24小时内到期，请及时处理：${task.title}`;

    try {
      await this.sendExecutorActionCard(
        task,
        reminderKind === REMINDER_KIND.OVERDUE ? '⏰ 任务逾期提醒' : '🕒 任务到期提醒',
        reminderDescription,
        [{ id: 'ACTION_COMPLETE', text: '我已完成' }]
      );

      await runSql(
        `UPDATE tasks SET last_reminder_at = datetime('now'), last_reminder_kind = ?, updated_at = datetime('now') WHERE id = ?`,
        [reminderKind, task.id]
      );

      logWithTrace(traceId, 'task-service', 'task_reminder.sent', {
        taskId: task.id,
        scheduleId: task.wecom_schedule_id,
        reminderKind,
        source,
      });

      return {
        sent: true,
        kind: reminderKind,
      };
    } catch (error) {
      logWithTrace(traceId, 'task-service', 'task_reminder.error', {
        taskId: task.id,
        scheduleId: task.wecom_schedule_id,
        reminderKind,
        source,
        message: error.message,
      });

      return {
        sent: false,
        kind: reminderKind,
      };
    }
  }

  async handleInteraction(payload) {
    const traceId = createTraceId();
    const userId = normalizeText(payload && payload.UserID);
    const scheduleId = normalizeText(payload && payload.TaskId);
    const actionKey = normalizeActionKey(payload && payload.SelectedKey);

    logWithTrace(traceId, 'task-service', 'interaction.start', {
      userId,
      scheduleId,
      actionKey,
    });

    if (!userId || !scheduleId || !actionKey) {
      throw new TaskOperationError('TASK_INTERACTION_INVALID', '卡片回调参数不完整', 400);
    }

    if (actionKey === 'ACTION_COMPLETE') {
      return this.submitForVerification(scheduleId, userId, 'wecom_card');
    }

    if (actionKey === 'ACTION_PASS') {
      return this.verifyTask(scheduleId, userId, true, '', 'wecom_card');
    }

    if (actionKey === 'ACTION_REJECT') {
      return this.verifyTask(scheduleId, userId, false, '领导驳回', 'wecom_card');
    }

    logWithTrace(traceId, 'task-service', 'interaction.skip', {
      userId,
      scheduleId,
      actionKey,
      reason: 'unsupported_selected_key',
    });

    throw new TaskOperationError('TASK_INTERACTION_UNSUPPORTED', '不支持的卡片动作', 400);
  }
}

module.exports = {
  taskService: new TaskService(),
  TaskOperationError,
};
