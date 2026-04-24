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
  REMINDER_KIND,
  shouldSendReminder,
} = require('../src/services/task-lifecycle');

// 恢复原始 _resolveFilename
Module._resolveFilename = originalResolveFilename;

// ---------------------------------------------------------------------------
// Property 11: 提醒冷却期控制
// **Validates: Requirements 6.3**
//
// 使用 fast-check 生成随机提醒历史和时间间隔，验证 shouldSendReminder 冷却期判定正确：
//   - null 任务或 NONE 类型 → false
//   - 无同类型历史提醒（不同 kind 或无 last_reminder_kind）→ true
//   - 无 last_reminder_at → true
//   - 经过时间 >= cooldownHours * 3600000 → true
//   - 经过时间 < cooldownHours * 3600000 → false
// ---------------------------------------------------------------------------

const MS_PER_HOUR = 60 * 60 * 1000;

/** Arbitrary: 基准时间 (2025-01-01 ~ 2027-01-01 范围内的毫秒时间戳) */
const nowArb = fc.integer({ min: Date.parse('2025-01-01T00:00:00Z'), max: Date.parse('2027-01-01T00:00:00Z') })
  .map((ms) => new Date(ms));

/** Arbitrary: 非 NONE 的提醒类型 */
const activeReminderKindArb = fc.constantFrom(REMINDER_KIND.DUE_SOON, REMINDER_KIND.OVERDUE);

/** Arbitrary: 冷却小时数 (1 ~ 48) */
const cooldownHoursArb = fc.integer({ min: 1, max: 48 });

// ---------------------------------------------------------------------------
// 11.1: null/undefined 任务 → false
// ---------------------------------------------------------------------------
test('Property 11.1: null 或 undefined 任务始终返回 false', () => {
  fc.assert(
    fc.property(activeReminderKindArb, nowArb, (kind, now) => {
      assert.equal(shouldSendReminder(null, kind, now), false);
      assert.equal(shouldSendReminder(undefined, kind, now), false);
    }),
    { numRuns: 100 }
  );
});

// ---------------------------------------------------------------------------
// 11.2: reminderKind 为 NONE → false
// ---------------------------------------------------------------------------
test('Property 11.2: reminderKind 为 NONE 时始终返回 false', () => {
  fc.assert(
    fc.property(nowArb, (now) => {
      const task = { last_reminder_kind: 'DUE_SOON', last_reminder_at: now.toISOString() };
      assert.equal(shouldSendReminder(task, REMINDER_KIND.NONE, now), false);
    }),
    { numRuns: 100 }
  );
});

// ---------------------------------------------------------------------------
// 11.3: 无同类型历史提醒（不同 kind）→ true
// ---------------------------------------------------------------------------
test('Property 11.3: 上次提醒类型与当前不同时返回 true', () => {
  fc.assert(
    fc.property(activeReminderKindArb, nowArb, cooldownHoursArb, (kind, now, cooldown) => {
      const otherKind = kind === REMINDER_KIND.DUE_SOON ? REMINDER_KIND.OVERDUE : REMINDER_KIND.DUE_SOON;
      const task = {
        last_reminder_kind: otherKind,
        last_reminder_at: now.toISOString(), // 即使刚发过，类型不同也应发送
      };
      assert.equal(shouldSendReminder(task, kind, now, cooldown), true);
    }),
    { numRuns: 200 }
  );
});

// ---------------------------------------------------------------------------
// 11.4: 无 last_reminder_kind → true
// ---------------------------------------------------------------------------
test('Property 11.4: 无 last_reminder_kind 时返回 true', () => {
  fc.assert(
    fc.property(
      activeReminderKindArb,
      nowArb,
      fc.constantFrom(null, undefined, ''),
      (kind, now, emptyKind) => {
        const task = { last_reminder_kind: emptyKind, last_reminder_at: now.toISOString() };
        assert.equal(shouldSendReminder(task, kind, now), true);
      }
    ),
    { numRuns: 200 }
  );
});

