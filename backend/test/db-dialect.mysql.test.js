const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveDbClientName,
  transformSqlForClient,
  buildSchemaStatements,
} = require('../src/models/db-dialect');

test('未显式指定且未配置 sqlite 路径时应默认使用 mysql', () => {
  const clientName = resolveDbClientName({});
  assert.equal(clientName, 'mysql');
});

test('配置 sqlite 数据库路径时应回退到 sqlite', () => {
  const clientName = resolveDbClientName({
    TASK_BOT_DB_PATH: '/tmp/tasks.test.db',
  });
  assert.equal(clientName, 'sqlite');
});

test('mysql 模式应把 sqlite upsert 与当前时间表达式转换为兼容语法', () => {
  const sql = `
    INSERT INTO user_calendar_map (
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
      updated_at = datetime('now')
  `;

  const transformedSql = transformSqlForClient(sql, 'mysql');

  assert.match(transformedSql, /ON DUPLICATE KEY UPDATE/i);
  assert.match(transformedSql, /VALUES\(cal_id\)/i);
  assert.match(transformedSql, /VALUES\(calendar_summary\)/i);
  assert.match(transformedSql, /CURRENT_TIMESTAMP/i);
  assert.doesNotMatch(transformedSql, /excluded\./i);
  assert.doesNotMatch(transformedSql, /datetime\('now'\)/i);
});

test('mysql 模式应把 sqlite 时间函数转换为兼容语法', () => {
  const sql = `
    SELECT * FROM tasks
    WHERE start_time >= datetime(?, 'unixepoch')
    ORDER BY datetime(updated_at) DESC
  `;

  const transformedSql = transformSqlForClient(sql, 'mysql');

  assert.match(transformedSql, /FROM_UNIXTIME\(\?\)/i);
  assert.match(transformedSql, /ORDER BY updated_at DESC/i);
  assert.doesNotMatch(transformedSql, /datetime\(updated_at\)/i);
});

test('mysql 模式建表语句应使用 AUTO_INCREMENT 与可建索引的主键类型', () => {
  const statements = buildSchemaStatements('mysql');
  const tasksSql = statements.find((item) => item.tableName === 'tasks');
  const userCalendarSql = statements.find((item) => item.tableName === 'user_calendar_map');

  assert.ok(tasksSql);
  assert.ok(userCalendarSql);
  assert.match(tasksSql.sql, /AUTO_INCREMENT/i);
  assert.match(userCalendarSql.sql, /user_id VARCHAR\(191\) PRIMARY KEY/i);
  assert.match(userCalendarSql.sql, /ENGINE=InnoDB/i);
});
