const express = require('express');
const router = express.Router();
const db = require('../models/db');
const wecom = require('../services/wecom');
const jwt = require('jsonwebtoken');
const syncService = require('../services/sync');
const { taskService, TaskOperationError } = require('../services/task');
const { parseGlobalVerifiers, mapTaskRowToApi, buildTaskKpi, normalizeText } = require('../services/task-lifecycle');
const { resolveAuthLoginMode, buildAuthLoginRedirectUrl } = require('../services/auth-login-url');
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
  const keyword = normalizeText(req.query.keyword);

  const whereClauses = [];
  const params = [];

  const currentUserId = normalizeText(req.user && req.user.userid);
  if (currentUserId) {
    whereClauses.push('(owner_userid = ? OR executor_userid = ? OR creator_userid = ?)');
    params.push(currentUserId, currentUserId, currentUserId);
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

    const globalVerifiers = parseGlobalVerifiers(process.env.GLOBAL_VERIFIERS || '');
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
    const scopedRows = currentUserId
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

module.exports = router;
