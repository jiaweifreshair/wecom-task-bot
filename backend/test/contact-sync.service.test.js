const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/models/db');
const contactSyncService = require('../src/services/contact-sync');

// runSql
// 是什么：测试环境 SQLite 写操作辅助函数。
// 做什么：将 `db.run` 封装为 Promise，便于测试里串行清理和断言。
// 为什么：通讯录同步测试需要稳定控制表数据，避免回调式写法降低可读性。
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
// 是什么：测试环境 SQLite 单行查询辅助函数。
// 做什么：将 `db.get` 封装为 Promise，未命中时返回 `null`。
// 为什么：用例需要直接断言通讯录同步后的数据库状态。
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

// resetContactSyncTables
// 是什么：通讯录同步测试表清理函数。
// 做什么：在每个用例前后删除联系人、部门、标签和事件日志数据。
// 为什么：这些测试依赖数据库持久化，必须保证用例彼此隔离。
const resetContactSyncTables = async () => {
  await runSql(`DELETE FROM wecom_contact_event_log`);
  await runSql(`DELETE FROM wecom_contact_tags`);
  await runSql(`DELETE FROM wecom_contact_departments`);
  await runSql(`DELETE FROM wecom_contact_users`);
};

test.beforeEach(async () => {
  await resetContactSyncTables();
});

test.after(async () => {
  await resetContactSyncTables();
});

test('handleChangeContactEvent 应写入新增成员与事件日志', async () => {
  const result = await contactSyncService.handleChangeContactEvent({
    ChangeType: 'create_user',
    UserID: 'zhangsan',
    Name: '张三',
    Department: '1,2',
    MainDepartment: '1',
    IsLeaderInDept: '1,0',
    DirectLeader: 'leader-a,leader-b',
    Position: '产品经理',
    Mobile: '13800000000',
    Gender: '1',
    Email: 'zhangsan@example.com',
    BizMail: 'zhangsan@corp.example.com',
    Status: '1',
    Avatar: 'https://example.com/avatar.png',
    Telephone: '020-12345678',
    Address: '广州',
    Alias: 'zs',
  });

  assert.equal(result.success, true);
  assert.equal(result.change_type, 'create_user');
  assert.equal(result.entity_type, 'user');
  assert.equal(result.entity_id, 'zhangsan');

  const userRow = await getSql(
    `SELECT user_id, name, main_department, position, mobile, email, alias, department_ids_json, direct_leader_user_ids_json
       FROM wecom_contact_users
      WHERE user_id = ?`,
    ['zhangsan']
  );

  assert.equal(userRow.user_id, 'zhangsan');
  assert.equal(userRow.name, '张三');
  assert.equal(userRow.main_department, 1);
  assert.equal(userRow.position, '产品经理');
  assert.equal(userRow.mobile, '13800000000');
  assert.equal(userRow.email, 'zhangsan@example.com');
  assert.equal(userRow.alias, 'zs');
  assert.deepEqual(JSON.parse(userRow.department_ids_json), [1, 2]);
  assert.deepEqual(JSON.parse(userRow.direct_leader_user_ids_json), ['leader-a', 'leader-b']);

  const eventLogRow = await getSql(
    `SELECT change_type, entity_type, entity_id
       FROM wecom_contact_event_log
      WHERE entity_id = ?
      ORDER BY id DESC
      LIMIT 1`,
    ['zhangsan']
  );

  assert.deepEqual(eventLogRow, {
    change_type: 'create_user',
    entity_type: 'user',
    entity_id: 'zhangsan',
  });
});

test('handleChangeContactEvent 应支持 update_user 变更 userid', async () => {
  await contactSyncService.handleChangeContactEvent({
    ChangeType: 'create_user',
    UserID: 'zhangsan',
    Name: '旧账号',
    Department: '1',
  });

  const result = await contactSyncService.handleChangeContactEvent({
    ChangeType: 'update_user',
    UserID: 'zhangsan',
    NewUserID: 'zhangsan.new',
    Name: '新账号',
    Department: '1,3',
    MainDepartment: '3',
    Mobile: '13900000000',
  });

  assert.equal(result.success, true);
  assert.equal(result.entity_id, 'zhangsan.new');

  const oldUserRow = await getSql(
    `SELECT user_id FROM wecom_contact_users WHERE user_id = ?`,
    ['zhangsan']
  );
  const newUserRow = await getSql(
    `SELECT user_id, name, main_department, mobile, department_ids_json
       FROM wecom_contact_users
      WHERE user_id = ?`,
    ['zhangsan.new']
  );

  assert.equal(oldUserRow, null);
  assert.deepEqual(newUserRow, {
    user_id: 'zhangsan.new',
    name: '新账号',
    main_department: 3,
    mobile: '13900000000',
    department_ids_json: JSON.stringify([1, 3]),
  });
});

