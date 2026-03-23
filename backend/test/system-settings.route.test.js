const test = require('node:test');
const assert = require('node:assert/strict');

const apiRouter = require('../src/routes/api');
const db = require('../src/models/db');
const wecom = require('../src/services/wecom');
const { getEffectivePlatformAccess } = require('../src/services/platform-access');

// runSql
// 是什么：系统设置路由测试写库辅助函数。
// 做什么：把 SQLite 写操作封装为 Promise，便于构造通讯录、部门和平台权限测试数据。
// 为什么：系统设置接口依赖本地快照表和权限表，测试需要稳定准备样本数据。
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

// resetSystemManagementTables
// 是什么：系统管理相关表清理函数。
// 做什么：清空通讯录、日历映射与平台权限数据，保证每个用例隔离执行。
// 为什么：部门过滤与菜单分配都依赖这些表，残留数据会导致结果失真。
const resetSystemManagementTables = async () => {
  await runSql(`DELETE FROM user_calendar_map`);
  await runSql(`DELETE FROM platform_user_access`);
  await runSql(`DELETE FROM wecom_contact_users`);
  await runSql(`DELETE FROM wecom_contact_departments`);
};

// getRouteHandler
// 是什么：路由处理函数提取器。
// 做什么：从 Express Router 内部按方法和路径拿到最终处理器，便于在不引入 supertest 的情况下调用真实路由逻辑。
// 为什么：当前项目路由测试以轻量方式为主，复用真实处理器可以覆盖真实入参校验和响应结构。
const getRouteHandler = (method, path) => {
  const lowerMethod = String(method || '').toLowerCase();
  const layer = apiRouter.stack.find(
    (item) => item && item.route && item.route.path === path && item.route.methods && item.route.methods[lowerMethod]
  );
  assert.ok(layer, `未找到 ${method.toUpperCase()} ${path} 路由`);
  assert.ok(layer.route.stack.length >= 1, `${method.toUpperCase()} ${path} 缺少处理函数`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
};

// invokeRouteHandler
// 是什么：路由调用辅助函数。
// 做什么：构造最小化的 req/res mock 调用真实处理器，并收集状态码和响应体。
// 为什么：系统设置接口只需验证业务逻辑与返回结构，无需引入完整 HTTP 服务。
const invokeRouteHandler = async ({ method, path, query = {}, params = {}, body = {}, user = {} }) => {
  const handler = getRouteHandler(method, path);
  const result = {
    statusCode: 200,
    body: null,
  };

  const req = {
    query,
    params,
    body,
    user,
    traceId: `trace-${String(method).toLowerCase()}-${path}`,
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
  await resetSystemManagementTables();
});

test.after(async () => {
  await resetSystemManagementTables();
});

test('GET /system/users 应支持按部门树过滤并返回自定义菜单权限', async () => {
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
      status,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
    ['zhangsan', '张三', JSON.stringify([2]), 2, '客户经理', 1]
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
    ['wangwu', '王五', JSON.stringify([3]), 3, '区域经理', 1]
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
    ['qa-user', '测试用户', JSON.stringify([9]), 9, '测试工程师', 1]
  );
  await runSql(
    `INSERT INTO user_calendar_map (user_id, cal_id, calendar_summary, source)
     VALUES (?, ?, ?, ?)`,
    ['zhangsan', 'cal-zhangsan', '张三个人日历', 'auto_created']
  );
  await runSql(
    `INSERT INTO platform_user_access (
      user_id,
      platform_role,
      menu_permissions_json,
      updated_by_userid,
      updated_at
    ) VALUES (?, ?, ?, ?, datetime('now'))`,
    ['zhangsan', 'ADMIN', JSON.stringify(['TASKS', 'TEAM_STATS']), 'admin']
  );

  const response = await invokeRouteHandler({
    method: 'get',
    path: '/system/users',
    query: {
      department_id: '2',
      fetch_child: '1',
    },
    user: {
      userid: 'manager-a',
      is_admin: true,
      is_super_admin: false,
      platform_role: 'ADMIN',
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.pagination.total, 2);
  assert.deepEqual(
    response.body.users.map((item) => item.user_id).sort(),
    ['wangwu', 'zhangsan'].sort()
  );
  assert.deepEqual(
    response.body.users.find((item) => item.user_id === 'zhangsan').menu_permissions,
    ['TASKS', 'TEAM_STATS']
  );
});

test('GET /system/users 在本地快照为空时应自动回源企微并写入结果', async () => {
  const originalListUsersByDepartment = wecom.listUsersByDepartment;
  wecom.listUsersByDepartment = async () => ({
    errcode: 0,
    errmsg: 'ok',
    userlist: [
      {
        userid: 'JiaWei',
        name: '贾伟',
        department: [1],
        position: '负责人',
        mobile: '13800000000',
        email: 'jiawei@example.com',
        alias: 'JiaWei',
        status: 1,
      },
      {
        userid: 'him',
        name: '执行同事',
        department: [1],
        position: '执行专员',
        mobile: '13900000000',
        email: 'him@example.com',
        alias: 'him',
        status: 1,
      },
    ],
  });

  try {
    const response = await invokeRouteHandler({
      method: 'get',
      path: '/system/users',
      user: {
        userid: 'manager-a',
        is_admin: true,
        is_super_admin: false,
        platform_role: 'ADMIN',
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.pagination.total, 2);
    assert.deepEqual(
      response.body.users.map((item) => item.user_id).sort(),
      ['JiaWei', 'him'].sort()
    );

    const storedRows = await new Promise((resolve, reject) => {
      db.all(
        `SELECT user_id, name
           FROM wecom_contact_users
          ORDER BY user_id ASC`,
        [],
        (error, rows) => {
          if (error) {
            reject(error);
            return;
          }

          resolve(rows || []);
        }
      );
    });

    assert.deepEqual(
      storedRows.map((item) => item.user_id),
      ['JiaWei', 'him']
    );
  } finally {
    wecom.listUsersByDepartment = originalListUsersByDepartment;
  }
});

test('GET /system/departments 应返回可用于前端树筛选的扁平部门列表', async () => {
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

  const response = await invokeRouteHandler({
    method: 'get',
    path: '/system/departments',
    user: {
      userid: 'manager-a',
      is_admin: true,
      is_super_admin: false,
      platform_role: 'ADMIN',
    },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(
    response.body.departments.map((item) => ({
      id: item.department_id,
      level: item.level,
    })),
    [
      { id: 2, level: 0 },
      { id: 3, level: 1 },
      { id: 9, level: 0 },
    ]
  );
});

test('POST /system/users/:id/menu-permissions 应允许超级管理员更新管理员菜单权限', async () => {
  await runSql(
    `INSERT INTO platform_user_access (
      user_id,
      platform_role,
      menu_permissions_json,
      updated_by_userid,
      updated_at
    ) VALUES (?, ?, ?, ?, datetime('now'))`,
    ['ops-admin', 'ADMIN', JSON.stringify(['DASHBOARD', 'TASKS', 'CALENDAR']), 'admin']
  );

  const response = await invokeRouteHandler({
    method: 'post',
    path: '/system/users/:id/menu-permissions',
    params: {
      id: 'ops-admin',
    },
    body: {
      menu_permissions: ['TASKS', 'TEAM_STATS'],
    },
    user: {
      userid: 'admin',
      is_admin: true,
      is_super_admin: true,
      platform_role: 'SUPER_ADMIN',
    },
  });

  assert.equal(response.statusCode, 200);

  const access = await getEffectivePlatformAccess('ops-admin');
  assert.equal(access.platform_role, 'ADMIN');
  assert.deepEqual(access.menu_permissions, ['TASKS', 'TEAM_STATS']);
});
