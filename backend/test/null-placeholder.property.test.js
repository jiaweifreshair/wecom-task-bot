const test = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

// ---------------------------------------------------------------------------
// 纯函数移植自 frontend/utils/display.ts
// normalizeText 将 null/undefined/空字符串转换为占位文本。
// ---------------------------------------------------------------------------

/**
 * normalizeText
 * 是什么：空值防护文本归一化函数。
 * 做什么：将 null/undefined/空字符串转换为占位文本，禁止展示 'null'/'undefined'/空白。
 * 为什么：需求 10.10 要求展示明确占位文本。
 */
function normalizeText(value, placeholder) {
  if (placeholder === undefined) {
    placeholder = '未设置';
  }
  if (value === null || value === undefined) {
    return placeholder;
  }
  const trimmed = String(value).trim();
  if (trimmed === '' || trimmed === 'null' || trimmed === 'undefined' || trimmed === 'NaN') {
    return placeholder;
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// Property 15: 空值占位文本防护
// **Validates: Requirements 10.10**
//
// 使用 fast-check 生成 null/undefined/空字符串输入，
// 验证 normalizeText 返回占位文本而非 'null'/'undefined'。
// ---------------------------------------------------------------------------

test('Property 15.1: normalizeText 对 null/undefined/空字符串返回占位文本', () => {
  const emptyInputArb = fc.constantFrom(null, undefined, '', '  ', '\t', '\n', '   \n  ');

  fc.assert(
    fc.property(emptyInputArb, (input) => {
      const result = normalizeText(input);
      assert.strictEqual(
        result,
        '未设置',
        `normalizeText(${JSON.stringify(input)}) 应返回 "未设置"，实际返回 "${result}"`
      );
    }),
    { numRuns: 200 }
  );
});

test('Property 15.2: normalizeText 输出永远不包含字面量 "null" 或 "undefined"', () => {
  const problematicInputArb = fc.oneof(
    fc.constant(null),
    fc.constant(undefined),
    fc.constant(''),
    fc.constant('null'),
    fc.constant('undefined'),
    fc.constant('NaN'),
    fc.constant('  null  '),
    fc.constant('  undefined  '),
    fc.constant('  NaN  '),
    fc.string({ maxLength: 50 })
  );

  fc.assert(
    fc.property(problematicInputArb, (input) => {
      const result = normalizeText(input);
      assert.ok(
        result !== 'null',
        `normalizeText(${JSON.stringify(input)}) 不应返回字面量 "null"，实际返回 "${result}"`
      );
      assert.ok(
        result !== 'undefined',
        `normalizeText(${JSON.stringify(input)}) 不应返回字面量 "undefined"，实际返回 "${result}"`
      );
      assert.ok(
        result !== 'NaN',
        `normalizeText(${JSON.stringify(input)}) 不应返回字面量 "NaN"，实际返回 "${result}"`
      );
    }),
    { numRuns: 500 }
  );
});

test('Property 15.3: normalizeText 输出始终为非空字符串', () => {
  const anyInputArb = fc.oneof(
    fc.constant(null),
    fc.constant(undefined),
    fc.constant(''),
    fc.string({ maxLength: 100 })
  );

  fc.assert(
    fc.property(anyInputArb, (input) => {
      const result = normalizeText(input);
      assert.ok(typeof result === 'string', '输出应为字符串');
      assert.ok(result.length > 0, '输出不应为空字符串');
    }),
    { numRuns: 500 }
  );
});

test('Property 15.4: normalizeText 对有效非空字符串返回原值（去除首尾空白）', () => {
  // 生成非空、非 null/undefined/NaN 字面量的字符串
  const validStringArb = fc
    .string({ minLength: 1, maxLength: 100 })
    .filter((s) => {
      const trimmed = s.trim();
      return (
        trimmed.length > 0 &&
        trimmed !== 'null' &&
        trimmed !== 'undefined' &&
        trimmed !== 'NaN'
      );
    });

  fc.assert(
    fc.property(validStringArb, (input) => {
      const result = normalizeText(input);
      assert.strictEqual(
        result,
        input.trim(),
        `normalizeText("${input}") 应返回 "${input.trim()}"，实际返回 "${result}"`
      );
    }),
    { numRuns: 300 }
  );
});

test('Property 15.5: normalizeText 支持自定义占位文本', () => {
  const emptyInputArb = fc.constantFrom(null, undefined, '', '  ');
  const placeholderArb = fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0);

  fc.assert(
    fc.property(emptyInputArb, placeholderArb, (input, placeholder) => {
      const result = normalizeText(input, placeholder);
      assert.strictEqual(
        result,
        placeholder,
        `normalizeText(${JSON.stringify(input)}, "${placeholder}") 应返回 "${placeholder}"，实际返回 "${result}"`
      );
    }),
    { numRuns: 200 }
  );
});
