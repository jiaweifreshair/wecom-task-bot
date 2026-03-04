const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseCliArgs,
  parseBooleanFlag,
  resolveScriptOptions,
  collectMissingEnvKeys,
  evaluateAcceptanceSummary,
  ensureWecomSuccess,
} = require('../scripts/verify-real-integration');

test('parseCliArgs 应解析键值参数与布尔开关', () => {
  const result = parseCliArgs([
    '--user-id',
    'zhangsan',
    '--user-name',
    '张三',
    '--skip-sync',
    '--json',
    'false',
  ]);

  assert.deepEqual(result, {
    'user-id': 'zhangsan',
    'user-name': '张三',
    'skip-sync': true,
    json: 'false',
  });
});

test('parseBooleanFlag 应兼容布尔与字符串值', () => {
  assert.equal(parseBooleanFlag(true, false), true);
  assert.equal(parseBooleanFlag('true', false), true);
  assert.equal(parseBooleanFlag('1', false), true);
  assert.equal(parseBooleanFlag('off', true), false);
  assert.equal(parseBooleanFlag('', true), true);
});

test('resolveScriptOptions 应优先使用命令行参数', () => {
  process.env.REAL_VERIFY_USER_ID = 'env-user';
  process.env.REAL_VERIFY_USER_NAME = '环境用户';

  const result = resolveScriptOptions([
    '--user-id',
    'cli-user',
    '--user-name',
    '命令行用户',
    '--skip-sync',
    '--skip-calendar-crud',
    '--json',
    'false',
  ]);

  assert.equal(result.userId, 'cli-user');
  assert.equal(result.userName, '命令行用户');
  assert.equal(result.skipSync, true);
  assert.equal(result.skipCalendarCrud, true);
  assert.equal(result.outputJson, false);
});

test('ensureWecomSuccess 应在 errcode 非 0 时抛错', () => {
  assert.throws(
    () =>
      ensureWecomSuccess('create_schedule', {
        errcode: 48002,
        errmsg: 'api forbidden',
      }),
    /create_schedule失败/
  );
});

test('collectMissingEnvKeys 应返回缺失配置列表', () => {
  const missingKeys = collectMissingEnvKeys({
    CORP_ID: 'corp-id',
    CORP_SECRET: '',
    AGENT_ID: undefined,
  });

  assert.deepEqual(missingKeys, ['CORP_SECRET', 'AGENT_ID']);
});

test('evaluateAcceptanceSummary 应在失败步骤存在时返回 FAIL', () => {
  const result = evaluateAcceptanceSummary([
    { name: 'env_check', status: 'PASS' },
    { name: 'wecom_token', status: 'FAIL' },
  ]);

  assert.equal(result.overall, 'FAIL');
  assert.match(result.reason, /wecom_token/);
});

test('evaluateAcceptanceSummary 在跳过同步且无失败步骤时返回 PASS', () => {
  const result = evaluateAcceptanceSummary(
    [{ name: 'env_check', status: 'PASS' }],
    {
      skipSync: true,
      syncResult: null,
    }
  );

  assert.equal(result.overall, 'PASS');
});

test('evaluateAcceptanceSummary 在同步成功且命中日历时返回 PASS', () => {
  const result = evaluateAcceptanceSummary(
    [{ name: 'env_check', status: 'PASS' }],
    {
      skipSync: false,
      syncResult: {
        success: true,
        calendar_success_count: 1,
      },
    }
  );

  assert.equal(result.overall, 'PASS');
  assert.equal(result.reason, '真实接口联调通过');
});
