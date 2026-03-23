const { PLATFORM_ROLE, isAdminRole, normalizePlatformRole } = require('./platform-access');

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

// TASK_TEAM_ROLE
// 是什么：团队统计角色常量。
// 做什么：统一约束团队统计中的“管理岗/执行岗”取值。
// 为什么：团队看板需要按不同岗位口径输出统计，避免前后端各自定义字符串。
const TASK_TEAM_ROLE = {
  MANAGER: 'MANAGER',
  EXECUTOR: 'EXECUTOR',
};

// DEFAULT_POSITION_LABEL
// 是什么：岗位缺省文案常量。
// 做什么：在通讯录尚未同步岗位信息时提供稳定兜底显示。
// 为什么：团队统计需要按岗位聚合，空岗位若不兜底会造成分组缺失和表格空白。
const DEFAULT_POSITION_LABEL = '未设置岗位';

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

// isTaskCompletedOnTime
// 是什么：任务按时完成判断函数。
// 做什么：判断已完成任务的完成时间是否早于或等于截止时间。
// 为什么：KPI、岗位统计和风险看板都需要复用这一统一口径。
const isTaskCompletedOnTime = (task) => {
  if (normalizeText(task && task.status) !== TASK_STATUS.COMPLETED) {
    return false;
  }

  const completionTime = toDateOrNull(task && (task.completion_time || task.verify_time));
  const endTime = toDateOrNull(task && task.end_time);
  if (!completionTime || !endTime) {
    return false;
  }

  return completionTime.getTime() <= endTime.getTime();
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
// 做什么：校验当前用户是否具备任务验收权限（创建人、平台管理员或全局验收人）。
// 为什么：执行对象不可越权验收任务，但平台管理员需要具备统一管理能力。
const canUserVerifyTask = (task, userId, options = {}) => {
  if (!task) {
    return false;
  }

  const normalizedUserId = normalizeText(userId);
  const creatorId = normalizeText(task.creator_userid);
  const status = normalizeText(task.status);
  const normalizedOptions = Array.isArray(options) ? { globalVerifiers: options } : options || {};
  const userPlatformRole = normalizePlatformRole(normalizedOptions.currentUserPlatformRole);
  const userIsAdmin = isAdminRole(userPlatformRole);
  const verifierSet = new Set(
    (Array.isArray(normalizedOptions.globalVerifiers) ? normalizedOptions.globalVerifiers : [])
      .map((item) => normalizeText(item))
      .filter(Boolean)
  );

  if (!normalizedUserId || status !== TASK_STATUS.WAITING_VERIFY) {
    return false;
  }

  return userIsAdmin || normalizedUserId === creatorId || verifierSet.has(normalizedUserId);
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
  const currentUserPlatformRole = normalizePlatformRole(options.currentUserPlatformRole);

  return {
    ...row,
    redo_count: Number(row.redo_count || 0),
    can_complete: canUserCompleteTask(row, currentUserId),
    can_verify: canUserVerifyTask(row, currentUserId, {
      globalVerifiers,
      currentUserPlatformRole,
    }),
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
  const onTimeCompletedCount = taskRows.filter((item) => isTaskCompletedOnTime(item)).length;

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

// buildUserDirectoryIndex
// 是什么：用户目录索引构建函数。
// 做什么：将通讯录成员列表转换为 `user_id -> 用户信息` 的查找表。
// 为什么：团队统计需频繁按 user_id 读取姓名与岗位，使用索引可减少重复解析。
const buildUserDirectoryIndex = (rows = []) => {
  const index = new Map();

  (Array.isArray(rows) ? rows : []).forEach((item) => {
    const userId = normalizeText(item && (item.user_id || item.userid || item.id));
    if (!userId) {
      return;
    }

    index.set(userId, {
      user_id: userId,
      user_name: normalizeText(item && item.name) || userId,
      position: normalizeText(item && item.position) || DEFAULT_POSITION_LABEL,
    });
  });

  return index;
};

// createRoleMetricRecord
// 是什么：岗位统计记录初始化函数。
// 做什么：为成员、岗位分组和总览生成统一结构的累加器。
// 为什么：管理岗和执行岗仅口径不同，基础指标字段应保持一致，便于前端复用。
const createRoleMetricRecord = ({ role, userId = '', userName = '', position = DEFAULT_POSITION_LABEL } = {}) => {
  return {
    role,
    user_id: userId,
    user_name: userName || userId || '',
    position: position || DEFAULT_POSITION_LABEL,
    task_count: 0,
    completed_count: 0,
    pending_count: 0,
    waiting_verify_count: 0,
    overdue_count: 0,
    due_soon_count: 0,
    member_count: 0,
    _on_time_completed_count: 0,
    _member_ids: new Set(),
  };
};

// applyTaskToMetricRecord
// 是什么：单任务指标累加函数。
// 做什么：把一条任务按统一口径累加到成员/岗位/总览统计对象。
// 为什么：团队统计需要多个维度同时累计，抽成公共函数能确保口径一致。
const applyTaskToMetricRecord = (record, task, now) => {
  if (!record || !task) {
    return record;
  }

  const status = normalizeText(task.status);
  record.task_count += 1;

  if (status === TASK_STATUS.COMPLETED) {
    record.completed_count += 1;
    if (isTaskCompletedOnTime(task)) {
      record._on_time_completed_count += 1;
    }
  }

  if (status === TASK_STATUS.PENDING) {
    record.pending_count += 1;
  }

  if (status === TASK_STATUS.WAITING_VERIFY) {
    record.waiting_verify_count += 1;
  }

  if (isTaskOverdue(task, now)) {
    record.overdue_count += 1;
  }

  if (isTaskDueSoon(task, now)) {
    record.due_soon_count += 1;
  }

  return record;
};

// finalizeRoleMetricRecord
// 是什么：岗位统计记录收口函数。
// 做什么：为累加器补全完成率/按时率并移除内部字段。
// 为什么：内部累计状态不应直接暴露给接口层，需统一收敛为稳定响应结构。
const finalizeRoleMetricRecord = (record) => {
  const completedCount = Number(record && record.completed_count) || 0;
  const taskCount = Number(record && record.task_count) || 0;
  const onTimeCompletedCount = Number(record && record._on_time_completed_count) || 0;
  const memberCount = Number(record && record.member_count) || 0;

  return {
    role: normalizeText(record && record.role),
    user_id: normalizeText(record && record.user_id),
    user_name: normalizeText(record && record.user_name),
    position: normalizeText(record && record.position) || DEFAULT_POSITION_LABEL,
    member_count: memberCount,
    task_count: taskCount,
    completed_count: completedCount,
    pending_count: Number(record && record.pending_count) || 0,
    waiting_verify_count: Number(record && record.waiting_verify_count) || 0,
    overdue_count: Number(record && record.overdue_count) || 0,
    due_soon_count: Number(record && record.due_soon_count) || 0,
    completion_rate: taskCount > 0 ? Number(((completedCount / taskCount) * 100).toFixed(2)) : 0,
    on_time_rate: completedCount > 0 ? Number(((onTimeCompletedCount / completedCount) * 100).toFixed(2)) : 0,
  };
};

// compareRoleMetricRecord
// 是什么：岗位统计排序函数。
// 做什么：优先按任务量、逾期数排序，最后按姓名或岗位名稳定排序。
// 为什么：让团队看板默认把高风险高负载对象排在前面，提升管理效率。
const compareRoleMetricRecord = (left, right) => {
  const taskDiff = Number(right.task_count || 0) - Number(left.task_count || 0);
  if (taskDiff !== 0) {
    return taskDiff;
  }

  const overdueDiff = Number(right.overdue_count || 0) - Number(left.overdue_count || 0);
  if (overdueDiff !== 0) {
    return overdueDiff;
  }

  return String(left.user_name || left.position || '').localeCompare(String(right.user_name || right.position || ''));
};

// buildTaskTeamStats
// 是什么：团队岗位统计聚合函数。
// 做什么：基于任务列表、通讯录和平台权限信息，分别输出管理员与执行对象统计。
// 为什么：团队看板必须遵循平台权限模型，而不是继续把“发起人/执行人”误当成平台岗位。
const buildTaskTeamStats = (rows = [], userDirectoryRows = [], now = new Date(), platformRoleMap = new Map()) => {
  const taskRows = Array.isArray(rows) ? rows : [];
  const userDirectoryIndex = buildUserDirectoryIndex(userDirectoryRows);
  const roleConfigs = [
    {
      role: TASK_TEAM_ROLE.MANAGER,
      userField: 'creator_userid',
      allowPlatformRoles: new Set([PLATFORM_ROLE.SUPER_ADMIN, PLATFORM_ROLE.ADMIN]),
    },
    {
      role: TASK_TEAM_ROLE.EXECUTOR,
      userField: 'executor_userid',
      allowPlatformRoles: new Set([PLATFORM_ROLE.EXECUTOR]),
    },
  ];

  const result = {
    summaries: {
      manager: finalizeRoleMetricRecord(createRoleMetricRecord({ role: TASK_TEAM_ROLE.MANAGER })),
      executor: finalizeRoleMetricRecord(createRoleMetricRecord({ role: TASK_TEAM_ROLE.EXECUTOR })),
    },
    members: {
      manager: [],
      executor: [],
    },
    positions: {
      manager: [],
      executor: [],
    },
  };

  roleConfigs.forEach((roleConfig) => {
    const memberMap = new Map();
    const positionMap = new Map();
    const summaryRecord = createRoleMetricRecord({ role: roleConfig.role });

    taskRows.forEach((task) => {
      const userId = normalizeText(task && task[roleConfig.userField]);
      if (!userId) {
        return;
      }

      const userPlatformRole =
        normalizePlatformRole(platformRoleMap instanceof Map ? platformRoleMap.get(userId) : '') ||
        PLATFORM_ROLE.EXECUTOR;
      if (!roleConfig.allowPlatformRoles.has(userPlatformRole)) {
        return;
      }

      const directoryItem = userDirectoryIndex.get(userId) || {
        user_id: userId,
        user_name: userId,
        position: DEFAULT_POSITION_LABEL,
      };

      let memberRecord = memberMap.get(userId);
      if (!memberRecord) {
        memberRecord = createRoleMetricRecord({
          role: roleConfig.role,
          userId,
          userName: directoryItem.user_name,
          position: directoryItem.position,
        });
        memberMap.set(userId, memberRecord);
      }

      applyTaskToMetricRecord(memberRecord, task, now);

      const positionKey = normalizeText(directoryItem.position) || DEFAULT_POSITION_LABEL;
      let positionRecord = positionMap.get(positionKey);
      if (!positionRecord) {
        positionRecord = createRoleMetricRecord({
          role: roleConfig.role,
          position: positionKey,
        });
        positionMap.set(positionKey, positionRecord);
      }

      applyTaskToMetricRecord(positionRecord, task, now);
      positionRecord._member_ids.add(userId);
      positionRecord.member_count = positionRecord._member_ids.size;

      applyTaskToMetricRecord(summaryRecord, task, now);
      summaryRecord._member_ids.add(userId);
      summaryRecord.member_count = summaryRecord._member_ids.size;
    });

    const finalizedMembers = Array.from(memberMap.values())
      .map((item) => finalizeRoleMetricRecord(item))
      .sort(compareRoleMetricRecord);
    const finalizedPositions = Array.from(positionMap.values())
      .map((item) => finalizeRoleMetricRecord(item))
      .sort(compareRoleMetricRecord);
    const finalizedSummary = finalizeRoleMetricRecord(summaryRecord);

    if (roleConfig.role === TASK_TEAM_ROLE.MANAGER) {
      result.members.manager = finalizedMembers;
      result.positions.manager = finalizedPositions;
      result.summaries.manager = finalizedSummary;
      return;
    }

    result.members.executor = finalizedMembers;
    result.positions.executor = finalizedPositions;
    result.summaries.executor = finalizedSummary;
  });

  return result;
};

module.exports = {
  TASK_STATUS,
  REMINDER_KIND,
  TASK_TEAM_ROLE,
  normalizeText,
  parseGlobalVerifiers,
  normalizeActionKey,
  canUserCompleteTask,
  canUserVerifyTask,
  getReminderKind,
  shouldSendReminder,
  isTaskOverdue,
  isTaskDueSoon,
  isTaskCompletedOnTime,
  mapTaskRowToApi,
  buildTaskKpi,
  buildTaskTeamStats,
};
