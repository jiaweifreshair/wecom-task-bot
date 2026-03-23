const db = require('../models/db');
const { normalizeText } = require('./task-lifecycle');

// runSql
// 是什么：SQLite 写操作 Promise 包装函数。
// 做什么：将 `db.run` 转换为 Promise，并返回变更行数与最后插入 ID。
// 为什么：统一数据库写入调用风格，避免回调嵌套影响业务可读性。
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

// getSql
// 是什么：SQLite 单行查询 Promise 包装函数。
// 做什么：将 `db.get` 封装为 Promise，缺失数据时返回 `null`。
// 为什么：用户日历映射是单条读取场景，Promise 化后更易复用在服务层。
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

// allSql
// 是什么：SQLite 多行查询 Promise 包装函数。
// 做什么：将 `db.all` 封装为 Promise，缺失数据时返回空数组。
// 为什么：同步服务需批量读取用户日历映射，统一返回结构可简化上层处理。
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

// toUserCalendarRow
// 是什么：用户日历映射标准化函数。
// 做什么：将数据库行转换为统一 `{ user_id, cal_id, source }` 结构。
// 为什么：不同来源可能带额外字段，服务层只应依赖稳定核心字段。
const toUserCalendarRow = (row) => {
  const userId = normalizeText(row && row.user_id);
  const calId = normalizeText(row && row.cal_id);
  const source = normalizeText(row && row.source) || 'db';

  if (!userId || !calId) {
    return null;
  }

  return {
    user_id: userId,
    cal_id: calId,
    source,
  };
};

// listUserCalendarRows
// 是什么：用户日历映射列表查询函数。
// 做什么：读取表 `user_calendar_map` 的全部映射并返回标准化结果。
// 为什么：同步任务需要一次性拿到全量映射构建待拉取日历列表。
const listUserCalendarRows = async () => {
  const rows = await allSql(
    `SELECT user_id, cal_id, source FROM user_calendar_map ORDER BY datetime(updated_at) DESC, user_id ASC`
  );

  return rows.map((item) => toUserCalendarRow(item)).filter(Boolean);
};

// getUserCalendarRowByUserId
// 是什么：按用户查询日历映射函数。
// 做什么：根据 `user_id` 查询单条映射，未命中返回 `null`。
// 为什么：登录时需要快速判断当前账号是否已经完成日历绑定。
const getUserCalendarRowByUserId = async (userId) => {
  const normalizedUserId = normalizeText(userId);
  if (!normalizedUserId) {
    return null;
  }

  const row = await getSql(
    `SELECT user_id, cal_id, source FROM user_calendar_map WHERE user_id = ? LIMIT 1`,
    [normalizedUserId]
  );

  return toUserCalendarRow(row);
};

// getUserCalendarRowByCalId
// 是什么：按日历 ID 查询用户映射函数。
// 做什么：根据 `cal_id` 查询当前归属的账号映射，未命中时返回 `null`。
// 为什么：日历页直接操作 `schedule/*` 后，需要反查任务应归属到哪个账号。
const getUserCalendarRowByCalId = async (calId) => {
  const normalizedCalId = normalizeText(calId);
  if (!normalizedCalId) {
    return null;
  }

  const row = await getSql(
    `SELECT user_id, cal_id, source FROM user_calendar_map WHERE cal_id = ? ORDER BY datetime(updated_at) DESC LIMIT 1`,
    [normalizedCalId]
  );

  return toUserCalendarRow(row);
};

// upsertUserCalendarRow
// 是什么：用户日历映射写入函数。
// 做什么：以 `user_id` 为唯一键插入或更新 `cal_id/source/summary`。
// 为什么：登录自动建历需要幂等写入，避免重复账号产生多条映射冲突。
const upsertUserCalendarRow = async (input = {}) => {
  const userId = normalizeText(input.user_id);
  const calId = normalizeText(input.cal_id);
  const source = normalizeText(input.source) || 'auto_created';
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

  return getUserCalendarRowByUserId(userId);
};

// deleteUserCalendarRowByUserId
// 是什么：按用户删除日历映射函数。
// 做什么：仅当 `user_id + cal_id` 同时命中时删除数据库映射，返回是否实际删除。
// 为什么：同步发现失效日历 ID 时需要精准清理脏映射，避免误删已更新的新绑定。
const deleteUserCalendarRowByUserId = async (userId, calId = '') => {
  const normalizedUserId = normalizeText(userId);
  const normalizedCalId = normalizeText(calId);

  if (!normalizedUserId) {
    return false;
  }

  const sql = normalizedCalId
    ? `DELETE FROM user_calendar_map WHERE user_id = ? AND cal_id = ?`
    : `DELETE FROM user_calendar_map WHERE user_id = ?`;
  const params = normalizedCalId ? [normalizedUserId, normalizedCalId] : [normalizedUserId];
  const result = await runSql(sql, params);

  return Number(result && result.changes) > 0;
};

module.exports = {
  listUserCalendarRows,
  getUserCalendarRowByUserId,
  getUserCalendarRowByCalId,
  upsertUserCalendarRow,
  deleteUserCalendarRowByUserId,
};
