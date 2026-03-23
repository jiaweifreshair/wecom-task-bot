const express = require('express');
const router = express.Router();
const db = require('../models/db');
const wecom = require('../services/wecom');
const jwt = require('jsonwebtoken');
const syncService = require('../services/sync');
const { taskService, TaskOperationError } = require('../services/task');
const {
  parseGlobalVerifiers,
  mapTaskRowToApi,
  buildTaskKpi,
  buildTaskTeamStats,
  normalizeText,
} = require('../services/task-lifecycle');
const { resolveTaskQueryScope } = require('../services/task-scope');
const { resolveAuthLoginMode, buildAuthLoginRedirectUrl } = require('../services/auth-login-url');
const { userCalendarService } = require('../services/user-calendar');
const {
  PLATFORM_ROLE,
  PLATFORM_MENU,
  normalizePlatformRole,
  normalizeMenuPermissionList,
  isAdminRole,
  getEffectivePlatformAccess,
  upsertPlatformAccessRow,
  updatePlatformMenuPermissions,
  parseBootstrapSuperAdminIds,
  buildMenuPermissionsByRole,
  resolvePlatformRoleMap,
} = require('../services/platform-access');
const {
  pullAllContactsToLocalSnapshot,
  listSystemUsers,
  listSystemDepartments,
} = require('../services/contact-directory');
const { logWithTrace, createTraceId } = require('../utils/logger');

const JWT_SECRET = process.env.JWT_SECRET || 'wecom-task-bot-secret';

const authenticateToken = (req, res, next) => {
  const traceId = req.traceId || createTraceId();
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    logWithTrace(traceId, 'api', 'auth.jwt.reject', {
      reason: 'missing_token',
      path: req.originalUrl,
      method: req.method,
    });
    return res.sendStatus(401);
  }

  jwt.verify(token, JWT_SECRET, async (err, user) => {
    if (err) {
      logWithTrace(traceId, 'api', 'auth.jwt.reject', {
        reason: 'invalid_token',
        message: err.message,
        path: req.originalUrl,
        method: req.method,
      });
      return res.sendStatus(403);
    }

    try {
      const access = await getEffectivePlatformAccess(user && user.userid);
      const tokenPlatformRole = normalizePlatformRole(
        (user && user.platform_role) || (normalizeText(user && user.role).toUpperCase() === 'MANAGER' ? 'ADMIN' : '')
      );
      const effectivePlatformRole =
        access.source === 'default_executor' && tokenPlatformRole ? tokenPlatformRole : access.platform_role;
      const effectiveIsAdmin = isAdminRole(effectivePlatformRole);
      const effectiveMenuPermissions =
        effectivePlatformRole === access.platform_role
          ? access.menu_permissions
          : buildMenuPermissionsByRole(effectivePlatformRole);
      req.user = {
        ...user,
        platform_role: effectivePlatformRole,
        role: effectiveIsAdmin ? 'MANAGER' : 'EXECUTOR',
        is_super_admin: effectivePlatformRole === PLATFORM_ROLE.SUPER_ADMIN,
        is_admin: effectiveIsAdmin,
        menu_permissions: effectiveMenuPermissions,
      };

      logWithTrace(traceId, 'api', 'auth.jwt.pass', {
        userid: user.userid,
        platformRole: effectivePlatformRole,
        path: req.originalUrl,
        method: req.method,
      });

      next();
    } catch (accessError) {
      logWithTrace(traceId, 'api', 'auth.jwt.access_error', {
        userid: user && user.userid,
        message: accessError.message,
        path: req.originalUrl,
        method: req.method,
      });
      res.sendStatus(500);
    }
  });
};

// requireAdmin
// 是什么：管理员权限校验中间件。
// 做什么：仅允许平台管理员和超级管理员访问目标接口。
// 为什么：任务管理、团队统计和系统设置均属于管理能力，不应对执行对象开放。
const requireAdmin = (req, res, next) => {
  if (req.user && req.user.is_admin) {
    next();
    return;
  }

  res.status(403).json({
    code: 'ADMIN_PERMISSION_REQUIRED',
    message: '当前用户缺少管理员权限',
  });
};

// requireSuperAdmin
// 是什么：超级管理员校验中间件。
// 做什么：仅允许超级管理员修改平台角色分配。
// 为什么：平台权限和菜单控制属于系统级能力，需由超级管理员统一维护。
const requireSuperAdmin = (req, res, next) => {
  if (req.user && req.user.is_super_admin) {
    next();
    return;
  }

  res.status(403).json({
    code: 'SUPER_ADMIN_PERMISSION_REQUIRED',
    message: '当前用户缺少超级管理员权限',
  });
};

// hasMenuPermission
// 是什么：菜单权限判定函数。
// 做什么：判断当前登录用户是否拥有指定菜单键对应的访问权限。
// 为什么：平台已支持按用户裁剪菜单，后端接口也必须复用同一套权限口径。
const hasMenuPermission = (user = {}, menuPermission) => {
  const normalizedMenuPermission = normalizeText(menuPermission).toUpperCase();
  if (!normalizedMenuPermission) {
    return false;
  }

  const resolvedPlatformRole =
    normalizePlatformRole(user && user.platform_role) ||
    (user && user.is_super_admin
      ? PLATFORM_ROLE.SUPER_ADMIN
      : user && user.is_admin
      ? PLATFORM_ROLE.ADMIN
      : PLATFORM_ROLE.EXECUTOR);
  const menuPermissions =
    Array.isArray(user && user.menu_permissions) && user.menu_permissions.length > 0
      ? user.menu_permissions
      : buildMenuPermissionsByRole(resolvedPlatformRole);

  return menuPermissions
    .map((item) => normalizeText(item).toUpperCase())
    .includes(normalizedMenuPermission);
};

