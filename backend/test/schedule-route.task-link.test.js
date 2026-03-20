const test = require('node:test');
const assert = require('node:assert/strict');

const apiRouter = require('../src/routes/api');
const db = require('../src/models/db');
const wecom = require('../src/services/wecom');

// runSql
// 是什么：日程路由联动测试数据库写操作辅助函数。
// 做什么：执行 SQLite 写语句并返回受影响行数。
// 为什么：这些路由的验收标准是“企微成功后任务表实时变化”，必须直查数据库确认。
const runSql = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(error) {
      if (error) {
        reject(error);
        return;
      }

      resolve({
        changes: this.changes || 0,
        lastID: this.lastID || 0,
      });
    });
  });
};

// getSql
// 是什么：日程路由联动测试单行查询辅助函数。
// 做什么：查询 SQLite 单条记录，未命中时返回 `null`。
// 为什么：用例需要验证某个 `schedule_id` 对应任务是否已插入、更新或删除。
const getSql = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(row || null);
    });
  });
};

// getRouteHandler
// 是什么：Express 路由处理器提取函数。
// 做什么：按 `path + method` 找到真实业务处理器，并跳过鉴权中间件直接调用。
// 为什么：项目未引入 supertest，这种方式能最小成本覆盖现有 API 路由逻辑。
const getRouteHandler = (path, method) => {
  const lowerMethod = String(method || '').toLowerCase();
  const layer = apiRouter.stack.find(
    (item) => item && item.route && item.route.path === path && item.route.methods && item.route.methods[lowerMethod]
  );

  assert.ok(layer, `未找到 ${lowerMethod.toUpperCase()} ${path} 路由`);
  assert.ok(layer.route.stack.length >= 2, `${lowerMethod.toUpperCase()} ${path} 路由缺少处理函数`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
};

// invokeJsonRoute
// 是什么：JSON 路由调用辅助函数。
// 做什么：以最小 mock `req/res` 直接触发路由处理器，并收集状态码和响应体。
// 为什么：测试目标是校验业务联动结果，而不是 Express 框架本身。
const invokeJsonRoute = async ({
  path,
  method,
  params = {},
  query = {},
  body = {},
  user = {
    userid: 'manager-route-user',
    name: '路由测试负责人',
  },
} = {}) => {
  const handler = getRouteHandler(path, method);
  const result = {
    statusCode: 200,
    body: null,
  };

  const req = {
    params,
    query,
    body,
    user,
    traceId: `trace-${String(method || 'get').toLowerCase()}-${path}`,
  };
  const res = {
    status(code) {
      result.statusCode = code;
      return this;
    },
    json(payload) {
      result.body = payload;
      return this;
    },
  };

  await handler(req, res);
  return result;
};

// resetTaskLinkTables
// 是什么：日程联动相关测试表清理函数。
// 做什么：清空任务表与用户日历映射表，确保每条用例独立执行。
// 为什么：路由联动依赖 `tasks` 与 `user_calendar_map` 两张表，残留数据会直接污染断言。
const resetTaskLinkTables = async () => {
  await runSql(`DELETE FROM tasks`);
  await runSql(`DELETE FROM user_calendar_map`);
};

test.beforeEach(async () => {
  await resetTaskLinkTables();
  await runSql(
    `INSERT INTO user_calendar_map (user_id, cal_id, calendar_summary, source, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))`,
    ['manager-route-user', 'cal-route-manager', '路由测试日历', 'route_test']
  );
});

test.after(async () => {
  await resetTaskLinkTables();
});

test('POST /schedule/create 成功后应立即写入任务表', async () => {
  const originalCreateSchedule = wecom.createSchedule;
  const originalGetSchedule = wecom.getSchedule;
  const originalSendTemplateCard = wecom.sendTemplateCard;

  wecom.createSchedule = async () => ({
    errcode: 0,
    errmsg: 'ok',
    schedule_id: 'sch-route-create',
  });
  wecom.getSchedule = async () => ({
    errcode: 0,
    errmsg: 'ok',
    schedule: {
      schedule_id: 'sch-route-create',
      cal_id: 'cal-route-manager',
      summary: '路由创建日程',
      description: '创建后应进入任务表',
      organizer: { userid: 'manager-route-user' },
      attendees: [{ userid: 'lisi' }],
      start_time: 1760000000,
      end_time: 1760003600,
    },
  });
  wecom.sendTemplateCard = async () => ({ errcode: 0, errmsg: 'ok' });

  try {
    const response = await invokeJsonRoute({
      path: '/schedule/create',
      method: 'post',
      body: {
        schedule: {
          cal_id: 'cal-route-manager',
          summary: '路由创建日程',
          description: '创建后应进入任务表',
          attendees: [{ userid: 'lisi' }],
          start_time: 1760000000,
          end_time: 1760003600,
        },
      },
    });

    const taskRow = await getSql(
      `SELECT title, creator_userid, executor_userid, owner_userid, owner_cal_id
       FROM tasks WHERE wecom_schedule_id = ?`,
      ['sch-route-create']
    );

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.errcode, 0);
    assert.equal(response.body.task_sync.synced, true);
    assert.equal(response.body.task_sync.inserted, true);
    assert.equal(taskRow.title, '路由创建日程');
    assert.equal(taskRow.creator_userid, 'manager-route-user');
    assert.equal(taskRow.executor_userid, 'lisi');
    assert.equal(taskRow.owner_userid, 'manager-route-user');
    assert.equal(taskRow.owner_cal_id, 'cal-route-manager');
  } finally {
    wecom.createSchedule = originalCreateSchedule;
    wecom.getSchedule = originalGetSchedule;
    wecom.sendTemplateCard = originalSendTemplateCard;
  }
});

