const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/models/db');

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

const getTaskTableColumns = async () => {
  const rows = await allSql(`PRAGMA table_info(tasks)`);
  return new Set(rows.map((item) => item && item.name).filter(Boolean));
};

const ensureTaskScopeColumns = async () => {
  const columns = await getTaskTableColumns();

  if (!columns.has('owner_userid')) {
    await runSql(`ALTER TABLE tasks ADD COLUMN owner_userid TEXT`);
  }

  if (!columns.has('owner_cal_id')) {
    await runSql(`ALTER TABLE tasks ADD COLUMN owner_cal_id TEXT`);
  }
};

const queryTasksByUser = async (userId) => {
  const normalizedUserId = String(userId || '').trim();
  const whereClauses = [];
  const params = [];

  if (normalizedUserId) {
    whereClauses.push('(owner_userid = ? OR executor_userid = ? OR creator_userid = ?)');
    params.push(normalizedUserId, normalizedUserId, normalizedUserId);
  }

  const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

  return allSql(`SELECT * FROM tasks ${whereSql} ORDER BY id ASC`, params);
};

test.beforeEach(async () => {
  await ensureTaskScopeColumns();
  await runSql('DELETE FROM tasks');

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
    ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now', '+1 hour'), 'PENDING', datetime('now'))`,
    ['schedule-zhangsan', '任务A', 'A', 'manager-a', 'zhangsan', 'zhangsan', 'cal-a']
  );

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
    ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now', '+1 hour'), 'PENDING', datetime('now'))`,
    ['schedule-lisi', '任务B', 'B', 'manager-b', 'lisi', 'lisi', 'cal-b']
  );
});

test.after(async () => {
  await runSql('DELETE FROM tasks');
});

test('任务查询应只返回当前用户相关任务', async () => {
  const zhangsanTasks = await queryTasksByUser('zhangsan');
  assert.equal(zhangsanTasks.length, 1);
  assert.equal(zhangsanTasks[0].wecom_schedule_id, 'schedule-zhangsan');

  const lisiTasks = await queryTasksByUser('lisi');
  assert.equal(lisiTasks.length, 1);
  assert.equal(lisiTasks[0].wecom_schedule_id, 'schedule-lisi');
});