// requireMenuPermission
// 是什么：菜单权限校验中间件工厂函数。
// 做什么：仅允许拥有指定菜单键的用户访问目标接口。
// 为什么：若只在前端隐藏菜单，仍会留下直接调接口越权的空间，必须在服务端同步收口。
const requireMenuPermission = (menuPermission) => {
  const normalizedMenuPermission = normalizeText(menuPermission).toUpperCase();

  return (req, res, next) => {
    if (hasMenuPermission(req.user, normalizedMenuPermission)) {
      next();
      return;
    }

    res.status(403).json({
      code: 'MENU_PERMISSION_REQUIRED',
      message: '当前用户缺少目标菜单权限',
      menu_permission: normalizedMenuPermission,
    });
  };
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

// parseContactDepartmentIds
// 是什么：通讯录成员部门列表解析函数。
// 做什么：兼容 JSON 数组、逗号分隔字符串和单值输入，统一输出正整数部门 ID 列表。
// 为什么：本地通讯录快照来源可能跨版本演进，回退查询必须兼容历史字段形态。
const parseContactDepartmentIds = (value) => {
  if (Array.isArray(value)) {
    return Array.from(
      new Set(
        value
          .map((item) => Number(item))
          .filter((item) => Number.isInteger(item) && item > 0)
      )
    );
  }

  const normalized = normalizeText(value);
  if (!normalized) {
    return [];
  }

  try {
    const parsed = JSON.parse(normalized);
    if (Array.isArray(parsed)) {
      return parseContactDepartmentIds(parsed);
    }
  } catch (error) {
    // ignore json parse error
  }

  return Array.from(
    new Set(
      normalized
        .split(',')
        .map((item) => Number(item))
        .filter((item) => Number.isInteger(item) && item > 0)
    )
  );
};

// buildContactDepartmentScope
// 是什么：本地通讯录部门范围解析函数。
// 做什么：基于请求部门与本地部门树，计算“当前部门 + 子部门”的可匹配范围。
// 为什么：本地缓存回退时也要尽量保持与企微 `fetch_child` 查询一致的过滤语义。
const buildContactDepartmentScope = async (departmentId, fetchChild) => {
  const targetDepartmentId = Number(departmentId || 0);
  if (!Number.isInteger(targetDepartmentId) || targetDepartmentId <= 0) {
    return new Set();
  }

  if (!fetchChild) {
    return new Set([targetDepartmentId]);
  }

  const rows = await allSql(
    `SELECT department_id, parent_department_id
       FROM wecom_contact_departments`
  );

  if (!Array.isArray(rows) || rows.length === 0) {
    return targetDepartmentId === 1 ? new Set() : new Set([targetDepartmentId]);
  }

  const childMap = new Map();
  rows.forEach((row) => {
    const departmentRowId = Number(row && row.department_id);
    const parentDepartmentId = Number(row && row.parent_department_id);
    if (!Number.isInteger(departmentRowId) || departmentRowId <= 0) {
      return;
    }

    if (!Number.isInteger(parentDepartmentId) || parentDepartmentId <= 0) {
      return;
    }

    const children = childMap.get(parentDepartmentId) || [];
    children.push(departmentRowId);
    childMap.set(parentDepartmentId, children);
  });

  const scope = new Set([targetDepartmentId]);
  if (targetDepartmentId === 1) {
    rows.forEach((row) => {
      const departmentRowId = Number(row && row.department_id);
      if (Number.isInteger(departmentRowId) && departmentRowId > 0) {
        scope.add(departmentRowId);
      }
    });
  }

  const queue = [targetDepartmentId];
  while (queue.length > 0) {
    const currentDepartmentId = queue.shift();
    const children = childMap.get(currentDepartmentId) || [];
    children.forEach((childDepartmentId) => {
      if (scope.has(childDepartmentId)) {
        return;
      }

      scope.add(childDepartmentId);
      queue.push(childDepartmentId);
    });
  }

  return scope;
};

// listLocalContactUsers
// 是什么：本地通讯录快照读取函数。
// 做什么：从 `wecom_contact_users` 中读取成员，并按部门范围与成员状态过滤后返回前端所需结构。
// 为什么：当企微实时通讯录接口网络异常时，页面仍需要可用候选列表支撑排期操作。
const listLocalContactUsers = async ({ departmentId, fetchChild, status }) => {
  const statusFilter = Number(status || 0);
  const departmentScope = await buildContactDepartmentScope(departmentId, fetchChild);
  const rows = await allSql(
    `SELECT user_id, name, position, mobile, email, alias, status, main_department, department_ids_json
       FROM wecom_contact_users`
  );

  return rows
    .filter((row) => {
      const rowStatus = Number(row && row.status);
      if (Number.isInteger(statusFilter) && statusFilter > 0 && rowStatus !== statusFilter) {
        return false;
      }

      if (departmentScope.size === 0) {
        return true;
      }

      const departmentIds = new Set(parseContactDepartmentIds(row && row.department_ids_json));
      const mainDepartmentId = Number(row && row.main_department);
      if (Number.isInteger(mainDepartmentId) && mainDepartmentId > 0) {
        departmentIds.add(mainDepartmentId);
      }

      if (departmentIds.size === 0) {
        return false;
      }

      return Array.from(departmentIds).some((item) => departmentScope.has(item));
    })
    .map((row) => {
      const department = parseContactDepartmentIds(row && row.department_ids_json);
      const normalizedStatus = Number(row && row.status);

      return {
        userid: normalizeText(row && row.user_id),
        name: normalizeText(row && row.name),
        position: normalizeText(row && row.position),
        mobile: normalizeText(row && row.mobile),
        email: normalizeText(row && row.email),
        alias: normalizeText(row && row.alias),
        status: Number.isInteger(normalizedStatus) ? normalizedStatus : undefined,
        department,
      };
    })
    .filter((row) => row.userid)
    .sort((left, right) => {
      const leftName = String(left.name || left.userid || '');
      const rightName = String(right.name || right.userid || '');
      return leftName.localeCompare(rightName, 'zh-Hans-CN');
    });
};

// parseIdList
// 是什么：ID 列表解析函数。
// 做什么：兼容数组、逗号分隔字符串输入并输出去空去重结果。
// 为什么：前端管理页与脚本调用格式可能不一致，需要统一在网关层归一化。
const parseIdList = (value) => {
  if (Array.isArray(value)) {
    return Array.from(new Set(value.map((item) => normalizeText(item)).filter(Boolean)));
  }

  const normalized = normalizeText(value);
  if (!normalized) {
    return [];
  }

  return Array.from(
    new Set(
      normalized
        .split(',')
        .map((item) => normalizeText(item))
        .filter(Boolean)
    )
  );
};

// upsertUserCalendarMapping
// 是什么：用户日历映射写入函数。
// 做什么：以 `user_id` 为主键写入或更新 `cal_id/source/summary` 映射。
// 为什么：日历管理页创建日历后，需要立刻将日历与账号绑定，形成后续查询闭环。
const upsertUserCalendarMapping = async (input = {}) => {
  const userId = normalizeText(input.user_id);
  const calId = normalizeText(input.cal_id);
  const source = normalizeText(input.source) || 'manual_bind';
  const calendarSummary = normalizeText(input.calendar_summary);

  if (!userId || !calId) {
    return null;
  }

  await runSql(
    `INSERT INTO user_calendar_map (
      user_id,
      cal_id,
      calendar_summary,
      source,
      updated_at
    ) VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      cal_id = excluded.cal_id,
      calendar_summary = excluded.calendar_summary,
      source = excluded.source,
      updated_at = datetime('now')`,
    [userId, calId, calendarSummary, source]
  );

  return getSql(
    `SELECT user_id, cal_id, calendar_summary, source, created_at, updated_at FROM user_calendar_map WHERE user_id = ? LIMIT 1`,
    [userId]
  );
};

// parsePositiveInteger
// 是什么：正整数解析函数。
// 做什么：将输入解析为正整数，非法时回退默认值并按上限截断。
// 为什么：分页参数来自 URL 查询字符串，必须在入参边界处统一校验。
const parsePositiveInteger = (value, fallbackValue, maxValue) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallbackValue;
  }

  const normalized = Math.floor(parsed);
  if (!Number.isFinite(maxValue) || maxValue <= 0) {
    return normalized;
  }

  return Math.min(normalized, maxValue);
};

// buildApiUserProfile
// 是什么：登录用户接口返回模型构建函数。
// 做什么：把鉴权上下文整理为前端可直接消费的身份与菜单权限结构。
// 为什么：前端菜单和页面权限必须依赖同一份后端鉴权结果，而不是自行推断。
const buildApiUserProfile = (user = {}) => {
  const platformRole = normalizePlatformRole(user && user.platform_role) || PLATFORM_ROLE.EXECUTOR;

  return {
    userid: normalizeText(user && user.userid),
    name: normalizeText(user && user.name),
    avatar: normalizeText(user && user.avatar),
    role: normalizeText(user && user.role) || (isAdminRole(platformRole) ? 'MANAGER' : 'EXECUTOR'),
    platform_role: platformRole,
    is_admin: Boolean(user && user.is_admin),
    is_super_admin: Boolean(user && user.is_super_admin),
    menu_permissions: Array.isArray(user && user.menu_permissions)
      ? user.menu_permissions
      : buildMenuPermissionsByRole(platformRole),
  };
};

// canUserAccessTaskRow
// 是什么：任务行可见性判断函数。
// 做什么：管理员默认可见全部任务，执行对象仅可见与自己相关的任务。
// 为什么：任务列表、详情和统计必须复用同一可见性口径，避免权限漂移。
const canUserAccessTaskRow = (task, user = {}) => {
  if (user && user.is_admin) {
    return true;
  }

  const currentUserId = normalizeText(user && user.userid);
  if (!currentUserId) {
    return false;
  }

  return (
    normalizeText(task && task.owner_userid) === currentUserId ||
    normalizeText(task && task.executor_userid) === currentUserId ||
    normalizeText(task && task.creator_userid) === currentUserId
  );
};

// getUserCalendarMappingRow
// 是什么：用户日历映射读取函数。
// 做什么：按 user_id 获取当前用户绑定的个人日历信息。
// 为什么：执行对象访问日历相关接口时，必须限定在自己的个人日历范围内。
const getUserCalendarMappingRow = async (userId) => {
  const normalizedUserId = normalizeText(userId);
  if (!normalizedUserId) {
    return null;
  }

  return getSql(
    `SELECT user_id, cal_id, calendar_summary, source, created_at, updated_at
       FROM user_calendar_map
      WHERE user_id = ?
      LIMIT 1`,
    [normalizedUserId]
  );
};

// extractScheduleCalId
// 是什么：日程归属日历提取函数。
// 做什么：从企微日程对象中兼容读取 `cal_id/calendar_id`。
// 为什么：不同接口返回字段命名不完全一致，权限判断不能依赖单一字段。
const extractScheduleCalId = (schedule = {}) => {
  return normalizeText((schedule && schedule.cal_id) || (schedule && schedule.calendar_id));
};

// extractScheduleOwnerUserId
// 是什么：日程创建人账号提取函数。
// 做什么：从企微日程结构中兼容读取 `organizer.userid` 或扁平 `organizer` 字段。
// 为什么：成员编辑权限取决于“是否由自己创建”，需要稳定拿到组织者账号。
const extractScheduleOwnerUserId = (schedule = {}) => {
  return normalizeText((schedule && schedule.organizer && schedule.organizer.userid) || (schedule && schedule.organizer));
};

// extractScheduleAttendeeUserIds
// 是什么：日程参与人账号提取函数。
// 做什么：从 `attendees` 数组中提取并去重全部内部成员账号。
// 为什么：执行对象只应看到与自己相关的日程，必须基于参与人列表做判断。
const extractScheduleAttendeeUserIds = (schedule = {}) => {
  const attendees = Array.isArray(schedule && schedule.attendees) ? schedule.attendees : [];
  return Array.from(
    new Set(
      attendees
        .map((item) => normalizeText((item && item.userid) || item))
        .filter(Boolean)
    )
  );
};

// canUserViewSchedule
// 是什么：日程查看权限判定函数。
// 做什么：管理员默认放行，普通成员仅允许查看自己创建或自己参与执行的日程。
// 为什么：成员日历不应暴露与自己无关的排期，但仍需要看到上级分配给自己的执行事项。
const canUserViewSchedule = (user = {}, schedule = {}) => {
  const platformRole = normalizePlatformRole(user && user.platform_role);
  if (!platformRole || (user && user.is_admin)) {
    return true;
  }

  const currentUserId = normalizeText(user && user.userid);
  if (!currentUserId) {
    return false;
  }

  if (extractScheduleOwnerUserId(schedule) === currentUserId) {
    return true;
  }

  return extractScheduleAttendeeUserIds(schedule).includes(currentUserId);
};