test('PUT /schedule/:scheduleId 成功后应立即更新任务表字段', async () => {
  await runSql(
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
    ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now', '+1 hour'), ?, datetime('now'))`,
    [
      'sch-route-update',
      '旧标题',
      '旧描述',
      'manager-route-user',
      'lisi',
      'manager-route-user',
      'cal-route-manager',
      'PENDING',
    ]
  );

  const originalUpdateSchedule = wecom.updateSchedule;
  const originalGetSchedule = wecom.getSchedule;

  wecom.updateSchedule = async () => ({
    errcode: 0,
    errmsg: 'ok',
    schedule_id: 'sch-route-update',
  });
  wecom.getSchedule = async () => ({
    errcode: 0,
    errmsg: 'ok',
    schedule: {
      schedule_id: 'sch-route-update',
      cal_id: 'cal-route-manager',
      summary: '更新后标题',
      description: '更新后描述',
      organizer: { userid: 'manager-route-user' },
      attendees: [{ userid: 'wangwu' }],
      start_time: 1760100000,
      end_time: 1760107200,
    },
  });

  try {
    const response = await invokeJsonRoute({
      path: '/schedule/:scheduleId',
      method: 'put',
      params: {
        scheduleId: 'sch-route-update',
      },
      body: {
        schedule: {
          summary: '更新后标题',
          description: '更新后描述',
          attendees: [{ userid: 'wangwu' }],
          start_time: 1760100000,
          end_time: 1760107200,
        },
        skip_attendees: 0,
      },
    });

    const taskRow = await getSql(
      `SELECT title, description, executor_userid, owner_cal_id FROM tasks WHERE wecom_schedule_id = ?`,
      ['sch-route-update']
    );

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.errcode, 0);
    assert.equal(response.body.task_sync.synced, true);
    assert.equal(response.body.task_sync.updated, true);
    assert.equal(taskRow.title, '更新后标题');
    assert.equal(taskRow.description, '更新后描述');
    assert.equal(taskRow.executor_userid, 'wangwu');
    assert.equal(taskRow.owner_cal_id, 'cal-route-manager');
  } finally {
    wecom.updateSchedule = originalUpdateSchedule;
    wecom.getSchedule = originalGetSchedule;
  }
});

