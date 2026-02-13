// TASK_STATUS
// 是什么：任务状态常量定义。
// 做什么：统一约束后端可识别的任务状态值，避免散落硬编码。
// 为什么：状态字符串在同步、卡片交互、接口返回中都会使用，集中维护可降低出错概率。
const TASK_STATUS = {
  PENDING: 'PENDING',
  WAITING_VERIFY: 'WAITING_VERIFY',
  COMPLETED: 'COMPLETED',
};

// REMINDER_KIND
// 是什么：任务提醒类型常量定义。
// 做什么：标识日期提醒的语义（无提醒/即将到期/已逾期）。
// 为什么：提醒去重与文案分支都依赖稳定枚举值。
const REMINDER_KIND = {
  NONE: 'NONE',
  DUE_SOON: 'DUE_SOON',
  OVERDUE: 'OVERDUE',
};

// normalizeText
// 是什么：文本标准化函数。
// 做什么：将输入转换为去首尾空白的字符串，兼容空值与数组值。
// 为什么：企业微信回调与数据库字段可能出现不同形态，需先标准化再比较。
const normalizeText = (value) => {
  if (Array.isArray(value)) {
    return normalizeText(value[0]);
  }

  if (value === undefined || value === null) {
    return '';
  }

  return String(value).trim();
};

// parseGlobalVerifiers
// 是什么：全局验收人解析函数。
// 做什么：将逗号分隔字符串转换为去空白且去重后的用户列表。
// 为什么：环境变量可能包含空值与重复项，直接使用会导致验收权限判断不准确。
const parseGlobalVerifiers = (rawValue) => {
  const normalized = normalizeText(rawValue);
  if (!normalized) {
    return [];
  }

  const uniqueUsers = new Set();
  normalized
    .split(',')
    .map((item) => normalizeText(item))
    .filter(Boolean)
    .forEach((item) => {
      uniqueUsers.add(item);
    });

  return Array.from(uniqueUsers);
};

// normalizeActionKey
// 是什么：卡片动作键标准化函数。
// 做什么：将选项键统一转为大写下划线形式，兼容大小写与空格。
// 为什么：不同消息来源的动作键格式可能不一致，需要统一后再分发业务逻辑。
const normalizeActionKey = (selectedKey) => {
  return normalizeText(selectedKey).toUpperCase();
};

// toDateOrNull
// 是什么：日期解析函数。
// 做什么：将字符串或时间对象转换为合法 Date，非法值返回 null。
// 为什么：数据库中可能存在空时间字段，提醒和 KPI 计算需要可控的日期解析结果。
const toDateOrNull = (value) => {
  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }

  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed;
};

// canUserCompleteTask
// 是什么：执行完成权限判断函数。
// 做什么：校验当前用户是否为任务执行人且任务处于待执行状态。
// 为什么：避免非执行人或错误状态触发“提交验收”操作。
const canUserCompleteTask = (task, userId) => {
  if (!task) {
    return false;
  }

  const normalizedUserId = normalizeText(userId);
  const executorId = normalizeText(task.executor_userid);
  const status = normalizeText(task.status);

  return Boolean(
    normalizedUserId &&
      executorId &&
      normalizedUserId === executorId &&
      status === TASK_STATUS.PENDING
  );
};

// canUserVerifyTask
// 是什么：验收权限判断函数。
// 做什么：校验当前用户是否具备任务验收权限（创建人或全局验收人）。
// 为什么：确保只有授权管理者可执行“通过/驳回”，避免越权改状态。
const canUserVerifyTask = (task, userId, globalVerifiers = []) => {
  if (!task) {
    return false;
  }

  const normalizedUserId = normalizeText(userId);
  const creatorId = normalizeText(task.creator_userid);
  const status = normalizeText(task.status);
  const verifierSet = new Set(
    (Array.isArray(globalVerifiers) ? globalVerifiers : [])
      .map((item) => normalizeText(item))
      .filter(Boolean)
  );

  if (!normalizedUserId || status !== TASK_STATUS.WAITING_VERIFY) {
    return false;
  }

  return normalizedUserId === creatorId || verifierSet.has(normalizedUserId);
};

// getReminderKind
// 是什么：任务提醒类型计算函数。
// 做什么：基于当前时间与任务截止时间，判断是否需要“即将到期/逾期”提醒。
// 为什么：日期提醒属于闭环关键能力，需统一判定逻辑避免前后端口径不一致。
const getReminderKind = (task, now = new Date()) => {
  if (!task || normalizeText(task.status) !== TASK_STATUS.PENDING) {
    return REMINDER_KIND.NONE;
  }

  const endTime = toDateOrNull(task.end_time);
  if (!endTime) {
    return REMINDER_KIND.NONE;
  }

  const nowDate = now instanceof Date ? now : new Date(now);
  const diffMs = endTime.getTime() - nowDate.getTime();

  if (diffMs < 0) {
    return REMINDER_KIND.OVERDUE;
  }

  if (diffMs <= 24 * 60 * 60 * 1000) {
    return REMINDER_KIND.DUE_SOON;
  }

  return REMINDER_KIND.NONE;
};