// canUserMutateSchedule
// 是什么：日程编辑权限判定函数。
// 做什么：管理员默认放行，普通成员仅允许修改或删除自己创建的日程。
// 为什么：被分配执行不代表可改排期，避免成员误删或改动他人创建的工作安排。
const canUserMutateSchedule = (user = {}, schedule = {}) => {
  const platformRole = normalizePlatformRole(user && user.platform_role);
  if (!platformRole || (user && user.is_admin)) {
    return true;
  }

  const currentUserId = normalizeText(user && user.userid);
  if (!currentUserId) {
    return false;
  }

  return extractScheduleOwnerUserId(schedule) === currentUserId;
};

// validateScheduleTimeRange
// 是什么：日程时间区间校验函数。
// 做什么：校验开始/结束时间是否同时提供且满足“结束严格晚于开始”。
// 为什么：前端校验可被绕过，接口层必须阻止非法时间区间进入企微和本地任务链路。
const validateScheduleTimeRange = (schedule = {}, options = {}) => {
  const requireBoth = Boolean(options && options.requireBoth);
  const hasStartTime = Object.prototype.hasOwnProperty.call(schedule || {}, 'start_time');
  const hasEndTime = Object.prototype.hasOwnProperty.call(schedule || {}, 'end_time');

  if (!hasStartTime && !hasEndTime) {
    return requireBoth
      ? {
          valid: false,
          message: '开始时间和结束时间必须同时提供。',
        }
      : {
          valid: true,
          message: '',
        };
  }

  if (!hasStartTime || !hasEndTime) {
    return {
      valid: false,
      message: '开始时间和结束时间必须同时提供。',
    };
  }

  const startTime = Number(schedule.start_time);
  const endTime = Number(schedule.end_time);
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime <= 0 || endTime <= 0) {
    return {
      valid: false,
      message: '开始时间和结束时间必须为有效的秒级时间戳。',
    };
  }

  if (endTime <= startTime) {
    return {
      valid: false,
      message: '结束时间必须晚于开始时间。',
    };
  }

  return {
    valid: true,
    message: '',
  };
};

// ensureCalendarScopeAllowed
// 是什么：日历访问范围校验函数。
// 做什么：管理员直接放行，执行对象仅允许访问自己绑定的日历。
// 为什么：执行对象虽然可使用日历功能，但不应查看或操作他人的个人日历。
const ensureCalendarScopeAllowed = async (req, res, targetCalId) => {
  const hasResolvedPlatformRole = Boolean(normalizePlatformRole(req.user && req.user.platform_role));
  if (!hasResolvedPlatformRole || (req.user && req.user.is_admin)) {
    return true;
  }

  const normalizedTargetCalId = normalizeText(targetCalId);
  const currentUserMapping = await getUserCalendarMappingRow(req.user && req.user.userid);
  const allowedCalId = normalizeText(currentUserMapping && currentUserMapping.cal_id);

  if (normalizedTargetCalId && allowedCalId && normalizedTargetCalId === allowedCalId) {
    return true;
  }

  res.status(403).json({
    code: 'CALENDAR_SCOPE_FORBIDDEN',
    message: '执行对象仅可访问自己的日历',
  });
  return false;
};

// ensureScheduleScopeAllowed
// 是什么：日程访问范围校验函数。
// 做什么：管理员直接放行，执行对象则通过日程详情反查所属日历后校验范围。
// 为什么：日程更新/删除接口只带 `schedule_id`，必须先解析其归属日历再做授权。
const ensureScheduleScopeAllowed = async (req, res, scheduleId) => {
  const hasResolvedPlatformRole = Boolean(normalizePlatformRole(req.user && req.user.platform_role));
  if (!hasResolvedPlatformRole || (req.user && req.user.is_admin)) {
    return true;
  }

  const result = await wecom.getSchedule(scheduleId);
  const scheduleCalId = extractScheduleCalId(result && result.schedule);

  if (!scheduleCalId) {
    res.status(404).json({
      code: 'SCHEDULE_NOT_FOUND',
      message: '未找到对应日程',
    });
    return false;
  }

  return ensureCalendarScopeAllowed(req, res, scheduleCalId);
};

// loadScheduleForPermissionCheck
// 是什么：日程详情权限校验前置加载函数。
// 做什么：按 `schedule_id` 拉取详情并统一处理“未找到日程”的响应分支。
// 为什么：查看权限和编辑权限都依赖同一份日程详情，集中封装可避免重复错误处理。
const loadScheduleForPermissionCheck = async (res, scheduleId) => {
  const result = await wecom.getSchedule(scheduleId);
  const schedule = result && result.schedule;
  const scheduleCalId = extractScheduleCalId(schedule);

  if (!scheduleCalId) {
    res.status(404).json({
      code: 'SCHEDULE_NOT_FOUND',
      message: '未找到对应日程',
    });
    return null;
  }

  return schedule;
};

// ensureScheduleReadAllowed
// 是什么：日程查看权限校验函数。
// 做什么：先校验日历范围，再限制普通成员只能读取自己相关的日程。
// 为什么：执行对象即使能访问个人日历接口，也不应读取与自己无关的他人日程详情。
const ensureScheduleReadAllowed = async (req, res, scheduleId) => {
  const schedule = await loadScheduleForPermissionCheck(res, scheduleId);
  if (!schedule) {
    return null;
  }

  if (!(await ensureCalendarScopeAllowed(req, res, extractScheduleCalId(schedule)))) {
    return null;
  }

  if (!canUserViewSchedule(req.user, schedule)) {
    res.status(403).json({
      code: 'SCHEDULE_READ_FORBIDDEN',
      message: '仅可查看与自己相关的日程',
    });
    return null;
  }

  return schedule;
};

// ensureScheduleMutationAllowed
// 是什么：日程编辑权限校验函数。
// 做什么：先校验日历范围，再限制普通成员只能改动自己创建的日程。
// 为什么：成员能看到上级安排的执行事项，但不能直接修改或删除他人创建的日程。
const ensureScheduleMutationAllowed = async (req, res, scheduleId) => {
  const schedule = await loadScheduleForPermissionCheck(res, scheduleId);
  if (!schedule) {
    return null;
  }

  if (!(await ensureCalendarScopeAllowed(req, res, extractScheduleCalId(schedule)))) {
    return null;
  }

  if (!canUserMutateSchedule(req.user, schedule)) {
    res.status(403).json({
      code: 'SCHEDULE_MUTATION_FORBIDDEN',
      message: '仅可编辑或删除自己创建的日程',
    });
    return null;
  }

  return schedule;
};

// pickFirstForwardedValue
// 是什么：转发头首值提取函数。
// 做什么：从 `x-forwarded-*` 逗号列表中取第一个值并清洗空白。
// 为什么：网关链路可能追加多跳值，回调域名应以首跳入口为准。
const pickFirstForwardedValue = (value) => {
  const normalized = normalizeText(value);
  if (!normalized) {
    return '';
  }

  return normalizeText(normalized.split(',')[0]);
};

// removeTrailingSlash
// 是什么：URL 尾斜杠清理函数。
// 做什么：移除 URL 结尾连续 `/`，避免后续路径拼接出现双斜杠。
// 为什么：回调地址需稳定输出，减少 `redirect_uri` 比对差异。
const removeTrailingSlash = (value) => {
  return normalizeText(value).replace(/\/+$/, '');
};

// resolveAuthCallbackBaseUrl
// 是什么：登录回调基准域名解析函数。
// 做什么：按 `AUTH_CALLBACK_BASE_URL -> APP_URL -> 请求头域名 -> localhost` 依次回退。
// 为什么：优先使用固定域名配置，避免本地访问或代理头导致 `redirect_uri` 域名漂移。
const resolveAuthCallbackBaseUrl = (req) => {
  const envBaseUrl = removeTrailingSlash(process.env.AUTH_CALLBACK_BASE_URL);
  if (envBaseUrl) {
    return envBaseUrl;
  }

  const appUrl = removeTrailingSlash(process.env.APP_URL);
  if (appUrl) {
    return appUrl;
  }

  const forwardedProto = pickFirstForwardedValue(req.get('x-forwarded-proto'));
  const forwardedHost = pickFirstForwardedValue(req.get('x-forwarded-host'));
  const requestHost = normalizeText(forwardedHost || req.get('host'));
  const requestProtocol = normalizeText(forwardedProto || req.protocol || 'http').toLowerCase();

  if (requestHost) {
    const protocol = requestProtocol === 'https' ? 'https' : 'http';
    return `${protocol}://${requestHost}`;
  }

  return 'http://127.0.0.1';
};

const withTaskOperationHandler = (handler) => {
  return async (req, res) => {
    const traceId = req.traceId || createTraceId();

    try {
      await handler(req, res);
    } catch (error) {
      if (error instanceof TaskOperationError) {
        logWithTrace(traceId, 'api', 'tasks.operation.reject', {
          code: error.code,
          message: error.message,
          path: req.originalUrl,
          method: req.method,
          userid: req.user && req.user.userid,
        });

        return res.status(error.statusCode).json({
          code: error.code,
          message: error.message,
        });
      }

      logWithTrace(traceId, 'api', 'tasks.operation.error', {
        path: req.originalUrl,
        method: req.method,
        message: error.message,
        stack: error.stack,
      });

      res.status(500).json({
        code: 'TASK_OPERATION_ERROR',
        message: '任务操作失败',
      });
    }
  };
};

