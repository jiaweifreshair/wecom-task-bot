const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/models/db');
const {
  getEffectivePlatformAccess,
} = require('../src/services/platform-access');

// runSql
// 是什么：平台权限服务测试写库辅助函数。
// 做什么：把 SQLite 的回调式写操作封装为 Promise，便于准备不同角色与菜单配置数据。
// 为什么：平台权限解析依赖数据库显式配置，测试需要稳定构造前置数据。
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

// resetPlatformAccessTable
// 是什么：平台权限表清理函数。
// 做什么：在每个用例前后清空显式角色与菜单配置，避免跨用例污染。
// 为什么：权限解析会读取同一张表，残留数据会直接影响断言结果。
const resetPlatformAccessTable = async () => {
  await runSql(`DELETE FROM platform_user_access`);
};

test.beforeEach(async () => {
  await resetPlatformAccessTable();
});

test.after(async () => {
  await resetPlatformAccessTable();
});

test('getEffectivePlatformAccess 应返回管理员的自定义菜单权限', async () => {
  await runSql(
    `INSERT INTO platform_user_access (
      user_id,
      platform_role,
      menu_permissions_json,
      updated_by_userid,
      updated_at
    ) VALUES (?, ?, ?, ?, datetime('now'))`,
    ['custom-admin', 'ADMIN', JSON.stringify(['TASKS', 'TEAM_STATS']), 'admin']
  );

  const access = await getEffectivePlatformAccess('custom-admin');

  assert.equal(access.platform_role, 'ADMIN');
  assert.deepEqual(access.menu_permissions, ['TASKS', 'TEAM_STATS']);
  assert.equal(access.is_admin, true);
});

test('getEffectivePlatformAccess 不应允许执行对象突破固定菜单边界', async () => {
  await runSql(
    `INSERT INTO platform_user_access (
      user_id,
      platform_role,
      menu_permissions_json,
      updated_by_userid,
      updated_at
    ) VALUES (?, ?, ?, ?, datetime('now'))`,
    ['executor-a', 'EXECUTOR', JSON.stringify(['DASHBOARD', 'SETTINGS']), 'admin']
  );

  const access = await getEffectivePlatformAccess('executor-a');

  assert.equal(access.platform_role, 'EXECUTOR');
  assert.deepEqual(access.menu_permissions, ['TASKS', 'CALENDAR']);
  assert.equal(access.is_admin, false);
});