test('PUT /schedule/:scheduleId 在详情回拉失败且 skip_attendees=1 时应保留原执行人与时间', async () => {
  await runSql(
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
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    [
      'sch-route-fallback',
      '旧标题',
      '旧描述',
      'manager-route-user',
      'executor-a',
      'manager-route-user',
      'cal-route-manager',
      '2025-10-10 10:00:00',
      '2025-10-10 11:00:00',
      'PENDING',
    ]
  );

  const originalUpdateSchedule = wecom.updateSchedule;
  const originalGetSchedule = wecom.getSchedule;

  wecom.updateSchedule = async () => ({
    errcode: 0,
    errmsg: 'ok',
    schedule_id: 'sch-route-fallback',
  });
  wecom.getSchedule = async () => {
    throw new Error('temporary schedule detail unavailable');
  };

  try {
    const response = await invokeJsonRoute({
      path: '/schedule/:scheduleId',
      method: 'put',
      params: {
        scheduleId: 'sch-route-fallback',
      },
      body: {
        schedule: {
          summary: '仅更新标题',
          description: '仅更新描述',
        },
        skip_attendees: 1,
      },
      user: {
        userid: 'editor-user',
        name: '编辑人',
      },
    });

    const taskRow = await getSql(
      `SELECT
         title,
         description,
         creator_userid,
         executor_userid,
         owner_userid,
         owner_cal_id,
         start_time,
         end_time
       FROM tasks
       WHERE wecom_schedule_id = ?`,
      ['sch-route-fallback']
    );

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.errcode, 0);
    assert.equal(response.body.task_sync.synced, true);
    assert.equal(response.body.task_sync.updated, true);
    assert.equal(taskRow.title, '仅更新标题');
    assert.equal(taskRow.description, '仅更新描述');
    assert.equal(taskRow.creator_userid, 'manager-route-user');
    assert.equal(taskRow.executor_userid, 'executor-a');
    assert.equal(taskRow.owner_userid, 'manager-route-user');
    assert.equal(taskRow.owner_cal_id, 'cal-route-manager');
    assert.equal(taskRow.start_time, '2025-10-10 10:00:00');
    assert.equal(taskRow.end_time, '2025-10-10 11:00:00');
  } finally {
    wecom.updateSchedule = originalUpdateSchedule;
    wecom.getSchedule = originalGetSchedule;
  }
});

test('POST /schedule/:scheduleId/attendees/add 成功后应立即同步任务执行人', async () => {
  await runSql(
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
    ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now', '+1 hour'), ?, datetime('now'))`,
    [
      'sch-route-attendees',
      '参与人同步测试',
      '初始执行人为负责人本人',
      'manager-route-user',
      'manager-route-user',
      'manager-route-user',
      'cal-route-manager',
      'PENDING',
    ]
  );

  const originalAddScheduleAttendees = wecom.addScheduleAttendees;
  const originalGetSchedule = wecom.getSchedule;

  wecom.addScheduleAttendees = async () => ({
    errcode: 0,
    errmsg: 'ok',
  });
  wecom.getSchedule = async () => ({
    errcode: 0,
    errmsg: 'ok',
    schedule: {
      schedule_id: 'sch-route-attendees',
      cal_id: 'cal-route-manager',
      summary: '参与人同步测试',
      description: '加人后应把任务执行人切到首位参与人',
      organizer: { userid: 'manager-route-user' },
      attendees: [{ userid: 'lisi' }],
      start_time: 1760200000,
      end_time: 1760203600,
    },
  });

  try {
    const response = await invokeJsonRoute({
      path: '/schedule/:scheduleId/attendees/add',
      method: 'post',
      params: {
        scheduleId: 'sch-route-attendees',
      },
      body: {
        attendees: [{ userid: 'lisi' }],
      },
    });

    const taskRow = await getSql(
      `SELECT executor_userid FROM tasks WHERE wecom_schedule_id = ?`,
      ['sch-route-attendees']
    );

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.errcode, 0);
    assert.equal(response.body.task_sync.synced, true);
    assert.equal(taskRow.executor_userid, 'lisi');
  } finally {
    wecom.addScheduleAttendees = originalAddScheduleAttendees;
    wecom.getSchedule = originalGetSchedule;
  }
});

test('DELETE /schedule/:scheduleId 成功后应同步删除任务表记录', async () => {
  await runSql(
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
    ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now', '+1 hour'), ?, datetime('now'))`,
    [
      'sch-route-delete',
      '取消即删除',
      '取消日程后应从任务表移除',
      'manager-route-user',
      'lisi',
      'manager-route-user',
      'cal-route-manager',
      'PENDING',
    ]
  );

  const originalCancelSchedule = wecom.cancelSchedule;
  wecom.cancelSchedule = async () => ({
    errcode: 0,
    errmsg: 'ok',
  });

  try {
    const response = await invokeJsonRoute({
      path: '/schedule/:scheduleId',
      method: 'delete',
      params: {
        scheduleId: 'sch-route-delete',
      },
    });

    const taskRow = await getSql(
      `SELECT id FROM tasks WHERE wecom_schedule_id = ?`,
      ['sch-route-delete']
    );

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.errcode, 0);
    assert.equal(response.body.task_sync.deleted, true);
    assert.equal(taskRow, null);
  } finally {
    wecom.cancelSchedule = originalCancelSchedule;
  }
});