// buildFallbackSchedulePayload
// 是什么：日程联动回退载荷构建函数。
// 做什么：保留当前请求里显式提交的日程字段，并补上 `schedule_id` 供详情回拉失败时兜底同步。
// 为什么：回退同步应只携带“本次确实修改了什么”，其余字段交给已有任务快照补齐，避免误覆盖原参与人。
const buildFallbackSchedulePayload = (schedule = {}, scheduleId = '') => {
  const normalizedSchedule =
    schedule && typeof schedule === 'object'
      ? { ...schedule }
      : {};

  if (scheduleId) {
    normalizedSchedule.schedule_id = scheduleId;
  }

  return normalizedSchedule;
};

// syncTaskForScheduleMutation
// 是什么：日程变更后的任务同步包装函数。
// 做什么：调用任务服务做实时同步，并在异常时转为可序列化的 `task_sync` 结果返回前端。
// 为什么：日历操作已经生效后，不应因为本地任务联动失败而把整个接口判为失败。
const syncTaskForScheduleMutation = async (options = {}) => {
  const traceId = normalizeText(options.traceId) || createTraceId();
  const scheduleId = normalizeText(options.scheduleId);

  try {
    return await taskService.syncScheduleTaskById(scheduleId, {
      fallbackUserId: options.fallbackUserId,
      fallbackCalId: options.fallbackCalId,
      fallbackSchedule: options.fallbackSchedule,
    });
  } catch (error) {
    logWithTrace(traceId, 'api', 'schedule.task_sync.error', {
      scheduleId,
      fallbackUserId: options.fallbackUserId,
      fallbackCalId: options.fallbackCalId,
      message: error.message,
      stack: error.stack,
    });

    return {
      synced: false,
      reason: 'task_sync_failed',
      message: error.message,
    };
  }
};

// deleteTaskForScheduleCancellation
// 是什么：取消日程后的任务删除包装函数。
// 做什么：删除同一 `schedule_id` 对应任务，并把异常转换为可读状态返回。
// 为什么：取消日程已成功后，接口应优先返回取消结果，再附带说明任务联动是否成功。
const deleteTaskForScheduleCancellation = async (options = {}) => {
  const traceId = normalizeText(options.traceId) || createTraceId();
  const scheduleId = normalizeText(options.scheduleId);

  try {
    return await taskService.deleteTaskByScheduleId(scheduleId);
  } catch (error) {
    logWithTrace(traceId, 'api', 'schedule.task_delete.error', {
      scheduleId,
      message: error.message,
      stack: error.stack,
    });

    return {
      deleted: false,
      reason: 'task_delete_failed',
      message: error.message,
    };
  }
};

router.get('/tasks', authenticateToken, requireMenuPermission(PLATFORM_MENU.TASKS), async (req, res) => {
  const traceId = req.traceId || createTraceId();

  const statusFilter = normalizeText(req.query.status).toUpperCase();
  const requestedScope = normalizeText(req.query.scope).toUpperCase();
  const keyword = normalizeText(req.query.keyword);
  const page = parsePositiveInteger(req.query.page, 1, Number.MAX_SAFE_INTEGER);
  const pageSize = parsePositiveInteger(req.query.page_size, 20, 100);
  const paginationRequested = Boolean(
    normalizeText(req.query.page) || normalizeText(req.query.page_size)
  );

  const whereClauses = [];
  const params = [];

  const currentUserId = normalizeText(req.user && req.user.userid);
  const globalVerifiers = parseGlobalVerifiers(process.env.GLOBAL_VERIFIERS || '');
  const taskScope = resolveTaskQueryScope({
    currentUserId,
    currentUserPlatformRole: req.user && req.user.platform_role,
    globalVerifiers,
    requestedScope,
  });

  if (taskScope.restrictToCurrentUser) {
    if (!currentUserId) {
      whereClauses.push('1 = 0');
    } else {
      whereClauses.push('(owner_userid = ? OR executor_userid = ? OR creator_userid = ?)');
      params.push(currentUserId, currentUserId, currentUserId);
    }
  }

  if (statusFilter) {
    whereClauses.push('status = ?');
    params.push(statusFilter);
  }

  if (keyword) {
    whereClauses.push('(title LIKE ? OR description LIKE ? OR creator_userid LIKE ? OR executor_userid LIKE ?)');
    params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
  }

  const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

  try {
    const rows = await allSql(
      `SELECT * FROM tasks ${whereSql} ORDER BY datetime(created_at) DESC, id DESC`,
      params
    );
    const total = rows.length;
    const pagedRows = paginationRequested
      ? rows.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize)
      : rows;

    const taskList = pagedRows.map((row) =>
      mapTaskRowToApi(row, {
        now: new Date(),
        currentUserId: req.user && req.user.userid,
        globalVerifiers,
        currentUserPlatformRole: req.user && req.user.platform_role,
      })
    );
    const kpi = buildTaskKpi(rows, new Date());

    logWithTrace(traceId, 'api', 'tasks.query.success', {
      userid: req.user && req.user.userid,
      count: taskList.length,
      statusFilter,
      requestedScope,
      resolvedScope: taskScope.resolvedScope,
      restrictToCurrentUser: taskScope.restrictToCurrentUser,
      userIsGlobalVerifier: taskScope.userIsGlobalVerifier,
      currentUserIsAdmin: taskScope.currentUserIsAdmin,
      keyword,
      page: paginationRequested ? page : undefined,
      pageSize: paginationRequested ? pageSize : undefined,
    });

    res.json({
      tasks: taskList,
      kpi,
      pagination: paginationRequested
        ? {
            page,
            page_size: pageSize,
            total,
            total_pages: total > 0 ? Math.ceil(total / pageSize) : 1,
          }
        : undefined,
    });
  } catch (error) {
    logWithTrace(traceId, 'api', 'tasks.query.error', {
      message: error.message,
      stack: error.stack,
      statusFilter,
      keyword,
    });

    res.status(500).json({ error: error.message });
  }
});

router.get('/tasks/kpi', authenticateToken, requireMenuPermission(PLATFORM_MENU.DASHBOARD), async (req, res) => {
  const traceId = req.traceId || createTraceId();

  try {
    const rows = await allSql(`SELECT * FROM tasks`);
    const currentUserId = normalizeText(req.user && req.user.userid);
    const requestedScope = normalizeText(req.query.scope).toUpperCase();
    const globalVerifiers = parseGlobalVerifiers(process.env.GLOBAL_VERIFIERS || '');
    const taskScope = resolveTaskQueryScope({
      currentUserId,
      currentUserPlatformRole: req.user && req.user.platform_role,
      globalVerifiers,
      requestedScope,
    });
    const scopedRows = taskScope.restrictToCurrentUser
      ? rows.filter(
          (item) =>
            normalizeText(item.owner_userid) === currentUserId ||
            normalizeText(item.executor_userid) === currentUserId ||
            normalizeText(item.creator_userid) === currentUserId
        )
      : rows;
    const kpi = buildTaskKpi(scopedRows, new Date());

    logWithTrace(traceId, 'api', 'tasks.kpi.success', {
      userid: req.user && req.user.userid,
      totalTasks: kpi.total_tasks,
      requestedScope,
      resolvedScope: taskScope.resolvedScope,
      restrictToCurrentUser: taskScope.restrictToCurrentUser,
      userIsGlobalVerifier: taskScope.userIsGlobalVerifier,
      currentUserIsAdmin: taskScope.currentUserIsAdmin,
    });

    res.json({ kpi });
  } catch (error) {
    logWithTrace(traceId, 'api', 'tasks.kpi.error', {
      message: error.message,
      stack: error.stack,
    });

    res.status(500).json({
      code: 'TASK_KPI_ERROR',
      message: '获取任务 KPI 失败',
    });
  }
});

router.get(
  '/tasks/team-stats',
  authenticateToken,
  requireMenuPermission(PLATFORM_MENU.TEAM_STATS),
  requireAdmin,
  async (req, res) => {
  const traceId = req.traceId || createTraceId();

  try {
    const now = new Date();
    const rows = await allSql(`SELECT * FROM tasks`);
    const contactRows = await allSql(
      `SELECT user_id, name, position
       FROM wecom_contact_users`
    );
    const currentUserId = normalizeText(req.user && req.user.userid);
    const requestedScope = normalizeText(req.query.scope).toUpperCase();
    const globalVerifiers = parseGlobalVerifiers(process.env.GLOBAL_VERIFIERS || '');
    const taskScope = resolveTaskQueryScope({
      currentUserId,
      currentUserPlatformRole: req.user && req.user.platform_role,
      globalVerifiers,
      requestedScope,
    });
    const scopedRows = taskScope.restrictToCurrentUser
      ? rows.filter(
          (item) =>
            normalizeText(item.owner_userid) === currentUserId ||
            normalizeText(item.executor_userid) === currentUserId ||
            normalizeText(item.creator_userid) === currentUserId
        )
      : rows;
    const roleMap = await resolvePlatformRoleMap(
      scopedRows.flatMap((item) => [item && item.creator_userid, item && item.executor_userid])
    );
    const teamStats = buildTaskTeamStats(scopedRows, contactRows, now, roleMap);

    logWithTrace(traceId, 'api', 'tasks.team_stats.success', {
      userid: req.user && req.user.userid,
      requestedScope,
      resolvedScope: taskScope.resolvedScope,
      restrictToCurrentUser: taskScope.restrictToCurrentUser,
      userIsGlobalVerifier: taskScope.userIsGlobalVerifier,
      currentUserIsAdmin: taskScope.currentUserIsAdmin,
      managerMemberCount: teamStats.summaries.manager.member_count,
      executorMemberCount: teamStats.summaries.executor.member_count,
    });

    res.json({
      team_stats: teamStats,
    });
  } catch (error) {
    logWithTrace(traceId, 'api', 'tasks.team_stats.error', {
      message: error.message,
      stack: error.stack,
    });

    res.status(500).json({
      code: 'TASK_TEAM_STATS_ERROR',
      message: '获取团队统计失败',
    });
  }
  }
);