test('handleChangeContactEvent 应删除成员数据', async () => {
  await contactSyncService.handleChangeContactEvent({
    ChangeType: 'create_user',
    UserID: 'lisi',
    Name: '李四',
    Department: '2',
  });

  const result = await contactSyncService.handleChangeContactEvent({
    ChangeType: 'delete_user',
    UserID: 'lisi',
  });

  assert.equal(result.success, true);
  assert.equal(result.entity_id, 'lisi');

  const userRow = await getSql(
    `SELECT user_id FROM wecom_contact_users WHERE user_id = ?`,
    ['lisi']
  );

  assert.equal(userRow, null);
});

test('handleChangeContactEvent 应写入和删除部门数据', async () => {
  const createResult = await contactSyncService.handleChangeContactEvent({
    ChangeType: 'create_party',
    Id: '100',
    Name: '研发中心',
    ParentId: '1',
    Order: '10',
  });

  assert.equal(createResult.success, true);
  assert.equal(createResult.entity_type, 'department');
  assert.equal(createResult.entity_id, '100');

  const departmentRow = await getSql(
    `SELECT department_id, name, parent_department_id, order_value
       FROM wecom_contact_departments
      WHERE department_id = ?`,
    [100]
  );

  assert.deepEqual(departmentRow, {
    department_id: 100,
    name: '研发中心',
    parent_department_id: 1,
    order_value: 10,
  });

  const deleteResult = await contactSyncService.handleChangeContactEvent({
    ChangeType: 'delete_party',
    Id: '100',
  });

  assert.equal(deleteResult.success, true);

  const deletedDepartmentRow = await getSql(
    `SELECT department_id FROM wecom_contact_departments WHERE department_id = ?`,
    [100]
  );

  assert.equal(deletedDepartmentRow, null);
});

test('handleChangeContactEvent 应写入和删除标签数据', async () => {
  const updateResult = await contactSyncService.handleChangeContactEvent({
    ChangeType: 'update_tag',
    TagId: '200',
    Name: '项目组',
    AddUserItems: 'zhangsan,lisi',
    DelUserItems: 'wangwu',
    AddPartyItems: '1,2',
    DelPartyItems: '3',
  });

  assert.equal(updateResult.success, true);
  assert.equal(updateResult.entity_type, 'tag');
  assert.equal(updateResult.entity_id, '200');

  const tagRow = await getSql(
    `SELECT tag_id, name, add_user_items_json, del_user_items_json, add_party_items_json, del_party_items_json
       FROM wecom_contact_tags
      WHERE tag_id = ?`,
    [200]
  );

  assert.deepEqual(tagRow, {
    tag_id: 200,
    name: '项目组',
    add_user_items_json: JSON.stringify(['zhangsan', 'lisi']),
    del_user_items_json: JSON.stringify(['wangwu']),
    add_party_items_json: JSON.stringify([1, 2]),
    del_party_items_json: JSON.stringify([3]),
  });

  const deleteResult = await contactSyncService.handleChangeContactEvent({
    ChangeType: 'delete_tag',
    TagId: '200',
  });

  assert.equal(deleteResult.success, true);

  const deletedTagRow = await getSql(
    `SELECT tag_id FROM wecom_contact_tags WHERE tag_id = ?`,
    [200]
  );

  assert.equal(deletedTagRow, null);
});

test('handleChangeContactEvent 对未知变更类型应返回 skipped', async () => {
  const result = await contactSyncService.handleChangeContactEvent({
    ChangeType: 'unknown_change',
    UserID: 'nobody',
  });

  assert.equal(result.success, false);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'unsupported_change_type');
});
