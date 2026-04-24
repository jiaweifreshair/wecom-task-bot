const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { sortSqlFiles, preprocessDelimiterSyntax, executeSqlFiles } = require('../scripts/init-mysql');

// ---------------------------------------------------------------------------
// sortSqlFiles
// ---------------------------------------------------------------------------

test('sortSqlFiles 按数字前缀升序排列', () => {
  const input = ['003-migrations.sql', '001-create-database.sql', '002-create-tables.sql'];
  const result = sortSqlFiles(input);
  assert.deepStrictEqual(result, [
    '001-create-database.sql',
    '002-create-tables.sql',
    '003-migrations.sql',
  ]);
});

test('sortSqlFiles 不修改原数组', () => {
  const input = ['002-b.sql', '001-a.sql'];
  const copy = [...input];
  sortSqlFiles(input);
  assert.deepStrictEqual(input, copy);
});

test('sortSqlFiles 处理无数字前缀的文件名', () => {
  const input = ['setup.sql', '001-init.sql'];
  const result = sortSqlFiles(input);
  assert.deepStrictEqual(result, ['setup.sql', '001-init.sql']);
});

test('sortSqlFiles 空数组返回空数组', () => {
  assert.deepStrictEqual(sortSqlFiles([]), []);
});

// ---------------------------------------------------------------------------
// preprocessDelimiterSyntax
// ---------------------------------------------------------------------------

test('preprocessDelimiterSyntax 处理简单分号分隔语句', () => {
  const sql = 'CREATE TABLE a (id INT);\nCREATE TABLE b (id INT);';
  const stmts = preprocessDelimiterSyntax(sql);
  assert.ok(stmts.length >= 2);
  assert.ok(stmts.some((s) => s.includes('CREATE TABLE a')));
  assert.ok(stmts.some((s) => s.includes('CREATE TABLE b')));
});

test('preprocessDelimiterSyntax 处理 DELIMITER // 语法', () => {
  const sql = [
    'DROP PROCEDURE IF EXISTS test_proc;',
    '',
    'DELIMITER //',
    '',
    'CREATE PROCEDURE test_proc()',
    'BEGIN',
    '  SELECT 1;',
    'END//',
    '',
    'DELIMITER ;',
    '',
    'CALL test_proc();',
  ].join('\n');

  const stmts = preprocessDelimiterSyntax(sql);

  // Should have: DROP PROCEDURE, CREATE PROCEDURE block, CALL
  assert.ok(stmts.some((s) => s.includes('DROP PROCEDURE')), 'should contain DROP PROCEDURE');
  assert.ok(stmts.some((s) => s.includes('CREATE PROCEDURE')), 'should contain CREATE PROCEDURE');
  assert.ok(stmts.some((s) => s.includes('CALL test_proc')), 'should contain CALL');

  // The CREATE PROCEDURE block should NOT contain DELIMITER directives
  for (const stmt of stmts) {
    assert.ok(!stmt.match(/^DELIMITER/im), `statement should not contain DELIMITER directive: ${stmt.slice(0, 60)}`);
  }
});

test('preprocessDelimiterSyntax 过滤纯注释行', () => {
  const sql = '-- this is a comment\n-- another comment';
  const stmts = preprocessDelimiterSyntax(sql);
  assert.strictEqual(stmts.length, 0);
});

test('preprocessDelimiterSyntax 处理空输入', () => {
  assert.deepStrictEqual(preprocessDelimiterSyntax(''), []);
});

test('preprocessDelimiterSyntax 正确处理 003-migrations.sql 格式', () => {
  const sqlPath = path.resolve(__dirname, '../sql/003-migrations.sql');
  const content = fs.readFileSync(sqlPath, 'utf8');
  const stmts = preprocessDelimiterSyntax(content);

  // Should produce executable statements (USE, DROP PROCEDURE, CREATE PROCEDURE, CALL, DROP PROCEDURE)
  assert.ok(stmts.length >= 3, `expected at least 3 statements, got ${stmts.length}`);

  // Should contain the CREATE PROCEDURE with BEGIN...END block
  const createProc = stmts.find((s) => s.includes('CREATE PROCEDURE'));
  assert.ok(createProc, 'should have CREATE PROCEDURE statement');
  assert.ok(createProc.includes('BEGIN'), 'CREATE PROCEDURE should contain BEGIN');
  assert.ok(createProc.includes('END'), 'CREATE PROCEDURE should contain END');

  // No statement should contain DELIMITER directive
  for (const stmt of stmts) {
    assert.ok(!stmt.match(/^DELIMITER/im), 'no statement should contain DELIMITER directive');
  }
});

// ---------------------------------------------------------------------------
// executeSqlFiles - mock pool
// ---------------------------------------------------------------------------

test('executeSqlFiles 按顺序读取并执行 SQL 文件', async () => {
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'sql-test-'));

  fs.writeFileSync(path.join(tmpDir, '002-second.sql'), 'SELECT 2;');
  fs.writeFileSync(path.join(tmpDir, '001-first.sql'), 'SELECT 1;');
  fs.writeFileSync(path.join(tmpDir, 'readme.txt'), 'not a sql file');

  const executed = [];
  const mockPool = {
    query: async (sql) => {
      executed.push(sql);
    },
  };

  await executeSqlFiles(mockPool, tmpDir);

  // Should only execute .sql files, in numeric order
  assert.ok(executed.length >= 2);
  const firstIdx = executed.findIndex((s) => s.includes('SELECT 1'));
  const secondIdx = executed.findIndex((s) => s.includes('SELECT 2'));
  assert.ok(firstIdx < secondIdx, 'first file should execute before second');

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('executeSqlFiles 忽略非 .sql 文件', async () => {
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'sql-test-'));

  fs.writeFileSync(path.join(tmpDir, 'readme.md'), '# README');
  fs.writeFileSync(path.join(tmpDir, '001-init.sql'), 'SELECT 1;');

  const executed = [];
  const mockPool = {
    query: async (sql) => {
      executed.push(sql);
    },
  };

  await executeSqlFiles(mockPool, tmpDir);

  // Should only have statements from the .sql file
  assert.ok(executed.every((s) => !s.includes('README')));

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('executeSqlFiles 传播 pool.query 错误', async () => {
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'sql-test-'));
  fs.writeFileSync(path.join(tmpDir, '001-bad.sql'), 'INVALID SQL;');

  const mockPool = {
    query: async () => {
      throw new Error('syntax error');
    },
  };

  await assert.rejects(() => executeSqlFiles(mockPool, tmpDir), { message: 'syntax error' });

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