router.post(
  '/tasks/:id/complete',
  authenticateToken,
  requireMenuPermission(PLATFORM_MENU.TASKS),
  withTaskOperationHandler(async (req, res) => {
    const taskId = Number(req.params.id);
    const result = await taskService.completeTaskById(taskId, req.user.userid, 'web_api');

    res.json({
      code: 'TASK_COMPLETE_SUCCESS',
      message: result.message,
      task: result.task,
    });
  })
);

router.post(
  '/tasks/:id/verify',
  authenticateToken,
  requireMenuPermission(PLATFORM_MENU.TASKS),
  withTaskOperationHandler(async (req, res) => {
    const taskId = Number(req.params.id);
    const action = normalizeText(req.body && req.body.action).toUpperCase();
    const rejectReason = normalizeText(req.body && req.body.reject_reason);

    if (action !== 'PASS' && action !== 'REJECT') {
      return res.status(400).json({
        code: 'TASK_VERIFY_ACTION_INVALID',
        message: 'action 仅支持 PASS 或 REJECT',
      });
    }

    const isApproved = action === 'PASS';
    const result = await taskService.verifyTaskById(
      taskId,
      req.user.userid,
      isApproved,
      rejectReason,
      'web_api',
      {
        currentUserPlatformRole: req.user && req.user.platform_role,
      }
    );

    res.json({
      code: isApproved ? 'TASK_VERIFY_PASS_SUCCESS' : 'TASK_VERIFY_REJECT_SUCCESS',
      message: result.message,
      task: result.task,
    });
  })
);

router.post(
  '/tasks/sync',
  authenticateToken,
  requireMenuPermission(PLATFORM_MENU.SETTINGS),
  requireAdmin,
  async (req, res) => {
  const traceId = req.traceId || createTraceId();

  try {
    const syncResult = await syncService.syncSchedules();

    logWithTrace(traceId, 'api', 'tasks.sync.success', {
      userid: req.user && req.user.userid,
      syncResult,
    });

    res.json({
      code: 'TASK_SYNC_TRIGGERED',
      result: syncResult,
    });
  } catch (error) {
    logWithTrace(traceId, 'api', 'tasks.sync.error', {
      userid: req.user && req.user.userid,
      message: error.message,
      stack: error.stack,
    });

    res.status(500).json({
      code: 'TASK_SYNC_ERROR',
      message: '手动触发同步失败',
    });
  }
  }
);

router.post(
  '/tasks',
  authenticateToken,
  requireMenuPermission(PLATFORM_MENU.TASKS),
  requireAdmin,
  withTaskOperationHandler(async (req, res) => {
    const traceId = req.traceId || createTraceId();
    const payload = {
      title: req.body && req.body.title,
      description: req.body && req.body.description,
      executor_userid: req.body && req.body.executor_userid,
      start_time: req.body && req.body.start_time,
      end_time: req.body && req.body.end_time,
    };

    const result = await taskService.createManualTask(payload, req.user.userid, 'web_api');

    logWithTrace(traceId, 'api', 'tasks.create.success', {
      creator: req.user && req.user.userid,
      taskId: result.task && result.task.id,
      executor: result.task && result.task.executor_userid,
    });

    res.status(201).json({
      code: 'TASK_CREATE_SUCCESS',
      message: result.message,
      task: result.task,
    });
  })
);

router.get('/auth/login', (req, res) => {
  const traceId = req.traceId || createTraceId();

  // authLoginMode
  // 是什么：登录入口模式参数。
  // 做什么：支持 `mode=qr|oauth|auto`，用于覆盖环境变量的默认登录策略。
  // 为什么：便于在同一环境下针对不同终端快速切换登录方式。
  const authLoginMode = normalizeText(req.query && req.query.mode);

  // authLoginState
  // 是什么：登录状态透传参数。
  // 做什么：可从 query 指定 `state` 并在回调后做关联校验（缺省由服务端兜底）。
  // 为什么：预留多入口登录场景的状态追踪能力，避免硬编码状态值。
  const authLoginState = normalizeText(req.query && req.query.state);

  const callbackBaseUrl = resolveAuthCallbackBaseUrl(req);
  const redirectUri = `${callbackBaseUrl}/api/auth/callback`;
  const loginMode = resolveAuthLoginMode({
    queryMode: authLoginMode,
    envMode: process.env.AUTH_LOGIN_MODE || 'AUTO',
    userAgent: req.headers['user-agent'] || '',
  });
  const url = buildAuthLoginRedirectUrl({
    mode: loginMode,
    corpId: process.env.CORP_ID,
    agentId: process.env.AGENT_ID,
    redirectUri,
    state: authLoginState,
  });

  logWithTrace(traceId, 'api', 'auth.login.redirect', {
    mode: loginMode,
    callbackBaseUrl,
    redirectUri,
    loginUrl: url,
  });

  res.redirect(url);
});

