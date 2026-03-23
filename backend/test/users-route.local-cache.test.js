const test = require('node:test');
const assert = require('node:assert/strict');

const apiRouter = require('../src/routes/api');
const db = require('../src/models/db');
const wecom = require('../src/services/wecom');

// runSql
// 是什么：`/users` 路由测试用 SQLite 写操作辅助函数。
// 做什么：将回调式 `db.run` 封装为 Promise，便于准备本地通讯录快照和部门树数据。
// 为什么：本用例需要构造回退缓存场景，并保证每次执行前后都能稳定清理。
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

// resetContactCacheTables
// 是什么：通讯录缓存测试表清理函数。
// 做什么：删除成员和部门快照，确保 `/users` 回退测试彼此隔离。
// 为什么：本地缓存回退逻辑完全依赖数据库状态，必须避免跨用例污染。
const resetContactCacheTables = async () => {
  await runSql(`DELETE FROM wecom_contact_users`);
  await runSql(`DELETE FROM wecom_contact_departments`);
};

// getUsersRouteHandler
// 是什么：`/users` 路由处理函数提取器。
// 做什么：从 Express Router 内部栈中拿到真正的异步处理器，跳过鉴权中间件直接做路由级测试。
// 为什么：项目当前未引入 supertest，这种方式能最小代价覆盖真实路由逻辑。
const getUsersRouteHandler = () => {
  const layer = apiRouter.stack.find((item) => item && item.route && item.route.path === '/users');
  assert.ok(layer, '未找到 /users 路由');
  assert.ok(layer.route.stack.length >= 2, '/users 路由缺少处理函数');
  return layer.route.stack[layer.route.stack.length - 1].handle;
};

// invokeUsersRoute
// 是什么：`/users` 路由调用辅助函数。
// 做什么：以最小 mock 的 `req/res` 调用真实处理器，并收集状态码和 JSON 响应体。
// 为什么：测试目标是验证回退响应内容，而不是 Express 本身的行为。
const invokeUsersRoute = async (query = {}) => {
  const handler = getUsersRouteHandler();
  const result = {
    statusCode: 200,
    body: null,
  };
  const req = {
    query,
    user: {
      userid: 'route-test-user',
      name: '路由测试用户',
    },
    traceId: 'trace-users-route-local-cache',
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

test.beforeEach(async () => {
  await resetContactCacheTables();
});

test.after(async () => {
  await resetContactCacheTables();
});

test('GET /users 在企微实时查询失败时应回退本地通讯录快照并保留部门过滤', async () => {
  await runSql(
    `INSERT INTO wecom_contact_departments (department_id, name, parent_department_id, order_value)
     VALUES (?, ?, ?, ?)`,
    [2, '销售一部', 1, 10]
  );
  await runSql(
    `INSERT INTO wecom_contact_departments (department_id, name, parent_department_id, order_value)
     VALUES (?, ?, ?, ?)`,
    [3, '销售一部-华南组', 2, 20]
  );
  await runSql(
    `INSERT INTO wecom_contact_departments (department_id, name, parent_department_id, order_value)
     VALUES (?, ?, ?, ?)`,
    [9, '研发中心', 1, 30]
  );

  await runSql(
    `INSERT INTO wecom_contact_users (
      user_id,
      name,
      department_ids_json,
      main_department,
      position,
      mobile,
      email,
      status,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    ['zhangsan', '张三', JSON.stringify([2]), 2, '客户经理', '13800000000', 'zhangsan@example.com', 1]
  );
  await runSql(
    `INSERT INTO wecom_contact_users (
      user_id,
      name,
      department_ids_json,
      main_department,
      position,
      mobile,
      email,
      status,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    ['wangwu', '王五', JSON.stringify([3]), 3, '区域经理', '13900000000', 'wangwu@example.com', 1]
  );
  await runSql(
    `INSERT INTO wecom_contact_users (
      user_id,
      name,
      department_ids_json,
      main_department,
      position,
      mobile,
      email,
      status,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    ['qa-user', '测试用户', JSON.stringify([9]), 9, '测试工程师', '13700000000', 'qa@example.com', 1]
  );
  await runSql(
    `INSERT INTO wecom_contact_users (
      user_id,
      name,
      department_ids_json,
      main_department,
      position,
      mobile,
      email,
      status,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    ['disabled-user', '已停用成员', JSON.stringify([2]), 2, '停用岗位', '13600000000', 'disabled@example.com', 2]
  );

  const originalListUsersByDepartment = wecom.listUsersByDepartment;
  wecom.listUsersByDepartment = async () => {
    throw new Error('connect ETIMEDOUT qyapi.weixin.qq.com');
  };

  try {
    const response = await invokeUsersRoute({
      department_id: '2',
      fetch_child: '1',
      status: '1',
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.errcode, 0);
    assert.equal(response.body.degraded, true);
    assert.equal(response.body.source, 'local_cache');
    assert.equal(response.body.degrade_reason, 'wecom_user_list_unavailable');
    assert.deepEqual(
      response.body.userlist.map((item) => item.userid),
      ['wangwu', 'zhangsan']
    );
    assert.deepEqual(
      response.body.userlist.map((item) => item.name),
      ['王五', '张三']
    );
  } finally {
    wecom.listUsersByDepartment = originalListUsersByDepartment;
  }
});

test('GET /users 对执行对象也应返回完整组织成员候选列表', async () => {
  await runSql(
    `INSERT INTO wecom_contact_departments (department_id, name, parent_department_id, order_value)
     VALUES (?, ?, ?, ?)`,
    [2, '销售一部', 1, 10]
  );
  await runSql(
    `INSERT INTO wecom_contact_users (
      user_id,
      name,
      department_ids_json,
      main_department,
      position,
      status,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
    ['JiaWei', '贾伟', JSON.stringify([2]), 2, '负责人', 1]
  );
  await runSql(
    `INSERT INTO wecom_contact_users (
      user_id,
      name,
      department_ids_json,
      main_department,
      position,
      status,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
    ['him', '执行同事', JSON.stringify([2]), 2, '执行专员', 1]
  );

  const originalListUsersByDepartment = wecom.listUsersByDepartment;
  wecom.listUsersByDepartment = async () => {
    throw new Error('connect ETIMEDOUT qyapi.weixin.qq.com');
  };

  try {
    const handler = getUsersRouteHandler();
    const result = {
      statusCode: 200,
      body: null,
    };
    const req = {
      query: {
        department_id: '2',
        fetch_child: '1',
        status: '0',
      },
      user: {
        userid: 'him',
        name: '执行同事',
        is_admin: false,
        is_super_admin: false,
        platform_role: 'EXECUTOR',
      },
      traceId: 'trace-users-route-executor-all-candidates',
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

    assert.equal(result.statusCode, 200);
    assert.equal(result.body.errcode, 0);
    assert.equal(result.body.restricted_to_self, undefined);
    assert.deepEqual(
      result.body.userlist.map((item) => item.userid),
      ['JiaWei', 'him']
    );
  } finally {
    wecom.listUsersByDepartment = originalListUsersByDepartment;
  }
});
