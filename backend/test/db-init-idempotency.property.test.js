const test = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');
const fs = require('fs');
const path = require('path');
const { executeSqlFiles, preprocessDelimiterSyntax } = require('../scripts/init-mysql');

// ---------------------------------------------------------------------------
// Property 2: 数据库初始化幂等性
// **Validates: Requirements 1.9**
//
// 验证重复执行初始化后表结构不变、数据不丢失、不抛错。
// 使用 mock pool 方式，无需真实 MySQL 连接。
// ---------------------------------------------------------------------------

const SQL_DIR = path.resolve(__dirname, '../sql');

// ---------------------------------------------------------------------------
// Part A: executeSqlFiles 重复执行幂等性（mock pool）
// ---------------------------------------------------------------------------

test('Property 2: executeSqlFiles 重复执行 1-5 次不抛错且每次执行相同 SQL 语句集', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 1, max: 5 }),
      async (repeatCount) => {
        // 收集每轮执行的 SQL 语句
        const rounds = [];

        for (let i = 0; i < repeatCount; i++) {
          const executed = [];
          const mockPool = {
            query: async (sql) => {
              executed.push(sql);
            },
          };
          await executeSqlFiles(mockPool, SQL_DIR);
          rounds.push(executed);
        }

        // 每轮执行的语句数量应相同
        for (let i = 1; i < rounds.length; i++) {
          assert.strictEqual(
            rounds[i].length,
            rounds[0].length,
            `第 ${i + 1} 轮执行的语句数 (${rounds[i].length}) 应与第 1 轮 (${rounds[0].length}) 相同`
          );
        }

        // 每轮执行的语句内容应完全一致（幂等性）
        for (let i = 1; i < rounds.length; i++) {
          for (let j = 0; j < rounds[0].length; j++) {
            assert.strictEqual(
              rounds[i][j],
              rounds[0][j],
              `第 ${i + 1} 轮第 ${j + 1} 条语句应与第 1 轮一致`
            );
          }
        }

        // 至少应执行一些语句（SQL 目录非空）
        assert.ok(rounds[0].length > 0, '应至少执行一条 SQL 语句');
      }
    ),
    { numRuns: 10 }
  );
});

// ---------------------------------------------------------------------------
// Part B: 实际 SQL 文件包含幂等模式验证
// ---------------------------------------------------------------------------

test('Property 2 补充: 001-create-database.sql 包含 CREATE DATABASE IF NOT EXISTS', () => {
  const content = fs.readFileSync(path.join(SQL_DIR, '001-create-database.sql'), 'utf8');
  assert.ok(
    /CREATE\s+DATABASE\s+IF\s+NOT\s+EXISTS/i.test(content),
    '001 应包含 CREATE DATABASE IF NOT EXISTS'
  );
});

test('Property 2 补充: 002-create-tables.sql 为全部 7 张表使用 CREATE TABLE IF NOT EXISTS', () => {
  const content = fs.readFileSync(path.join(SQL_DIR, '002-create-tables.sql'), 'utf8');

  const expectedTables = [
    'tasks',
    'user_calendar_map',
    'wecom_contact_users',
    'wecom_contact_departments',
    'wecom_contact_tags',
    'wecom_contact_event_log',
    'platform_user_access',
  ];

  // 提取所有 CREATE TABLE IF NOT EXISTS 的表名
  const createTablePattern = /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(\w+)/gi;
  const foundTables = [];
  let match;
  while ((match = createTablePattern.exec(content)) !== null) {
    foundTables.push(match[1].toLowerCase());
  }

  for (const table of expectedTables) {
    assert.ok(
      foundTables.includes(table),
      `002 应包含 CREATE TABLE IF NOT EXISTS ${table}，实际找到: [${foundTables.join(', ')}]`
    );
  }

  assert.strictEqual(
    foundTables.length,
    expectedTables.length,
    `应恰好有 ${expectedTables.length} 个 CREATE TABLE IF NOT EXISTS，实际有 ${foundTables.length}`
  );
});

test('Property 2 补充: 003-migrations.sql 使用 INFORMATION_SCHEMA 条件判断实现幂等迁移', () => {
  const content = fs.readFileSync(path.join(SQL_DIR, '003-migrations.sql'), 'utf8');

  // 应包含 INFORMATION_SCHEMA.COLUMNS 查询（用于判断列是否已存在）
  assert.ok(
    /INFORMATION_SCHEMA\.COLUMNS/i.test(content),
    '003 应使用 INFORMATION_SCHEMA.COLUMNS 进行列存在性检查'
  );

  // 应包含 IF NOT EXISTS 模式（在存储过程内部）
  const ifNotExistsCount = (content.match(/IF\s+NOT\s+EXISTS/gi) || []).length;
  assert.ok(
    ifNotExistsCount >= 9,
    `003 应至少有 9 处 IF NOT EXISTS 检查（tasks 8 列 + platform_user_access 1 列），实际有 ${ifNotExistsCount}`
  );
});

// ---------------------------------------------------------------------------
// Part C: 使用 fast-check 生成随机临时 SQL 目录，验证幂等性属性
// ---------------------------------------------------------------------------

/**
 * Arbitrary: 生成幂等 SQL 语句（使用 IF NOT EXISTS 模式）
 */
const idempotentSqlArb = fc.oneof(
  fc.stringMatching(/^[a-z]{1,12}$/).map(
    (name) => `CREATE TABLE IF NOT EXISTS ${name} (id INT PRIMARY KEY);`
  ),
  fc.stringMatching(/^[a-z]{1,12}$/).map(
    (name) => `CREATE DATABASE IF NOT EXISTS ${name};`
  )
);

test('Property 2 补充: 对任意幂等 SQL 文件集合，重复执行 executeSqlFiles 产生相同语句序列', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(
        fc.tuple(
          fc.integer({ min: 1, max: 99 }),
          fc.array(idempotentSqlArb, { minLength: 1, maxLength: 5 })
        ),
        { minLength: 1, maxLength: 5 }
      ),
      fc.integer({ min: 2, max: 4 }),
      async (fileSpecs, repeatCount) => {
        // 创建临时目录
        const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'sql-idem-'));

        try {
          // 写入随机 SQL 文件
          for (const [num, stmts] of fileSpecs) {
            const fileName = `${String(num).padStart(3, '0')}-test.sql`;
            fs.writeFileSync(path.join(tmpDir, fileName), stmts.join('\n'));
          }

          // 多轮执行
          const rounds = [];
          for (let i = 0; i < repeatCount; i++) {
            const executed = [];
            const mockPool = { query: async (sql) => { executed.push(sql); } };
            await executeSqlFiles(mockPool, tmpDir);
            rounds.push(executed);
          }

          // 每轮语句数量一致
          for (let i = 1; i < rounds.length; i++) {
            assert.strictEqual(rounds[i].length, rounds[0].length);
          }

          // 每轮语句内容一致
          for (let i = 1; i < rounds.length; i++) {
            assert.deepStrictEqual(rounds[i], rounds[0]);
          }
        } finally {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        }
      }
    ),
    { numRuns: 20 }
  );
});
