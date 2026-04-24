const test = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

// ---------------------------------------------------------------------------
// 纯函数移植自 frontend/utils/display.ts
// computePaginationTotal 确保分页总数标注与实际长度一致。
// ---------------------------------------------------------------------------

/**
 * computePaginationTotal
 * 是什么：分页总数计算函数。
 * 做什么：确保分页总数标注与实际列表长度一致。
 * 为什么：需求 10.12 要求分页总数准确。
 */
function computePaginationTotal(filteredLength, serverTotal) {
  if (typeof serverTotal === 'number' && serverTotal >= 0) {
    return serverTotal;
  }
  return filteredLength;
}

// ---------------------------------------------------------------------------
// 分页辅助：模拟前端分页逻辑
// ---------------------------------------------------------------------------

/**
 * computeTotalPages
 * 是什么：总页数计算函数。
 * 做什么：根据总条数和每页大小计算总页数。
 */
function computeTotalPages(total, pageSize) {
  if (pageSize <= 0) {
    return 1;
  }
  return Math.max(1, Math.ceil(total / pageSize));
}

/**
 * computePageSlice
 * 是什么：分页切片计算函数。
 * 做什么：根据页码和每页大小计算当前页的起止索引。
 */
function computePageSlice(page, pageSize, total) {
  const start = (page - 1) * pageSize;
  const end = Math.min(start + pageSize, total);
  return { start, end };
}

// ---------------------------------------------------------------------------
// Property 16: 分页总数一致性
// **Validates: Requirements 10.12**
//
// 使用 fast-check 生成随机列表长度和分页参数，验证总数标注与实际长度一致。
// ---------------------------------------------------------------------------

test('Property 16.1: computePaginationTotal 在无服务端总数时返回本地过滤长度', () => {
  fc.assert(
    fc.property(
      fc.nat({ max: 10000 }),
      (filteredLength) => {
        const result = computePaginationTotal(filteredLength, undefined);
        assert.strictEqual(
          result,
          filteredLength,
          `无服务端总数时应返回 ${filteredLength}，实际返回 ${result}`
        );
      }
    ),
    { numRuns: 500 }
  );
});

test('Property 16.2: computePaginationTotal 在有服务端总数时返回服务端值', () => {
  fc.assert(
    fc.property(
      fc.nat({ max: 10000 }),
      fc.nat({ max: 10000 }),
      (filteredLength, serverTotal) => {
        const result = computePaginationTotal(filteredLength, serverTotal);
        assert.strictEqual(
          result,
          serverTotal,
          `有服务端总数时应返回 ${serverTotal}，实际返回 ${result}`
        );
      }
    ),
    { numRuns: 500 }
  );
});

test('Property 16.3: 分页总页数与总条数一致', () => {
  fc.assert(
    fc.property(
      fc.nat({ max: 5000 }),
      fc.integer({ min: 1, max: 100 }),
      (total, pageSize) => {
        const totalPages = computeTotalPages(total, pageSize);
        // 总页数 * 每页大小 >= 总条数
        assert.ok(
          totalPages * pageSize >= total,
          `totalPages(${totalPages}) * pageSize(${pageSize}) 应 >= total(${total})`
        );
        // (总页数 - 1) * 每页大小 < 总条数（除非总条数为 0）
        if (total > 0) {
          assert.ok(
            (totalPages - 1) * pageSize < total,
            `(totalPages-1)(${totalPages - 1}) * pageSize(${pageSize}) 应 < total(${total})`
          );
        }
      }
    ),
    { numRuns: 500 }
  );
});

test('Property 16.4: 所有分页切片覆盖完整列表且不重叠', () => {
  fc.assert(
    fc.property(
      fc.nat({ max: 500 }),
      fc.integer({ min: 1, max: 50 }),
      (total, pageSize) => {
        const totalPages = computeTotalPages(total, pageSize);
        let coveredCount = 0;

        for (let page = 1; page <= totalPages; page++) {
          const { start, end } = computePageSlice(page, pageSize, total);
          assert.ok(start >= 0, `start 应 >= 0，page=${page}`);
          assert.ok(end <= total, `end 应 <= total，page=${page}`);
          assert.ok(start <= end, `start 应 <= end，page=${page}`);
          coveredCount += end - start;
        }

        assert.strictEqual(
          coveredCount,
          total,
          `所有分页切片覆盖的条目数 (${coveredCount}) 应等于 total (${total})`
        );
      }
    ),
    { numRuns: 300 }
  );
});

test('Property 16.5: computePaginationTotal 返回值始终为非负整数', () => {
  fc.assert(
    fc.property(
      fc.nat({ max: 10000 }),
      fc.option(fc.nat({ max: 10000 }), { nil: undefined }),
      (filteredLength, serverTotal) => {
        const result = computePaginationTotal(filteredLength, serverTotal);
        assert.ok(typeof result === 'number', '返回值应为数字');
        assert.ok(result >= 0, '返回值应 >= 0');
        assert.ok(Number.isInteger(result), '返回值应为整数');
      }
    ),
    { numRuns: 500 }
  );
});
