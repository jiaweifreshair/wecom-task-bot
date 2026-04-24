const test = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');
const { buildMysqlConnectionConfig } = require('../src/models/db-dialect');

// ---------------------------------------------------------------------------
// Property 3: MySQL 连接配置从环境变量正确构建
// **Validates: Requirements 2.1, 2.4**
//
// 使用 fast-check 生成随机环境变量组合，验证 buildMysqlConnectionConfig
// 输出字段与输入一致，缺失时回退默认值。
// ---------------------------------------------------------------------------

const DEFAULTS = {
  host: '127.0.0.1',
  port: 3306,
  user: 'root',
  password: '',
  database: 'wecom_task_bot',
  connectionLimit: 10,
  charset: 'utf8mb4',
};

const REQUIRED_FIELDS = [
  'host', 'port', 'user', 'password', 'database',
  'connectionLimit', 'waitForConnections', 'queueLimit',
  'charset', 'timezone', 'dateStrings',
];

/**
 * Arbitrary: 生成非空可打印字符串（模拟合法环境变量值）
 */
const envValueArb = fc.stringMatching(/^[A-Za-z0-9._\-]{1,30}$/);

/**
 * Arbitrary: 生成合法端口号字符串
 */
const validPortArb = fc.integer({ min: 1, max: 65535 }).map(String);

test('Property 3a: 提供环境变量时，config 字段与输入值一致', () => {
  fc.assert(
    fc.property(
      envValueArb,
      validPortArb,
      envValueArb,
      fc.string({ minLength: 0, maxLength: 30 }),
      envValueArb,
      (host, port, user, password, dbName) => {
        const env = {
          TASK_BOT_DB_HOST: host,
          TASK_BOT_DB_PORT: port,
          TASK_BOT_DB_USER: user,
          TASK_BOT_DB_PASSWORD: password,
          TASK_BOT_DB_NAME: dbName,
        };

        const config = buildMysqlConnectionConfig(env);

        assert.strictEqual(config.host, host.trim());
        assert.strictEqual(config.port, Number(port));
        assert.strictEqual(config.user, user.trim());
        assert.strictEqual(config.password, password.trim());
        assert.strictEqual(config.database, dbName.trim());
      }
    ),
    { numRuns: 200 }
  );
});

test('Property 3b: 缺失环境变量时，config 回退到默认值', () => {
  fc.assert(
    fc.property(
      fc.record({
        TASK_BOT_DB_HOST: fc.option(envValueArb, { nil: undefined }),
        TASK_BOT_DB_PORT: fc.option(validPortArb, { nil: undefined }),
        TASK_BOT_DB_USER: fc.option(envValueArb, { nil: undefined }),
        TASK_BOT_DB_PASSWORD: fc.option(fc.string({ minLength: 0, maxLength: 20 }), { nil: undefined }),
        TASK_BOT_DB_NAME: fc.option(envValueArb, { nil: undefined }),
      }),
      (env) => {
        const config = buildMysqlConnectionConfig(env);

        if (env.TASK_BOT_DB_HOST === undefined) {
          assert.strictEqual(config.host, DEFAULTS.host);
        }
        if (env.TASK_BOT_DB_PORT === undefined) {
          assert.strictEqual(config.port, DEFAULTS.port);
        }
        if (env.TASK_BOT_DB_USER === undefined) {
          assert.strictEqual(config.user, DEFAULTS.user);
        }
        if (env.TASK_BOT_DB_PASSWORD === undefined) {
          assert.strictEqual(config.password, DEFAULTS.password);
        }
        if (env.TASK_BOT_DB_NAME === undefined) {
          assert.strictEqual(config.database, DEFAULTS.database);
        }
      }
    ),
    { numRuns: 200 }
  );
});

test('Property 3c: port 始终为正整数', () => {
  fc.assert(
    fc.property(
      fc.oneof(
        fc.constant(undefined),
        fc.constant(''),
        fc.constant('abc'),
        fc.constant('-1'),
        fc.constant('0'),
        fc.constant('3.14'),
        fc.constant('99999'),
        validPortArb,
        fc.string({ minLength: 0, maxLength: 10 })
      ),
      (portValue) => {
        const env = portValue !== undefined ? { TASK_BOT_DB_PORT: portValue } : {};
        const config = buildMysqlConnectionConfig(env);

        assert.ok(Number.isInteger(config.port), `port 应为整数，实际: ${config.port}`);
        assert.ok(config.port > 0, `port 应为正数，实际: ${config.port}`);
      }
    ),
    { numRuns: 200 }
  );
});

test('Property 3d: 输出始终包含全部必需字段', () => {
  fc.assert(
    fc.property(
      fc.record({
        TASK_BOT_DB_HOST: fc.option(envValueArb, { nil: undefined }),
        TASK_BOT_DB_PORT: fc.option(fc.string({ minLength: 0, maxLength: 10 }), { nil: undefined }),
        TASK_BOT_DB_USER: fc.option(envValueArb, { nil: undefined }),
        TASK_BOT_DB_PASSWORD: fc.option(fc.string({ minLength: 0, maxLength: 20 }), { nil: undefined }),
        TASK_BOT_DB_NAME: fc.option(envValueArb, { nil: undefined }),
      }),
      (env) => {
        const config = buildMysqlConnectionConfig(env);

        for (const field of REQUIRED_FIELDS) {
          assert.ok(
            field in config,
            `缺少必需字段: ${field}`
          );
          assert.ok(
            config[field] !== undefined && config[field] !== null,
            `字段 ${field} 不应为 null/undefined`
          );
        }

        // 固定字段值验证
        assert.strictEqual(config.connectionLimit, 10);
        assert.strictEqual(config.charset, 'utf8mb4');
        assert.strictEqual(config.waitForConnections, true);
        assert.strictEqual(config.queueLimit, 0);
        assert.strictEqual(config.timezone, 'Z');
        assert.strictEqual(config.dateStrings, true);
      }
    ),
    { numRuns: 200 }
  );
});
