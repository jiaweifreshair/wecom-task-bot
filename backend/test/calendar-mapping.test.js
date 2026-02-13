const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseUserCalendarMap,
  buildSyncCalendarTargets,
  resolveCalendarIdByUser,
} = require('../src/services/calendar-mapping');

test('parseUserCalendarMap 支持逗号分隔格式并去重', () => {
  const result = parseUserCalendarMap('zhangsan:cal-a, lisi:cal-b , zhangsan:cal-c');

  assert.deepEqual(result, [
    {
      user_id: 'zhangsan',
      cal_id: 'cal-c',
      source: 'env_map',
    },
    {
      user_id: 'lisi',
      cal_id: 'cal-b',
      source: 'env_map',
    },
  ]);
});

test('parseUserCalendarMap 支持 JSON 对象格式', () => {
  const result = parseUserCalendarMap('{"zhangsan":"cal-a","lisi":"cal-b"}');

  assert.deepEqual(result, [
    {
      user_id: 'zhangsan',
      cal_id: 'cal-a',
      source: 'env_map',
    },
    {
      user_id: 'lisi',
      cal_id: 'cal-b',
      source: 'env_map',
    },
  ]);
});

test('buildSyncCalendarTargets 优先员工映射并兼容默认日历回退', () => {
  const result = buildSyncCalendarTargets({
    defaultCalId: 'default-cal',
    userCalendarRows: [
      { user_id: 'zhangsan', cal_id: 'cal-a', source: 'db' },
      { user_id: 'lisi', cal_id: 'cal-b', source: 'db' },
    ],
  });

  assert.deepEqual(result, [
    {
      user_id: 'zhangsan',
      cal_id: 'cal-a',
      source: 'db',
    },
    {
      user_id: 'lisi',
      cal_id: 'cal-b',
      source: 'db',
    },
    {
      user_id: '',
      cal_id: 'default-cal',
      source: 'default',
    },
  ]);
});

test('buildSyncCalendarTargets 会按 cal_id 去重避免重复同步', () => {
  const result = buildSyncCalendarTargets({
    defaultCalId: 'cal-a',
    userCalendarRows: [
      { user_id: 'zhangsan', cal_id: 'cal-a', source: 'db' },
      { user_id: 'lisi', cal_id: 'cal-b', source: 'db' },
    ],
  });

  assert.deepEqual(result, [
    {
      user_id: 'zhangsan',
      cal_id: 'cal-a',
      source: 'db',
    },
    {
      user_id: 'lisi',
      cal_id: 'cal-b',
      source: 'db',
    },
  ]);
});

test('resolveCalendarIdByUser 缺失映射时回退默认日历', () => {
  const resolved = resolveCalendarIdByUser('wangwu', {
    defaultCalId: 'default-cal',
    userCalendarMapRaw: 'zhangsan:cal-a',
  });

  assert.equal(resolved, 'default-cal');
});