// shouldSendReminder
// 是什么：提醒发送决策函数。
// 做什么：按提醒类型和冷却时间判断当前任务是否应再次发送提醒。
// 为什么：防止每次定时扫描重复推送相同提醒，降低消息噪声。
const shouldSendReminder = (task, reminderKind, now = new Date(), cooldownHours = 12) => {
  if (!task || reminderKind === REMINDER_KIND.NONE) {
    return false;
  }

  const previousKind = normalizeText(task.last_reminder_kind);
  if (!previousKind || previousKind !== reminderKind) {
    return true;
  }

  const previousReminderAt = toDateOrNull(task.last_reminder_at);
  if (!previousReminderAt) {
    return true;
  }

  const nowDate = now instanceof Date ? now : new Date(now);
  const elapsedMs = nowDate.getTime() - previousReminderAt.getTime();
  return elapsedMs >= cooldownHours * 60 * 60 * 1000;
};

// isTaskOverdue
// 是什么：任务逾期判断函数。
// 做什么：基于截止时间与当前状态判断任务是否逾期（完成态不算逾期）。
// 为什么：KPI 与看板需要统一逾期口径，防止统计偏差。
const isTaskOverdue = (task, now = new Date()) => {
  const endTime = toDateOrNull(task && task.end_time);
  if (!task || !endTime) {
    return false;
  }

  const status = normalizeText(task.status);
  if (status === TASK_STATUS.COMPLETED) {
    return false;
  }

  const nowDate = now instanceof Date ? now : new Date(now);
  return endTime.getTime() < nowDate.getTime();
};

// isTaskDueSoon
// 是什么：任务即将到期判断函数。
// 做什么：判断任务是否在 24 小时内到期且未完成、未逾期。
// 为什么：用于提醒发送与前端“日期提醒”标记展示。
const isTaskDueSoon = (task, now = new Date()) => {
  const endTime = toDateOrNull(task && task.end_time);
  if (!task || !endTime) {
    return false;
  }

  if (normalizeText(task.status) !== TASK_STATUS.PENDING) {
    return false;
  }

  const nowDate = now instanceof Date ? now : new Date(now);
  const diffMs = endTime.getTime() - nowDate.getTime();
  return diffMs >= 0 && diffMs <= 24 * 60 * 60 * 1000;
};

// mapTaskRowToApi
// 是什么：任务数据库行到接口返回模型的映射函数。
// 做什么：补充权限标记、日期提醒标记与重做计数，输出前端可直接消费结构。
// 为什么：避免前端重复业务判断，统一由后端提供闭环所需字段。
const mapTaskRowToApi = (row, options = {}) => {
  const now = options.now instanceof Date ? options.now : new Date();
  const currentUserId = normalizeText(options.currentUserId);
  const globalVerifiers = Array.isArray(options.globalVerifiers) ? options.globalVerifiers : [];

  return {
    ...row,
    redo_count: Number(row.redo_count || 0),
    can_complete: canUserCompleteTask(row, currentUserId),
    can_verify: canUserVerifyTask(row, currentUserId, globalVerifiers),
    is_due_soon: isTaskDueSoon(row, now),
    is_overdue: isTaskOverdue(row, now),
  };
};

// buildTaskKpi
// 是什么：任务 KPI 聚合函数。
// 做什么：从任务列表计算总数、完成率、待验收、逾期与即将到期指标。
// 为什么：看板 KPI 需由同一后端口径输出，确保企业微信与 Web 端统计一致。
const buildTaskKpi = (rows = [], now = new Date()) => {
  const taskRows = Array.isArray(rows) ? rows : [];
  const totalCount = taskRows.length;
  const completedCount = taskRows.filter((item) => normalizeText(item.status) === TASK_STATUS.COMPLETED).length;
  const waitingVerifyCount = taskRows.filter((item) => normalizeText(item.status) === TASK_STATUS.WAITING_VERIFY).length;
  const overdueCount = taskRows.filter((item) => isTaskOverdue(item, now)).length;
  const dueSoonCount = taskRows.filter((item) => isTaskDueSoon(item, now)).length;

  const onTimeCompletedCount = taskRows.filter((item) => {
    if (normalizeText(item.status) !== TASK_STATUS.COMPLETED) {
      return false;
    }

    const completionTime = toDateOrNull(item.completion_time || item.verify_time);
    const endTime = toDateOrNull(item.end_time);
    if (!completionTime || !endTime) {
      return false;
    }

    return completionTime.getTime() <= endTime.getTime();
  }).length;

  const completionRate = totalCount > 0 ? Number(((completedCount / totalCount) * 100).toFixed(2)) : 0;
  const onTimeRate = completedCount > 0 ? Number(((onTimeCompletedCount / completedCount) * 100).toFixed(2)) : 0;

  return {
    total_tasks: totalCount,
    completed_tasks: completedCount,
    waiting_verify_tasks: waitingVerifyCount,
    overdue_tasks: overdueCount,
    due_soon_tasks: dueSoonCount,
    completion_rate: completionRate,
    on_time_rate: onTimeRate,
  };
};

module.exports = {
  TASK_STATUS,
  REMINDER_KIND,
  normalizeText,
  parseGlobalVerifiers,
  normalizeActionKey,
  canUserCompleteTask,
  canUserVerifyTask,
  getReminderKind,
  shouldSendReminder,
  isTaskOverdue,
  isTaskDueSoon,
  mapTaskRowToApi,
  buildTaskKpi,
};

