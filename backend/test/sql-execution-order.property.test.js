const test = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');
const { sortSqlFiles } = require('../scripts/init-mysql');

// ---------------------------------------------------------------------------
// Property 1: SQL 脚本文件按编号顺序执行
// **Validates: Requirements 1.5**
//
// 使用 fast-check 生成随机文件名集合，验证 sortSqlFiles 输出严格按数字前缀升序排列。
// ---------------------------------------------------------------------------

/**
 * Arbitrary: 生成带数字前缀的 SQL 文件名，格式为 "NNN-<word>.sql"
 * 数字前缀范围 0-999，名称部分为随机小写字母字符串。
 */
const sqlFileNameArb = fc.tuple(
  fc.integer({ min: 0, max: 999 }),
  fc.stringMatching(/^[a-z]{1,20}$/)
).map(([num, name]) => `${String(num).padStart(3, '0')}-${name}.sql`);

test('Property 1: sortSqlFiles 对任意随机 SQL 文件名集合，输出严格按数字前缀升序', () => {
  fc.assert(
    fc.property(
      fc.array(sqlFileNameArb, { minLength: 0, maxLength: 50 }),
      (fileNames) => {
        const sorted = sortSqlFiles(fileNames);

        // 长度守恒：排序不增不减元素
        assert.strictEqual(sorted.length, fileNames.length);

        // 严格升序：相邻元素的数字前缀满足 prev <= next
        for (let i = 1; i < sorted.length; i++) {
          const prevNum = parseInt(sorted[i - 1].match(/^(\d+)/)[1], 10);
          const currNum = parseInt(sorted[i].match(/^(\d+)/)[1], 10);
          assert.ok(
            prevNum <= currNum,
            `排序违反升序: "${sorted[i - 1]}" (${prevNum}) 应 <= "${sorted[i]}" (${currNum})`
          );
        }
      }
    ),
    { numRuns: 200 }
  );
});

test('Property 1 补充: sortSqlFiles 不修改原数组（纯函数性）', () => {
  fc.assert(
    fc.property(
      fc.array(sqlFileNameArb, { minLength: 0, maxLength: 30 }),
      (fileNames) => {
        const original = [...fileNames];
        sortSqlFiles(fileNames);
        assert.deepStrictEqual(fileNames, original);
      }
    ),
    { numRuns: 100 }
  );
});

test('Property 1 补充: sortSqlFiles 输出包含与输入完全相同的元素集合', () => {
  fc.assert(
    fc.property(
      fc.array(sqlFileNameArb, { minLength: 0, maxLength: 30 }),
      (fileNames) => {
        const sorted = sortSqlFiles(fileNames);
        // 排序后的元素集合应与输入完全一致（作为多重集）
        const inputSorted = [...fileNames].sort();
        const outputSorted = [...sorted].sort();
        assert.deepStrictEqual(outputSorted, inputSorted);
      }
    ),
    { numRuns: 100 }
  );
});
