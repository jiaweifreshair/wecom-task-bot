const test = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

// ---------------------------------------------------------------------------
// 纯函数移植自 frontend/utils/display.ts
// mapTaskStatus 是恒等映射，直接返回后端 status 字段值。
// ---------------------------------------------------------------------------

const VALID_TASK_STATUSES = ['PENDING', 'WAITING_VERIFY', 'COMPLETED', 'REJECTED'];

/**
 * mapTaskStatus
 * 是什么：任务状态恒等映射函数。
 * 做什么：直接返回后端 status 字段值，禁止前端推断或硬编码映射。
 * 为什么：需求 10.1 要求直接使用后端返回的 status 字段。
 */
function mapTaskStatus(status) {
  return status;
}

// ---------------------------------------------------------------------------
// Property 13: 任务状态映射恒等性
// **Validates: Requirements 10.1**
//
// 使用 fast-check 从合法状态值中随机选取，验证 mapTaskStatus 输出与输入相等。
// ---------------------------------------------------------------------------

test('Property 13.1: mapTaskStatus 对合法状态值返回恒等结果', () => {
  const validStatusArb = fc.constantFrom(...VALID_TASK_STATUSES);

  fc.assert(
    fc.property(validStatusArb, (status) => {
      const result = mapTaskStatus(status);
      assert.strictEqual(
        result,
        status,
        `mapTaskStatus("${status}") 应返回 "${status}"，实际返回 "${result}"`
      );
    }),
    { numRuns: 200 }
  );
});

test('Property 13.2: mapTaskStatus 输出类型始终为字符串', () => {
  const validStatusArb = fc.constantFrom(...VALID_TASK_STATUSES);

  fc.assert(
    fc.property(validStatusArb, (status) => {
      const result = mapTaskStatus(status);
      assert.strictEqual(typeof result, 'string', '输出应为字符串类型');
    }),
    { numRuns: 200 }
  );
});

test('Property 13.3: mapTaskStatus 输出始终在合法状态集合内', () => {
  const validStatusArb = fc.constantFrom(...VALID_TASK_STATUSES);

  fc.assert(
    fc.property(validStatusArb, (status) => {
      const result = mapTaskStatus(status);
      assert.ok(
        VALID_TASK_STATUSES.includes(result),
        `输出 "${result}" 不在合法状态集合 [${VALID_TASK_STATUSES.join(', ')}] 内`
      );
    }),
    { numRuns: 200 }
  );
});

test('Property 13.4: mapTaskStatus 是幂等的（多次调用结果不变）', () => {
  const validStatusArb = fc.constantFrom(...VALID_TASK_STATUSES);

  fc.assert(
    fc.property(validStatusArb, (status) => {
      const first = mapTaskStatus(status);
      const second = mapTaskStatus(first);
      assert.strictEqual(first, second, '多次调用 mapTaskStatus 结果应一致');
    }),
    { numRuns: 200 }
  );
});
