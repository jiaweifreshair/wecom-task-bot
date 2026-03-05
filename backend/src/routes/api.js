const express = require('express');
const router = express.Router();
const db = require('../models/db');
const wecom = require('../services/wecom');
const jwt = require('jsonwebtoken');
const syncService = require('../services/sync');
const { taskService, TaskOperationError } = require('../services/task');
const { parseGlobalVerifiers, mapTaskRowToApi, buildTaskKpi, normalizeText } = require('../services/task-lifecycle');
const { resolveTaskQueryScope } = require('../services/task-scope');
const { resolveAuthLoginMode, buildAuthLoginRedirectUrl } = require('../services/auth-login-url');
const { userCalendarService } = require('../services/user-calendar');
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

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      logWithTrace(traceId, 'api', 'auth.jwt.reject', {
        reason: 'invalid_token',
        message: err.message,
        path: req.originalUrl,
        method: req.method,
      });
      return res.sendStatus(403);
    }

    req.user = user;
    logWithTrace(traceId, 'api', 'auth.jwt.pass', {
      userid: user.userid,
      path: req.originalUrl,
      method: req.method,
    });

    next();
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

router.get('/tasks', authenticateToken, async (req, res) => {
  const traceId = req.traceId || createTraceId();

  const statusFilter = normalizeText(req.query.status).toUpperCase();
  const requestedScope = normalizeText(req.query.scope).toUpperCase();
  const keyword = normalizeText(req.query.keyword);

  const whereClauses = [];
  const params = [];

  const currentUserId = normalizeText(req.user && req.user.userid);
  const globalVerifiers = parseGlobalVerifiers(process.env.GLOBAL_VERIFIERS || '');
  const taskScope = resolveTaskQueryScope({
    currentUserId,
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

    const taskList = rows.map((row) =>
      mapTaskRowToApi(row, {
        now: new Date(),
        currentUserId: req.user && req.user.userid,
        globalVerifiers,
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
      keyword,
    });

    res.json({
      tasks: taskList,
      kpi,
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

router.get('/tasks/kpi', authenticateToken, async (req, res) => {
  const traceId = req.traceId || createTraceId();

  try {
    const rows = await allSql(`SELECT * FROM tasks`);
    const currentUserId = normalizeText(req.user && req.user.userid);
    const requestedScope = normalizeText(req.query.scope).toUpperCase();
    const globalVerifiers = parseGlobalVerifiers(process.env.GLOBAL_VERIFIERS || '');
    const taskScope = resolveTaskQueryScope({
      currentUserId,
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

router.post(
  '/tasks/:id/complete',
  authenticateToken,
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
      'web_api'
    );

    res.json({
      code: isApproved ? 'TASK_VERIFY_PASS_SUCCESS' : 'TASK_VERIFY_REJECT_SUCCESS',
      message: result.message,
      task: result.task,
    });
  })
);

router.post('/tasks/sync', authenticateToken, async (req, res) => {
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
});

router.post(
  '/tasks',
  authenticateToken,
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

  res.json(req.user);
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

    res.status(500).json({
      code: 'USER_LIST_ERROR',
      message: '组织成员获取失败',
    });
  }
});

router.get('/users/:id', authenticateToken, async (req, res) => {
  const traceId = req.traceId || createTraceId();
  const targetUserId = normalizeText(req.params.id);

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

router.get('/tasks/:id', authenticateToken, async (req, res) => {
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
    if (
      currentUserId &&
      normalizeText(task.owner_userid) !== currentUserId &&
      normalizeText(task.executor_userid) !== currentUserId &&
      normalizeText(task.creator_userid) !== currentUserId
    ) {
      return res.status(404).json({
        code: 'TASK_NOT_FOUND',
        message: '任务不存在',
      });
    }

    const mappedTask = mapTaskRowToApi(task, {
      now: new Date(),
      currentUserId,
      globalVerifiers,
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

router.get('/calendar/mappings', authenticateToken, async (req, res) => {
  const traceId = req.traceId || createTraceId();

  try {
    const rows = await allSql(
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

router.post('/calendar/ensure', authenticateToken, async (req, res) => {
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

  try {
    const result = await userCalendarService.ensureUserCalendarForUser({
      userId,
      userName,
      source,
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

router.post('/calendar/create', authenticateToken, async (req, res) => {
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
});

router.post('/calendar/get', authenticateToken, async (req, res) => {
  const traceId = req.traceId || createTraceId();
  const calIdList = parseIdList(req.body && req.body.cal_id_list);

  if (calIdList.length === 0) {
    return res.status(400).json({
      code: 'CALENDAR_ID_LIST_REQUIRED',
      message: 'cal_id_list 不能为空',
    });
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

router.put('/calendar/:calId', authenticateToken, async (req, res) => {
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
});

router.delete('/calendar/:calId', authenticateToken, async (req, res) => {
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
});

router.get('/calendar/:calId/schedules', authenticateToken, async (req, res) => {
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

  try {
    const result = await wecom.getScheduleList(calId, offset, limit);
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
});

router.post('/schedule/create', authenticateToken, async (req, res) => {
  const traceId = req.traceId || createTraceId();

  try {
    const schedule = req.body && req.body.schedule && typeof req.body.schedule === 'object'
      ? req.body.schedule
      : req.body || {};
    const result = await wecom.createSchedule(schedule);
    res.status(result && result.errcode === 0 ? 200 : 400).json(result || {});
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

router.post('/schedule/get', authenticateToken, async (req, res) => {
  const traceId = req.traceId || createTraceId();
  const scheduleIdList = parseIdList(req.body && req.body.schedule_id_list);

  if (scheduleIdList.length === 0) {
    return res.status(400).json({
      code: 'SCHEDULE_ID_LIST_REQUIRED',
      message: 'schedule_id_list 不能为空',
    });
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

router.put('/schedule/:scheduleId', authenticateToken, async (req, res) => {
  const traceId = req.traceId || createTraceId();
  const scheduleId = normalizeText(req.params.scheduleId);

  if (!scheduleId) {
    return res.status(400).json({
      code: 'SCHEDULE_ID_REQUIRED',
      message: 'schedule_id 不能为空',
    });
  }

  try {
    const schedulePayload = {
      ...(req.body && req.body.schedule && typeof req.body.schedule === 'object' ? req.body.schedule : {}),
      schedule_id: scheduleId,
    };
    const result = await wecom.updateSchedule(schedulePayload, {
      skip_attendees: req.body && req.body.skip_attendees,
      op_mode: req.body && req.body.op_mode,
      op_start_time: req.body && req.body.op_start_time,
    });
    res.status(result && result.errcode === 0 ? 200 : 400).json(result || {});
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
});

router.delete('/schedule/:scheduleId', authenticateToken, async (req, res) => {
  const traceId = req.traceId || createTraceId();
  const scheduleId = normalizeText(req.params.scheduleId);

  if (!scheduleId) {
    return res.status(400).json({
      code: 'SCHEDULE_ID_REQUIRED',
      message: 'schedule_id 不能为空',
    });
  }

  try {
    const result = await wecom.cancelSchedule(scheduleId, {
      op_mode: req.body && req.body.op_mode,
      op_start_time: req.body && req.body.op_start_time,
    });
    res.status(result && result.errcode === 0 ? 200 : 400).json(result || {});
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
});

router.post('/schedule/:scheduleId/attendees/add', authenticateToken, async (req, res) => {
  const traceId = req.traceId || createTraceId();
  const scheduleId = normalizeText(req.params.scheduleId);
  const attendees = Array.isArray(req.body && req.body.attendees) ? req.body.attendees : [];

  if (!scheduleId) {
    return res.status(400).json({
      code: 'SCHEDULE_ID_REQUIRED',
      message: 'schedule_id 不能为空',
    });
  }

  try {
    const result = await wecom.addScheduleAttendees(scheduleId, attendees);
    res.status(result && result.errcode === 0 ? 200 : 400).json(result || {});
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
});

router.post('/schedule/:scheduleId/attendees/del', authenticateToken, async (req, res) => {
  const traceId = req.traceId || createTraceId();
  const scheduleId = normalizeText(req.params.scheduleId);
  const attendees = Array.isArray(req.body && req.body.attendees) ? req.body.attendees : [];

  if (!scheduleId) {
    return res.status(400).json({
      code: 'SCHEDULE_ID_REQUIRED',
      message: 'schedule_id 不能为空',
    });
  }

  try {
    const result = await wecom.removeScheduleAttendees(scheduleId, attendees);
    res.status(result && result.errcode === 0 ? 200 : 400).json(result || {});
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
});

module.exports = router;
