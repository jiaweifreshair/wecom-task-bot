const test = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

// platform-access.js 顶层 require('../models/db') 会触发 sqlite3/mysql native 模块加载。
// 在未编译 native 绑定的环境中，提前注入一个空的 db stub 避免加载失败。
const Module = require('node:module');
const originalResolveFilename = Module._resolveFilename;
const dbStub = { all: () => {}, get: () => {}, run: () => {} };
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === '../models/db' && parent && parent.filename && parent.filename.includes('platform-access')) {
    return '__db_stub__';
  }
  return originalResolveFilename.call(this, request, parent, ...rest);
};
require.cache.__db_stub__ = { id: '__db_stub__', filename: '__db_stub__', loaded: true, exports: dbStub };

const {
  TASK_STATUS,
  REMINDER_KIND,
  getReminderKind,
} = require('../src/services/task-lifecycle');

// 恢复原始 _resolveFilename
Module._resolveFilename = originalResolveFilename;

// ---------------------------------------------------------------------------
// Property 10: 任务提醒类型分类
// **Validates: Requirements 6.1, 6.2, 10.9**
//
// 使用 fast-check 生成随机任务状态和时间组合，验证 getReminderKind 返回值符合规则：
//   - null/非 PENDING 状态/无截止时间 → NONE
//   - 截止时间已过 → OVERDUE
//   - 截止时间在 24 小时内 → DUE_SOON
//   - 截止时间超过 24 小时 → NONE
// ---------------------------------------------------------------------------

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_24H = 24 * MS_PER_HOUR;

/** Arbitrary: 基准时间 (2025-01-01 ~ 2027-01-01 范围内的毫秒时间戳) */
const nowArb = fc.integer({ min: Date.parse('2025-01-01T00:00:00Z'), max: Date.parse('2027-01-01T00:00:00Z') })
  .map((ms) => new Date(ms));

/** Arbitrary: 非 PENDING 的任务状态 */
const nonPendingStatusArb = fc.constantFrom(
  TASK_STATUS.WAITING_VERIFY,
  TASK_STATUS.COMPLETED,
  'CANCELLED',
  'UNKNOWN',
  ''
);

/** Arbitrary: 无效的 end_time 值 */
const invalidEndTimeArb = fc.constantFrom(null, undefined, '', 'not-a-date', 'abc123');

// ---------------------------------------------------------------------------
// 10.1: null 或 undefined 任务 → NONE
// ---------------------------------------------------------------------------
test('Property 10.1: null 或 undefined 任务始终返回 NONE', () => {
  fc.assert(
    fc.property(nowArb, (now) => {
      assert.equal(getReminderKind(null, now), REMINDER_KIND.NONE);
      assert.equal(getReminderKind(undefined, now), REMINDER_KIND.NONE);
    }),
    { numRuns: 100 }
  );
});

// ---------------------------------------------------------------------------
// 10.2: 非 PENDING 状态 → NONE（无论截止时间如何）
// ---------------------------------------------------------------------------
test('Property 10.2: 非 PENDING 状态的任务始终返回 NONE', () => {
  fc.assert(
    fc.property(
      nonPendingStatusArb,
      nowArb,
      fc.integer({ min: -48, max: 48 }),
      (status, now, offsetHours) => {
        const endTime = new Date(now.getTime() + offsetHours * MS_PER_HOUR);
        const task = { status, end_time: endTime.toISOString() };
        assert.equal(getReminderKind(task, now), REMINDER_KIND.NONE);
      }
    ),
    { numRuns: 300 }
  );
});

// ---------------------------------------------------------------------------
// 10.3: PENDING 状态但无有效截止时间 → NONE
// ---------------------------------------------------------------------------
test('Property 10.3: PENDING 状态但无有效截止时间返回 NONE', () => {
  fc.assert(
    fc.property(invalidEndTimeArb, nowArb, (endTime, now) => {
      const task = { status: TASK_STATUS.PENDING, end_time: endTime };
      assert.equal(getReminderKind(task, now), REMINDER_KIND.NONE);
    }),
    { numRuns: 200 }
  );
});

// ---------------------------------------------------------------------------
// 10.4: 截止时间已过（end_time < now）→ OVERDUE
// **Validates: Requirements 6.2**
// ---------------------------------------------------------------------------
test('Property 10.4: PENDING 任务截止时间已过返回 OVERDUE', () => {
  fc.assert(
    fc.property(
      nowArb,
      fc.integer({ min: 1, max: 720 }),
      (now, pastHours) => {
        const endTime = new Date(now.getTime() - pastHours * MS_PER_HOUR);
        const task = { status: TASK_STATUS.PENDING, end_time: endTime.toISOString() };
        assert.equal(getReminderKind(task, now), REMINDER_KIND.OVERDUE);
      }
    ),
    { numRuns: 300 }
  );
});

// ---------------------------------------------------------------------------
// 10.5: 截止时间在 24 小时内（0 <= diff <= 24h）→ DUE_SOON
// **Validates: Requirements 6.1**
// ---------------------------------------------------------------------------
test('Property 10.5: PENDING 任务截止时间在 24 小时内返回 DUE_SOON', () => {
  fc.assert(
    fc.property(
      nowArb,
      fc.integer({ min: 0, max: MS_24H }),
      (now, diffMs) => {
        const endTime = new Date(now.getTime() + diffMs);
        const task = { status: TASK_STATUS.PENDING, end_time: endTime.toISOString() };
        assert.equal(getReminderKind(task, now), REMINDER_KIND.DUE_SOON);
      }
    ),
    { numRuns: 300 }
  );
});

// ---------------------------------------------------------------------------
// 10.6: 截止时间超过 24 小时 → NONE
// ---------------------------------------------------------------------------
test('Property 10.6: PENDING 任务截止时间超过 24 小时返回 NONE', () => {
  fc.assert(
    fc.property(
      nowArb,
      fc.integer({ min: 1, max: 720 }),
      (now, extraHours) => {
        const endTime = new Date(now.getTime() + MS_24H + extraHours * MS_PER_HOUR);
        const task = { status: TASK_STATUS.PENDING, end_time: endTime.toISOString() };
        assert.equal(getReminderKind(task, now), REMINDER_KIND.NONE);
      }
    ),
    { numRuns: 300 }
  );
});

// ---------------------------------------------------------------------------
// 10.7: 返回值始终为 REMINDER_KIND 枚举值之一
// ---------------------------------------------------------------------------
test('Property 10.7: getReminderKind 返回值始终为合法枚举值', () => {
  const VALID_KINDS = new Set(Object.values(REMINDER_KIND));

  const taskArb = fc.oneof(
    fc.constant(null),
    fc.constant(undefined),
    fc.record({
      status: fc.constantFrom(TASK_STATUS.PENDING, TASK_STATUS.COMPLETED, TASK_STATUS.WAITING_VERIFY, '', 'UNKNOWN'),
      end_time: fc.oneof(
        fc.constant(null),
        fc.constant(''),
        fc.constant('invalid'),
        fc.date({ min: new Date('2024-01-01'), max: new Date('2028-01-01') }).map((d) => d.toISOString()),
      ),
    })
  );

  fc.assert(
    fc.property(taskArb, nowArb, (task, now) => {
      const result = getReminderKind(task, now);
      assert.ok(VALID_KINDS.has(result), `返回值 "${result}" 不在合法枚举值内`);
    }),
    { numRuns: 500 }
  );
});
