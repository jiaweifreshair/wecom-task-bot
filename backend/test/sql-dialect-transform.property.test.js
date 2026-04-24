const test = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');
const { transformSqlForClient } = require('../src/models/db-dialect');

// ---------------------------------------------------------------------------
// Property 4: SQLite 到 MySQL 的 SQL 方言转换正确性
// **Validates: Requirements 2.5, 8.1, 8.2, 8.3, 8.4, 8.5**
//
// 使用 fast-check 生成包含 SQLite 语法的 SQL 字符串，验证转换后包含
// MySQL 等价语法且不含原始 SQLite 语法。
// ---------------------------------------------------------------------------

/**
 * Arbitrary: 生成安全的 SQL 片段前缀/后缀（不含 SQLite 关键字）
 */
const sqlFragmentArb = fc.stringMatching(/^[A-Za-z0-9_ ,()=]{0,40}$/);

/**
 * Arbitrary: 生成合法的 SQL 标识符（列名/表名）
 */
const sqlIdentifierArb = fc.stringMatching(/^[a-z][a-z0-9_]{0,15}$/);

/**
 * Arbitrary: 生成正整数（用于小时偏移量）
 */
const positiveHourArb = fc.integer({ min: 1, max: 999 });

// ---------------------------------------------------------------------------
// 4a: datetime('now') → CURRENT_TIMESTAMP
// ---------------------------------------------------------------------------
test("Property 4a: datetime('now') 转换为 CURRENT_TIMESTAMP", () => {
  fc.assert(
    fc.property(sqlFragmentArb, sqlFragmentArb, (prefix, suffix) => {
      const sql = `${prefix} datetime('now') ${suffix}`;
      const result = transformSqlForClient(sql, 'mysql');

      assert.ok(
        result.includes('CURRENT_TIMESTAMP'),
        `结果应包含 CURRENT_TIMESTAMP，实际: ${result}`
      );
      assert.ok(
        !result.toLowerCase().includes("datetime('now')"),
        `结果不应包含 datetime('now')，实际: ${result}`
      );
    }),
    { numRuns: 200 }
  );
});

// ---------------------------------------------------------------------------
// 4b: datetime(?, 'unixepoch') → FROM_UNIXTIME(?)
// ---------------------------------------------------------------------------
test("Property 4b: datetime(?, 'unixepoch') 转换为 FROM_UNIXTIME(?)", () => {
  fc.assert(
    fc.property(sqlFragmentArb, sqlFragmentArb, (prefix, suffix) => {
      const sql = `${prefix} datetime(?, 'unixepoch') ${suffix}`;
      const result = transformSqlForClient(sql, 'mysql');

      assert.ok(
        result.includes('FROM_UNIXTIME(?)'),
        `结果应包含 FROM_UNIXTIME(?)，实际: ${result}`
      );
      assert.ok(
        !result.toLowerCase().includes("datetime(?, 'unixepoch')"),
        `结果不应包含原始 SQLite 语法，实际: ${result}`
      );
    }),
    { numRuns: 200 }
  );
});

// ---------------------------------------------------------------------------
// 4c: datetime('now', '+N hour') → DATE_ADD(CURRENT_TIMESTAMP, INTERVAL N HOUR)
// ---------------------------------------------------------------------------
test("Property 4c: datetime('now', '+N hour') 转换为 DATE_ADD", () => {
  fc.assert(
    fc.property(
      sqlFragmentArb,
      positiveHourArb,
      sqlFragmentArb,
      (prefix, hours, suffix) => {
        const sql = `${prefix} datetime('now', '+${hours} hour') ${suffix}`;
        const result = transformSqlForClient(sql, 'mysql');

        assert.ok(
          result.includes(`DATE_ADD(CURRENT_TIMESTAMP, INTERVAL ${hours} HOUR)`),
          `结果应包含 DATE_ADD，实际: ${result}`
        );
        assert.ok(
          !result.toLowerCase().includes("datetime('now'"),
          `结果不应包含原始 SQLite datetime 语法，实际: ${result}`
        );
      }
    ),
    { numRuns: 200 }
  );
});