router.get('/auth/callback', async (req, res) => {
  const traceId = req.traceId || createTraceId();
  const { code } = req.query;
  if (!code) {
    logWithTrace(traceId, 'api', 'auth.callback.reject', {
      reason: 'missing_code',
      query: req.query,
    });
    return res.status(400).send('No code provided');
  }

  try {
    const userInfo = await wecom.getUserInfoByCode(code);
    if (userInfo.errcode !== 0) {
      throw new Error(userInfo.errmsg);
    }

    const userId = userInfo.UserId;
    const userDetail = await wecom.getUser(userId);

    if (userDetail.errcode !== 0) {
      throw new Error(userDetail.errmsg);
    }

    try {
      const ensureCalendarResult = await userCalendarService.ensureUserCalendarForUser({
        userId,
        userName: userDetail.name,
        source: 'auth_callback',
        traceId,
      });

      logWithTrace(traceId, 'api', 'auth.callback.user_calendar.ensure', {
        userId,
        ensureCalendarResult,
      });
    } catch (calendarError) {
      logWithTrace(traceId, 'api', 'auth.callback.user_calendar.ensure_error', {
        userId,
        message: calendarError.message,
      });
    }

    const token = jwt.sign(
      {
        userid: userId,
        name: userDetail.name,
        avatar: userDetail.avatar,
      },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    const redirectTarget = `${
      process.env.FRONTEND_URL || process.env.APP_URL || 'http://127.0.0.1'
    }?token=${token}`;

    logWithTrace(traceId, 'api', 'auth.callback.success', {
      userId,
      redirectTarget,
    });

    res.redirect(redirectTarget);
  } catch (error) {
    logWithTrace(traceId, 'api', 'auth.callback.error', {
      message: error.message,
      stack: error.stack,
    });
    res.status(500).send('Authentication Failed');
  }
});

router.get('/user/me', authenticateToken, (req, res) => {
  const traceId = req.traceId || createTraceId();

  logWithTrace(traceId, 'api', 'user.me.success', {
    userid: req.user && req.user.userid,
    name: req.user && req.user.name,
  });

  res.json(buildApiUserProfile(req.user));
});

router.get('/users', authenticateToken, async (req, res) => {
  const traceId = req.traceId || createTraceId();
  const departmentId = parsePositiveInteger(req.query && req.query.department_id, 1, Number.MAX_SAFE_INTEGER);
  const fetchChild = parsePositiveInteger(req.query && req.query.fetch_child, 1, 1);
  const status = parsePositiveInteger(req.query && req.query.status, 0, Number.MAX_SAFE_INTEGER);

  try {
    const result = await wecom.listUsersByDepartment(departmentId, fetchChild, status);
    // usersListGatewayStatus
    // 是什么：组织成员网关 HTTP 状态策略。
    // 做什么：统一返回 200，并通过 `errcode/errmsg` 让前端感知权限或 IP 受限状态。
    // 为什么：成员接口常见受限返回（如 60011/60020/48009）属于可预期业务态，不应触发浏览器资源加载错误。
    res.status(200).json(result || {});
  } catch (error) {
    logWithTrace(traceId, 'api', 'users.list.error', {
      departmentId,
      fetchChild,
      status,
      message: error.message,
      stack: error.stack,
    });

    try {
      const fallbackUsers = await listLocalContactUsers({
        departmentId,
        fetchChild,
        status,
      });

      if (fallbackUsers.length > 0) {
        logWithTrace(traceId, 'api', 'users.list.local_cache_fallback', {
          departmentId,
          fetchChild,
          status,
          userCount: fallbackUsers.length,
        });

        return res.status(200).json({
          errcode: 0,
          errmsg: 'ok',
          userlist: fallbackUsers,
          degraded: true,
          source: 'local_cache',
          degrade_reason: 'wecom_user_list_unavailable',
        });
      }
    } catch (fallbackError) {
      logWithTrace(traceId, 'api', 'users.list.local_cache_error', {
        departmentId,
        fetchChild,
        status,
        message: fallbackError.message,
        stack: fallbackError.stack,
      });
    }

    res.status(500).json({
      code: 'USER_LIST_ERROR',
      message: '组织成员获取失败',
    });
  }
});

router.get('/users/:id', authenticateToken, async (req, res) => {
  const traceId = req.traceId || createTraceId();
  const targetUserId = normalizeText(req.params.id);

  if (
    normalizePlatformRole(req.user && req.user.platform_role) &&
    !(req.user && req.user.is_admin) &&
    targetUserId !== normalizeText(req.user && req.user.userid)
  ) {
    return res.status(403).json({
      code: 'USER_DETAIL_FORBIDDEN',
      message: '执行对象仅可查看自己的成员信息',
    });
  }

  try {
    if (!targetUserId) {
      return res.status(400).json({
        code: 'USER_ID_INVALID',
        message: '用户ID不能为空',
      });
    }

    const user = await wecom.getUser(targetUserId);
    if (user.errcode !== 0) {
      return res.status(404).json({
        code: 'USER_NOT_FOUND',
        message: user.errmsg || '未找到用户',
      });
    }

    res.json(user);
  } catch (error) {
    logWithTrace(traceId, 'api', 'users.detail.error', {
      targetUserId,
      message: error.message,
      stack: error.stack,
    });

    res.status(500).json({
      code: 'USER_DETAIL_ERROR',
      message: '用户信息获取失败',
    });
  }
});

router.get(
  '/system/users',
  authenticateToken,
  requireMenuPermission(PLATFORM_MENU.SETTINGS),
  requireAdmin,
  async (req, res) => {
  const traceId = req.traceId || createTraceId();

  try {
    const result = await listSystemUsers({
      keyword: req.query && req.query.keyword,
      platformRole: req.query && req.query.platform_role,
      departmentId: req.query && req.query.department_id,
      fetchChild: req.query && req.query.fetch_child,
      page: req.query && req.query.page,
      pageSize: req.query && req.query.page_size,
    });

    logWithTrace(traceId, 'api', 'system.users.success', {
      userid: req.user && req.user.userid,
      page: result.pagination.page,
      pageSize: result.pagination.page_size,
      total: result.pagination.total,
    });

    res.json(result);
  } catch (error) {
    logWithTrace(traceId, 'api', 'system.users.error', {
      userid: req.user && req.user.userid,
      message: error.message,
      stack: error.stack,
    });

    res.status(500).json({
      code: 'SYSTEM_USERS_ERROR',
      message: '获取系统管理用户列表失败',
    });
  }
  }
);

router.get(
  '/system/departments',
  authenticateToken,
  requireMenuPermission(PLATFORM_MENU.SETTINGS),
  requireAdmin,
  async (req, res) => {
    const traceId = req.traceId || createTraceId();

    try {
      const departments = await listSystemDepartments();
      res.json({
        departments,
      });
    } catch (error) {
      logWithTrace(traceId, 'api', 'system.departments.error', {
        userid: req.user && req.user.userid,
        message: error.message,
        stack: error.stack,
      });

      res.status(500).json({
        code: 'SYSTEM_DEPARTMENTS_ERROR',
        message: '获取系统管理部门列表失败',
      });
    }
  }
);

router.post(
  '/system/contacts/pull',
  authenticateToken,
  requireMenuPermission(PLATFORM_MENU.SETTINGS),
  requireAdmin,
  async (req, res) => {
  const traceId = req.traceId || createTraceId();

  try {
    const result = await pullAllContactsToLocalSnapshot();
    res.status(result && result.success ? 200 : 400).json(result);
  } catch (error) {
    logWithTrace(traceId, 'api', 'system.contacts.pull.error', {
      userid: req.user && req.user.userid,
      message: error.message,
      stack: error.stack,
    });

    res.status(500).json({
      code: 'SYSTEM_CONTACT_PULL_ERROR',
      message: '拉取通讯录失败',
    });
  }
  }
);

router.post(
  '/system/users/:id/role',
  authenticateToken,
  requireMenuPermission(PLATFORM_MENU.SETTINGS),
  requireSuperAdmin,
  async (req, res) => {
  const traceId = req.traceId || createTraceId();
  const targetUserId = normalizeText(req.params.id);
  const requestedRole = normalizePlatformRole(req.body && req.body.platform_role);
  const bootstrapSuperAdminIds = new Set(parseBootstrapSuperAdminIds());

  if (!targetUserId) {
    return res.status(400).json({
      code: 'SYSTEM_USER_ID_REQUIRED',
      message: '用户ID不能为空',
    });
  }

  if (!requestedRole || requestedRole === PLATFORM_ROLE.SUPER_ADMIN) {
    return res.status(400).json({
      code: 'SYSTEM_ROLE_INVALID',
      message: '仅支持分配 ADMIN 或 EXECUTOR',
    });
  }

  if (bootstrapSuperAdminIds.has(targetUserId)) {
    return res.status(400).json({
      code: 'SYSTEM_BOOTSTRAP_SUPER_ADMIN_IMMUTABLE',
      message: '引导型超级管理员不可在页面中降权',
    });
  }

  try {
    const access = await upsertPlatformAccessRow({
      userId: targetUserId,
      platformRole: requestedRole,
      updatedByUserId: req.user && req.user.userid,
    });

    res.json({
      access,
    });
  } catch (error) {
    logWithTrace(traceId, 'api', 'system.users.role.error', {
      userid: req.user && req.user.userid,
      targetUserId,
      requestedRole,
      message: error.message,
      stack: error.stack,
    });

    res.status(500).json({
      code: 'SYSTEM_ROLE_UPDATE_ERROR',
      message: '更新平台角色失败',
    });
  }
  }
);

router.post(
  '/system/users/:id/menu-permissions',
  authenticateToken,
  requireMenuPermission(PLATFORM_MENU.SETTINGS),
  requireSuperAdmin,
  async (req, res) => {
    const traceId = req.traceId || createTraceId();
    const targetUserId = normalizeText(req.params.id);
    const bootstrapSuperAdminIds = new Set(parseBootstrapSuperAdminIds());
    const requestedMenuPermissions = normalizeMenuPermissionList(req.body && req.body.menu_permissions);

    if (!targetUserId) {
      return res.status(400).json({
        code: 'SYSTEM_USER_ID_REQUIRED',
        message: '用户ID不能为空',
      });
    }

    if (bootstrapSuperAdminIds.has(targetUserId)) {
      return res.status(400).json({
        code: 'SYSTEM_BOOTSTRAP_SUPER_ADMIN_IMMUTABLE',
        message: '引导型超级管理员不可在页面中调整菜单权限',
      });
    }

    if (requestedMenuPermissions.length === 0) {
      return res.status(400).json({
        code: 'SYSTEM_MENU_PERMISSIONS_INVALID',
        message: '请至少保留一个菜单权限',
      });
    }

    try {
      const currentAccess = await getEffectivePlatformAccess(targetUserId);

      if (currentAccess.platform_role !== PLATFORM_ROLE.ADMIN || currentAccess.is_super_admin) {
        return res.status(400).json({
          code: 'SYSTEM_MENU_PERMISSIONS_ROLE_INVALID',
          message: '仅普通管理员支持自定义菜单权限',
        });
      }

      const access = await updatePlatformMenuPermissions({
        userId: targetUserId,
        menuPermissions: requestedMenuPermissions,
        updatedByUserId: req.user && req.user.userid,
      });

      if (!access) {
        return res.status(400).json({
          code: 'SYSTEM_MENU_PERMISSIONS_UPDATE_REJECTED',
          message: '菜单权限更新被拒绝',
        });
      }

      res.json({
        access,
      });
    } catch (error) {
      logWithTrace(traceId, 'api', 'system.users.menu_permissions.error', {
        userid: req.user && req.user.userid,
        targetUserId,
        requestedMenuPermissions,
        message: error.message,
        stack: error.stack,
      });

      res.status(500).json({
        code: 'SYSTEM_MENU_PERMISSIONS_UPDATE_ERROR',
        message: '更新菜单权限失败',
      });
    }
  }
);

router.get('/tasks/:id', authenticateToken, requireMenuPermission(PLATFORM_MENU.TASKS), async (req, res) => {
  const traceId = req.traceId || createTraceId();
  const taskId = Number(req.params.id);

  try {
    const task = await getSql(`SELECT * FROM tasks WHERE id = ?`, [taskId]);
    if (!task) {
      return res.status(404).json({
        code: 'TASK_NOT_FOUND',
        message: '任务不存在',
      });
    }

    const globalVerifiers = parseGlobalVerifiers(process.env.GLOBAL_VERIFIERS || '');
    const currentUserId = normalizeText(req.user && req.user.userid);
    if (!canUserAccessTaskRow(task, req.user)) {
      return res.status(404).json({
        code: 'TASK_NOT_FOUND',
        message: '任务不存在',
      });
    }

    const mappedTask = mapTaskRowToApi(task, {
      now: new Date(),
      currentUserId,
      globalVerifiers,
      currentUserPlatformRole: req.user && req.user.platform_role,
    });

    logWithTrace(traceId, 'api', 'task.detail.success', {
      taskId,
      userid: req.user && req.user.userid,
    });

    res.json({ task: mappedTask });
  } catch (error) {
    logWithTrace(traceId, 'api', 'task.detail.error', {
      taskId,
      message: error.message,
      stack: error.stack,
    });

    res.status(500).json({
      code: 'TASK_DETAIL_ERROR',
      message: '任务详情获取失败',
    });
  }
});

router.get('/calendar/mappings', authenticateToken, requireMenuPermission(PLATFORM_MENU.CALENDAR), async (req, res) => {
  const traceId = req.traceId || createTraceId();

  try {
    const rows = normalizePlatformRole(req.user && req.user.platform_role) && !(req.user && req.user.is_admin)
      ? await allSql(
          `SELECT user_id, cal_id, calendar_summary, source, created_at, updated_at
             FROM user_calendar_map
            WHERE user_id = ?
            ORDER BY datetime(updated_at) DESC, user_id ASC`,
          [normalizeText(req.user && req.user.userid)]
        )
      : await allSql(
          `SELECT user_id, cal_id, calendar_summary, source, created_at, updated_at
             FROM user_calendar_map
             ORDER BY datetime(updated_at) DESC, user_id ASC`
        );

    res.json({
      mappings: rows || [],
    });
  } catch (error) {
    logWithTrace(traceId, 'api', 'calendar.mappings.error', {
      message: error.message,
      stack: error.stack,
    });

    res.status(500).json({
      code: 'CALENDAR_MAPPINGS_ERROR',
      message: '获取日历映射失败',
    });
  }
});

router.post('/calendar/ensure', authenticateToken, requireMenuPermission(PLATFORM_MENU.CALENDAR), async (req, res) => {
  const traceId = req.traceId || createTraceId();
  const userId = normalizeText(req.body && req.body.user_id) || normalizeText(req.user && req.user.userid);
  const userName = normalizeText(req.body && req.body.user_name) || normalizeText(req.user && req.user.name);
  const source = normalizeText(req.body && req.body.source) || 'calendar_manage_api';

  if (!userId) {
    return res.status(400).json({
      code: 'CALENDAR_ENSURE_USER_ID_REQUIRED',
      message: 'user_id 不能为空',
    });
  }

  if (
    normalizePlatformRole(req.user && req.user.platform_role) &&
    !(req.user && req.user.is_admin) &&
    userId !== normalizeText(req.user && req.user.userid)
  ) {
    return res.status(403).json({
      code: 'CALENDAR_ENSURE_FORBIDDEN',
      message: '执行对象仅可确保自己的个人日历',
    });
  }

  try {
    const result = await userCalendarService.ensureUserCalendarForUser({
      userId,
      userName,
      source,
      forceEnsure: true,
      traceId,
    });

    res.status(result && result.ensured ? 200 : 400).json(result || {});
  } catch (error) {
    logWithTrace(traceId, 'api', 'calendar.ensure.error', {
      userId,
      message: error.message,
      stack: error.stack,
    });

    res.status(500).json({
      code: 'CALENDAR_ENSURE_ERROR',
      message: '确保用户日历失败',
    });
  }
});

router.post(
  '/calendar/create',
  authenticateToken,
  requireMenuPermission(PLATFORM_MENU.CALENDAR),
  requireAdmin,
  async (req, res) => {
  const traceId = req.traceId || createTraceId();

  try {
    const payload = {
      calendar: req.body && req.body.calendar,
      summary: req.body && req.body.summary,
      color: req.body && req.body.color,
      description: req.body && req.body.description,
      agentid: req.body && req.body.agentid,
    };

    const createResult = await wecom.createCalendar(payload);
    if (!createResult || createResult.errcode !== 0) {
      return res.status(400).json(createResult || {});
    }

    const bindUserId = normalizeText(req.body && req.body.bind_user_id);
    const bindUserName = normalizeText(req.body && req.body.bind_user_name);
    const mappingSource = normalizeText(req.body && req.body.source) || 'calendar_manage_api';
    let mapping = null;

    if (bindUserId) {
      const calendarSummary = normalizeText(
        (req.body && req.body.calendar && req.body.calendar.summary) || bindUserName
      );

      mapping = await upsertUserCalendarMapping({
        user_id: bindUserId,
        cal_id: createResult.cal_id,
        calendar_summary: calendarSummary,
        source: mappingSource,
      });
    }

    res.status(201).json({
      ...createResult,
      mapping,
    });
  } catch (error) {
    logWithTrace(traceId, 'api', 'calendar.create.error', {
      message: error.message,
      stack: error.stack,
    });

    res.status(500).json({
      code: 'CALENDAR_CREATE_ERROR',
      message: '创建日历失败',
    });
  }
  }
);

router.post('/calendar/get', authenticateToken, requireMenuPermission(PLATFORM_MENU.CALENDAR), async (req, res) => {
  const traceId = req.traceId || createTraceId();
  const calIdList = parseIdList(req.body && req.body.cal_id_list);

  if (calIdList.length === 0) {
    return res.status(400).json({
      code: 'CALENDAR_ID_LIST_REQUIRED',
      message: 'cal_id_list 不能为空',
    });
  }

  if (normalizePlatformRole(req.user && req.user.platform_role) && !(req.user && req.user.is_admin)) {
    const currentUserMapping = await getUserCalendarMappingRow(req.user && req.user.userid);
    const allowedCalId = normalizeText(currentUserMapping && currentUserMapping.cal_id);

    if (!allowedCalId || calIdList.some((item) => normalizeText(item) !== allowedCalId)) {
      return res.status(403).json({
        code: 'CALENDAR_GET_FORBIDDEN',
        message: '执行对象仅可查看自己的日历',
      });
    }
  }

  try {
    const result = await wecom.getCalendarByIds(calIdList);
    res.status(result && result.errcode === 0 ? 200 : 400).json(result || {});
  } catch (error) {
    logWithTrace(traceId, 'api', 'calendar.get.error', {
      calIdList,
      message: error.message,
      stack: error.stack,
    });

    res.status(500).json({
      code: 'CALENDAR_GET_ERROR',
      message: '获取日历详情失败',
    });
  }
});

router.put(
  '/calendar/:calId',
  authenticateToken,
  requireMenuPermission(PLATFORM_MENU.CALENDAR),
  requireAdmin,
  async (req, res) => {
  const traceId = req.traceId || createTraceId();
  const calId = normalizeText(req.params.calId);

  if (!calId) {
    return res.status(400).json({
      code: 'CALENDAR_ID_REQUIRED',
      message: 'cal_id 不能为空',
    });
  }

  try {
    const calendarPayload = {
      ...(req.body && req.body.calendar && typeof req.body.calendar === 'object' ? req.body.calendar : {}),
      cal_id: calId,
    };
    const result = await wecom.updateCalendar(calendarPayload, {
      skip_public_range: req.body && req.body.skip_public_range,
    });

    res.status(result && result.errcode === 0 ? 200 : 400).json(result || {});
  } catch (error) {
    logWithTrace(traceId, 'api', 'calendar.update.error', {
      calId,
      message: error.message,
      stack: error.stack,
    });

    res.status(500).json({
      code: 'CALENDAR_UPDATE_ERROR',
      message: '更新日历失败',
    });
  }
  }
);

router.delete(
  '/calendar/:calId',
  authenticateToken,
  requireMenuPermission(PLATFORM_MENU.CALENDAR),
  requireAdmin,
  async (req, res) => {
  const traceId = req.traceId || createTraceId();
  const calId = normalizeText(req.params.calId);

  if (!calId) {
    return res.status(400).json({
      code: 'CALENDAR_ID_REQUIRED',
      message: 'cal_id 不能为空',
    });
  }

  try {
    const result = await wecom.deleteCalendar(calId);
    if (result && result.errcode === 0) {
      await runSql(`DELETE FROM user_calendar_map WHERE cal_id = ?`, [calId]);
    }

    res.status(result && result.errcode === 0 ? 200 : 400).json(result || {});
  } catch (error) {
    logWithTrace(traceId, 'api', 'calendar.delete.error', {
      calId,
      message: error.message,
      stack: error.stack,
    });

    res.status(500).json({
      code: 'CALENDAR_DELETE_ERROR',
      message: '删除日历失败',
    });
  }
  }
);

router.get(
  '/calendar/:calId/schedules',
  authenticateToken,
  requireMenuPermission(PLATFORM_MENU.CALENDAR),
  async (req, res) => {
  const traceId = req.traceId || createTraceId();
  const calId = normalizeText(req.params.calId);
  const offset = parsePositiveInteger(req.query && req.query.offset, 0, Number.MAX_SAFE_INTEGER);
  const limit = parsePositiveInteger(req.query && req.query.limit, 500, 1000);

  if (!calId) {
    return res.status(400).json({
      code: 'CALENDAR_ID_REQUIRED',
      message: 'cal_id 不能为空',
    });
  }

  if (!(await ensureCalendarScopeAllowed(req, res, calId))) {
    return;
  }

  try {
    const result = await wecom.getScheduleList(calId, offset, limit);
    if (
      result &&
      result.errcode === 0 &&
      Array.isArray(result.schedule_list) &&
      normalizePlatformRole(req.user && req.user.platform_role) &&
      !(req.user && req.user.is_admin)
    ) {
      result.schedule_list = result.schedule_list.filter((item) => canUserViewSchedule(req.user, item));
    }
    res.status(result && result.errcode === 0 ? 200 : 400).json(result || {});
  } catch (error) {
    logWithTrace(traceId, 'api', 'calendar.schedules.error', {
      calId,
      offset,
      limit,
      message: error.message,
      stack: error.stack,
    });

    res.status(500).json({
      code: 'CALENDAR_SCHEDULE_LIST_ERROR',
      message: '获取日程列表失败',
    });
  }
  }
);

router.post('/schedule/create', authenticateToken, requireMenuPermission(PLATFORM_MENU.CALENDAR), async (req, res) => {
  const traceId = req.traceId || createTraceId();

  try {
    const schedule = req.body && req.body.schedule && typeof req.body.schedule === 'object'
      ? req.body.schedule
      : req.body || {};
    const scheduleCalId = extractScheduleCalId(schedule);
    const timeRangeValidation = validateScheduleTimeRange(schedule, { requireBoth: true });

    if (!(await ensureCalendarScopeAllowed(req, res, scheduleCalId))) {
      return;
    }
    if (!timeRangeValidation.valid) {
      return res.status(400).json({
        code: 'SCHEDULE_TIME_RANGE_INVALID',
        message: timeRangeValidation.message,
      });
    }
    const result = await wecom.createSchedule(schedule);
    const normalizedScheduleId = normalizeText(result && result.schedule_id);
    const taskSync =
      result && result.errcode === 0 && normalizedScheduleId
        ? await syncTaskForScheduleMutation({
            traceId,
            scheduleId: normalizedScheduleId,
            fallbackUserId: req.user && req.user.userid,
            fallbackCalId: schedule && schedule.cal_id,
            fallbackSchedule: buildFallbackSchedulePayload(schedule, normalizedScheduleId),
          })
        : {
            synced: false,
            reason: 'schedule_create_not_successful',
          };

    res.status(result && result.errcode === 0 ? 200 : 400).json({
      ...(result || {}),
      task_sync: taskSync,
    });
  } catch (error) {
    logWithTrace(traceId, 'api', 'schedule.create.error', {
      message: error.message,
      stack: error.stack,
    });

    res.status(500).json({
      code: 'SCHEDULE_CREATE_ERROR',
      message: '创建日程失败',
    });
  }
});

router.post('/schedule/get', authenticateToken, requireMenuPermission(PLATFORM_MENU.CALENDAR), async (req, res) => {
  const traceId = req.traceId || createTraceId();
  const scheduleIdList = parseIdList(req.body && req.body.schedule_id_list);

  if (scheduleIdList.length === 0) {
    return res.status(400).json({
      code: 'SCHEDULE_ID_LIST_REQUIRED',
      message: 'schedule_id_list 不能为空',
    });
  }

  if (normalizePlatformRole(req.user && req.user.platform_role) && !(req.user && req.user.is_admin)) {
    for (const scheduleId of scheduleIdList) {
      if (!(await ensureScheduleReadAllowed(req, res, scheduleId))) {
        return;
      }
    }
  }

  try {
    const result = await wecom.getSchedules(scheduleIdList);
    res.status(result && result.errcode === 0 ? 200 : 400).json(result || {});
  } catch (error) {
    logWithTrace(traceId, 'api', 'schedule.get.error', {
      scheduleIdList,
      message: error.message,
      stack: error.stack,
    });

    res.status(500).json({
      code: 'SCHEDULE_GET_ERROR',
      message: '获取日程详情失败',
    });
  }
});

router.put(
  '/schedule/:scheduleId',
  authenticateToken,
  requireMenuPermission(PLATFORM_MENU.CALENDAR),
  async (req, res) => {
  const traceId = req.traceId || createTraceId();
  const scheduleId = normalizeText(req.params.scheduleId);

  if (!scheduleId) {
    return res.status(400).json({
      code: 'SCHEDULE_ID_REQUIRED',
      message: 'schedule_id 不能为空',
    });
  }

  if (!(await ensureScheduleMutationAllowed(req, res, scheduleId))) {
    return;
  }

  try {
    const schedulePayload = {
      ...(req.body && req.body.schedule && typeof req.body.schedule === 'object' ? req.body.schedule : {}),
      schedule_id: scheduleId,
    };
    const timeRangeValidation = validateScheduleTimeRange(schedulePayload);
    if (!timeRangeValidation.valid) {
      return res.status(400).json({
        code: 'SCHEDULE_TIME_RANGE_INVALID',
        message: timeRangeValidation.message,
      });
    }
    const result = await wecom.updateSchedule(schedulePayload, {
      skip_attendees: req.body && req.body.skip_attendees,
      op_mode: req.body && req.body.op_mode,
      op_start_time: req.body && req.body.op_start_time,
    });
    const taskSync =
      result && result.errcode === 0
        ? await syncTaskForScheduleMutation({
            traceId,
            scheduleId,
            fallbackUserId: req.user && req.user.userid,
            fallbackCalId: schedulePayload.cal_id,
            fallbackSchedule: buildFallbackSchedulePayload(schedulePayload, scheduleId),
          })
        : {
            synced: false,
            reason: 'schedule_update_not_successful',
          };
    res.status(result && result.errcode === 0 ? 200 : 400).json({
      ...(result || {}),
      task_sync: taskSync,
    });
  } catch (error) {
    logWithTrace(traceId, 'api', 'schedule.update.error', {
      scheduleId,
      message: error.message,
      stack: error.stack,
    });

    res.status(500).json({
      code: 'SCHEDULE_UPDATE_ERROR',
      message: '更新日程失败',
    });
  }
  }
);

router.delete(
  '/schedule/:scheduleId',
  authenticateToken,
  requireMenuPermission(PLATFORM_MENU.CALENDAR),
  async (req, res) => {
  const traceId = req.traceId || createTraceId();
  const scheduleId = normalizeText(req.params.scheduleId);

  if (!scheduleId) {
    return res.status(400).json({
      code: 'SCHEDULE_ID_REQUIRED',
      message: 'schedule_id 不能为空',
    });
  }

  if (!(await ensureScheduleMutationAllowed(req, res, scheduleId))) {
    return;
  }

  try {
    const result = await wecom.cancelSchedule(scheduleId, {
      op_mode: req.body && req.body.op_mode,
      op_start_time: req.body && req.body.op_start_time,
    });
    const taskSync =
      result && result.errcode === 0
        ? await deleteTaskForScheduleCancellation({
            traceId,
            scheduleId,
          })
        : {
            deleted: false,
            reason: 'schedule_cancel_not_successful',
          };
    res.status(result && result.errcode === 0 ? 200 : 400).json({
      ...(result || {}),
      task_sync: taskSync,
    });
  } catch (error) {
    logWithTrace(traceId, 'api', 'schedule.cancel.error', {
      scheduleId,
      message: error.message,
      stack: error.stack,
    });

    res.status(500).json({
      code: 'SCHEDULE_CANCEL_ERROR',
      message: '取消日程失败',
    });
  }
  }
);

router.post(
  '/schedule/:scheduleId/attendees/add',
  authenticateToken,
  requireMenuPermission(PLATFORM_MENU.CALENDAR),
  async (req, res) => {
  const traceId = req.traceId || createTraceId();
  const scheduleId = normalizeText(req.params.scheduleId);
  const attendees = Array.isArray(req.body && req.body.attendees) ? req.body.attendees : [];

  if (!scheduleId) {
    return res.status(400).json({
      code: 'SCHEDULE_ID_REQUIRED',
      message: 'schedule_id 不能为空',
    });
  }

  if (!(await ensureScheduleMutationAllowed(req, res, scheduleId))) {
    return;
  }

  try {
    const result = await wecom.addScheduleAttendees(scheduleId, attendees);
    const taskSync =
      result && result.errcode === 0
        ? await syncTaskForScheduleMutation({
            traceId,
            scheduleId,
            fallbackUserId: req.user && req.user.userid,
          })
        : {
            synced: false,
            reason: 'schedule_add_attendees_not_successful',
          };
    res.status(result && result.errcode === 0 ? 200 : 400).json({
      ...(result || {}),
      task_sync: taskSync,
    });
  } catch (error) {
    logWithTrace(traceId, 'api', 'schedule.attendees.add.error', {
      scheduleId,
      attendeeCount: attendees.length,
      message: error.message,
      stack: error.stack,
    });

    res.status(500).json({
      code: 'SCHEDULE_ATTENDEES_ADD_ERROR',
      message: '新增日程参与者失败',
    });
  }
  }
);

router.post(
  '/schedule/:scheduleId/attendees/del',
  authenticateToken,
  requireMenuPermission(PLATFORM_MENU.CALENDAR),
  async (req, res) => {
  const traceId = req.traceId || createTraceId();
  const scheduleId = normalizeText(req.params.scheduleId);
  const attendees = Array.isArray(req.body && req.body.attendees) ? req.body.attendees : [];

  if (!scheduleId) {
    return res.status(400).json({
      code: 'SCHEDULE_ID_REQUIRED',
      message: 'schedule_id 不能为空',
    });
  }

  if (!(await ensureScheduleMutationAllowed(req, res, scheduleId))) {
    return;
  }

  try {
    const result = await wecom.removeScheduleAttendees(scheduleId, attendees);
    const taskSync =
      result && result.errcode === 0
        ? await syncTaskForScheduleMutation({
            traceId,
            scheduleId,
            fallbackUserId: req.user && req.user.userid,
          })
        : {
            synced: false,
            reason: 'schedule_remove_attendees_not_successful',
          };
    res.status(result && result.errcode === 0 ? 200 : 400).json({
      ...(result || {}),
      task_sync: taskSync,
    });
  } catch (error) {
    logWithTrace(traceId, 'api', 'schedule.attendees.remove.error', {
      scheduleId,
      attendeeCount: attendees.length,
      message: error.message,
      stack: error.stack,
    });

    res.status(500).json({
      code: 'SCHEDULE_ATTENDEES_REMOVE_ERROR',
      message: '删除日程参与者失败',
    });
  }
  }
);

module.exports = router;
