const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveTaskQueryScope } = require('../src/services/task-scope');

test('全局验收人默认应使用团队视角', () => {
  const result = resolveTaskQueryScope({
    currentUserId: 'manager-a',
    globalVerifiers: ['manager-a', 'manager-b'],
    requestedScope: '',
  });

  assert.equal(result.restrictToCurrentUser, false);
  assert.equal(result.resolvedScope, 'TEAM');
});

test('普通成员默认应仅查看本人相关任务', () => {
  const result = resolveTaskQueryScope({
    currentUserId: 'executor-a',
    globalVerifiers: ['manager-a', 'manager-b'],
    requestedScope: '',
  });

  assert.equal(result.restrictToCurrentUser, true);
  assert.equal(result.resolvedScope, 'SELF');
});

test('全局验收人显式请求 SELF 时应降级为个人视角', () => {
  const result = resolveTaskQueryScope({
    currentUserId: 'manager-a',
    globalVerifiers: ['manager-a', 'manager-b'],
    requestedScope: 'SELF',
  });

  assert.equal(result.restrictToCurrentUser, true);
  assert.equal(result.resolvedScope, 'SELF');
});

test('未配置全局验收人时默认允许团队视角', () => {
  const result = resolveTaskQueryScope({
    currentUserId: 'executor-a',
    globalVerifiers: [],
    requestedScope: '',
  });

  assert.equal(result.restrictToCurrentUser, false);
  assert.equal(result.resolvedScope, 'TEAM');
});

test('普通成员显式请求 TEAM 但存在验收人配置时仍应保持个人视角', () => {
  const result = resolveTaskQueryScope({
    currentUserId: 'executor-a',
    globalVerifiers: ['manager-a', 'manager-b'],
    requestedScope: 'TEAM',
  });

  assert.equal(result.restrictToCurrentUser, true);
  assert.equal(result.resolvedScope, 'SELF');
});