// ---------------------------------------------------------------------------
// 4d: datetime('now', '-N hour') → DATE_SUB(CURRENT_TIMESTAMP, INTERVAL N HOUR)
// ---------------------------------------------------------------------------
test("Property 4d: datetime('now', '-N hour') 转换为 DATE_SUB", () => {
  fc.assert(
    fc.property(
      sqlFragmentArb,
      positiveHourArb,
      sqlFragmentArb,
      (prefix, hours, suffix) => {
        const sql = `${prefix} datetime('now', '-${hours} hour') ${suffix}`;
        const result = transformSqlForClient(sql, 'mysql');

        assert.ok(
          result.includes(`DATE_SUB(CURRENT_TIMESTAMP, INTERVAL ${hours} HOUR)`),
          `结果应包含 DATE_SUB，实际: ${result}`
        );
        assert.ok(
          !result.toLowerCase().includes("datetime('now'"),
          `结果不应包含原始 SQLite datetime 语法，实际: ${result}`
        );
      }
    ),
    { numRuns: 200 }
  );
});

// ---------------------------------------------------------------------------
// 4e: ON CONFLICT(...) DO UPDATE SET col = excluded.col
//     → ON DUPLICATE KEY UPDATE col = VALUES(col)
// ---------------------------------------------------------------------------
test('Property 4e: ON CONFLICT upsert 转换为 ON DUPLICATE KEY UPDATE', () => {
  fc.assert(
    fc.property(
      sqlIdentifierArb,
      fc.array(sqlIdentifierArb, { minLength: 1, maxLength: 5 }),
      (conflictCol, updateCols) => {
        const setClauses = updateCols
          .map((col) => `${col} = excluded.${col}`)
          .join(', ');
        const sql = `INSERT INTO tbl (id) VALUES (1) ON CONFLICT(${conflictCol}) DO UPDATE SET ${setClauses}`;
        const result = transformSqlForClient(sql, 'mysql');

        assert.ok(
          result.includes('ON DUPLICATE KEY UPDATE'),
          `结果应包含 ON DUPLICATE KEY UPDATE，实际: ${result}`
        );
        assert.ok(
          !result.includes('excluded.'),
          `结果不应包含 excluded. 引用，实际: ${result}`
        );
        assert.ok(
          !result.toLowerCase().includes('on conflict'),
          `结果不应包含 ON CONFLICT，实际: ${result}`
        );
        // 每个更新列应被转换为 VALUES(col) 形式
        for (const col of updateCols) {
          assert.ok(
            result.includes(`VALUES(${col})`),
            `结果应包含 VALUES(${col})，实际: ${result}`
          );
        }
      }
    ),
    { numRuns: 200 }
  );
});

// ---------------------------------------------------------------------------
// 4f: sqlite 模式应原样返回输入
// ---------------------------------------------------------------------------
test('Property 4f: sqlite 模式原样返回输入不做任何转换', () => {
  fc.assert(
    fc.property(
      fc.oneof(
        fc.constant("SELECT * FROM t WHERE ts > datetime('now')"),
        fc.constant("INSERT INTO t VALUES (datetime(?, 'unixepoch'))"),
        fc.constant("SELECT * FROM t WHERE ts < datetime('now', '+8 hour')"),
        fc.constant("SELECT * FROM t WHERE ts < datetime('now', '-2 hour')"),
        fc.constant('INSERT INTO t (id) VALUES (1) ON CONFLICT(id) DO UPDATE SET name = excluded.name'),
        sqlFragmentArb.map((f) => `SELECT ${f} FROM tasks`)
      ),
      (sql) => {
        const result = transformSqlForClient(sql, 'sqlite');
        assert.strictEqual(
          result,
          sql,
          `sqlite 模式应原样返回，输入: ${sql}，输出: ${result}`
        );
      }
    ),
    { numRuns: 200 }
  );
});