// ---------------------------------------------------------------------------
// 11.5: 同类型但无 last_reminder_at → true
// ---------------------------------------------------------------------------
test('Property 11.5: 同类型但无 last_reminder_at 时返回 true', () => {
  fc.assert(
    fc.property(
      activeReminderKindArb,
      nowArb,
      fc.constantFrom(null, undefined, '', 'not-a-date'),
      (kind, now, invalidAt) => {
        const task = { last_reminder_kind: kind, last_reminder_at: invalidAt };
        assert.equal(shouldSendReminder(task, kind, now), true);
      }
    ),
    { numRuns: 200 }
  );
});

// ---------------------------------------------------------------------------
// 11.6: 同类型且经过时间 >= cooldownHours → true
// **Validates: Requirements 6.3**
// ---------------------------------------------------------------------------
test('Property 11.6: 冷却期已过时返回 true', () => {
  fc.assert(
    fc.property(
      activeReminderKindArb,
      nowArb,
      cooldownHoursArb,
      fc.integer({ min: 0, max: 720 }), // 额外经过的小时数
      (kind, baseNow, cooldown, extraHours) => {
        const lastAt = baseNow;
        const elapsedMs = cooldown * MS_PER_HOUR + extraHours * MS_PER_HOUR;
        const now = new Date(lastAt.getTime() + elapsedMs);
        const task = { last_reminder_kind: kind, last_reminder_at: lastAt.toISOString() };
        assert.equal(shouldSendReminder(task, kind, now, cooldown), true);
      }
    ),
    { numRuns: 300 }
  );
});

// ---------------------------------------------------------------------------
// 11.7: 同类型且经过时间 < cooldownHours → false
// **Validates: Requirements 6.3**
// ---------------------------------------------------------------------------
test('Property 11.7: 冷却期内返回 false', () => {
  fc.assert(
    fc.property(
      activeReminderKindArb,
      nowArb,
      cooldownHoursArb,
      (kind, baseNow, cooldown) => {
        // 经过时间为 0 到 cooldown-1 毫秒之间（严格小于冷却期）
        const maxElapsedMs = cooldown * MS_PER_HOUR - 1;
        return fc.assert(
          fc.property(
            fc.integer({ min: 0, max: Math.max(0, maxElapsedMs) }),
            (elapsedMs) => {
              const lastAt = baseNow;
              const now = new Date(lastAt.getTime() + elapsedMs);
              const task = { last_reminder_kind: kind, last_reminder_at: lastAt.toISOString() };
              assert.equal(shouldSendReminder(task, kind, now, cooldown), false);
            }
          ),
          { numRuns: 10 }
        );
      }
    ),
    { numRuns: 100 }
  );
});

// ---------------------------------------------------------------------------
// 11.8: 返回值始终为布尔值
// ---------------------------------------------------------------------------
test('Property 11.8: shouldSendReminder 返回值始终为布尔值', () => {
  const taskArb = fc.oneof(
    fc.constant(null),
    fc.constant(undefined),
    fc.record({
      last_reminder_kind: fc.oneof(
        fc.constant(null),
        fc.constant(''),
        fc.constantFrom(REMINDER_KIND.DUE_SOON, REMINDER_KIND.OVERDUE, REMINDER_KIND.NONE)
      ),
      last_reminder_at: fc.oneof(
        fc.constant(null),
        fc.constant(''),
        fc.constant('invalid'),
        fc.date({ min: new Date('2024-01-01'), max: new Date('2028-01-01') }).map((d) => d.toISOString())
      ),
    })
  );

  const kindArb = fc.constantFrom(REMINDER_KIND.NONE, REMINDER_KIND.DUE_SOON, REMINDER_KIND.OVERDUE);

  fc.assert(
    fc.property(taskArb, kindArb, nowArb, cooldownHoursArb, (task, kind, now, cooldown) => {
      const result = shouldSendReminder(task, kind, now, cooldown);
      assert.equal(typeof result, 'boolean', `返回值 "${result}" 不是布尔值`);
    }),
    { numRuns: 500 }
  );
});
