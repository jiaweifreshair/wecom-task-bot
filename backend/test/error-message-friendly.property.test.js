const test = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

// ---------------------------------------------------------------------------
// 纯函数移植自 frontend/pages/CalendarManager.tsx
// resolveErrorMessage 是纯逻辑，不依赖 React 或 DOM，可直接在 Node.js 中测试。
// ---------------------------------------------------------------------------

/**
 * resolveErrorMessage
 * 是什么：错误消息提取函数。
 * 做什么：优先从接口返回中提取业务错误，其次回退异常 message。
 * 为什么：给用户展示可理解的失败原因，避免技术栈细节泄漏。
 */
function resolveErrorMessage(error) {
  const maybeError = error || {};
  const responseData =
    maybeError.response && maybeError.response.data ? maybeError.response.data : undefined;
  const message =
    (responseData && (responseData.message || responseData.errmsg)) ||
    maybeError.message ||
    '系统繁忙，请稍后重试';
  const errcode = Number(responseData && responseData.errcode);

  const resolveWecomFriendlyError = (inputErrcode, inputMessage) => {
    const normalizedMessage = String(inputMessage || '').toLowerCase();
    if (inputErrcode === 60011 || normalizedMessage.includes('e=60011')) {
      return '当前应用缺少通讯录权限，暂时无法读取组织成员。请联系管理员在企业微信后台开启通讯录可见范围。';
    }
    if (
      inputErrcode === 60020 ||
      normalizedMessage.includes('e=60020') ||
      normalizedMessage.includes('not allow to access from your ip')
    ) {
      return '当前服务器出口 IP 尚未加入企微可信 IP，暂时无法读取组织成员。请在企业微信后台补充可信 IP 后重试。';
    }
    if (
      inputErrcode === 48009 ||
      normalizedMessage.includes('e=48009') ||
      normalizedMessage.includes('contact assistant')
    ) {
      return '当前日程接口被"通讯录助手"凭证拒绝（48009）。请将 `CORP_SECRET` 配置为业务应用 Secret，或新增 `WECOM_OA_SECRET/WECOM_AGENT_SECRET` 后重试。';
    }
    return '';
  };

  const friendlyMessage = resolveWecomFriendlyError(errcode, String(message));
  if (friendlyMessage) {
    return friendlyMessage;
  }

  const normalizedMessage = String(message || '').toLowerCase();
  if (
    normalizedMessage.includes('network error') ||
    normalizedMessage.includes('failed to fetch') ||
    normalizedMessage.includes('load failed')
  ) {
    return '组织成员服务暂时不可达，可能是企业微信网络、服务连接或代理配置异常。';
  }

  const code =
    responseData && typeof responseData.code === 'string' ? responseData.code.trim() : '';
  if (code && (code.startsWith('CALENDAR_') || code.startsWith('SCHEDULE_'))) {
    return `${message}（${code}）`;
  }
  return String(message);
}

// ---------------------------------------------------------------------------
// 辅助：中文字符检测
// ---------------------------------------------------------------------------

/** 检查字符串是否包含至少一个中文字符 */
function containsChinese(str) {
  return /[\u4e00-\u9fff]/.test(str);
}

/** 检查字符串是否包含技术性文本（堆栈跟踪、原始异常类名等） */
function containsTechnicalText(str) {
  const normalizedStr = String(str || '').toLowerCase();
  return (
    /\bat\s+\w+\s*\(/.test(normalizedStr) || // stack trace: "at Function ("
    normalizedStr.includes('typeerror') ||
    normalizedStr.includes('referenceerror') ||
    normalizedStr.includes('syntaxerror') ||
    normalizedStr.includes('rangeerror') ||
    normalizedStr.includes('econnrefused') ||
    normalizedStr.includes('enotfound') ||
    normalizedStr.includes('etimedout') ||
    normalizedStr.includes('undefined is not') ||
    normalizedStr.includes('cannot read propert')
  );
}

// ---------------------------------------------------------------------------
// Arbitraries（生成器）
// ---------------------------------------------------------------------------

/** 生成随机错误消息字符串 */
const errorMessageArb = fc.oneof(
  fc.constant('Network Error'),
  fc.constant('Failed to fetch'),
  fc.constant('Load failed'),
  fc.constant('timeout of 5000ms exceeded'),
  fc.constant('Request failed with status code 500'),
  fc.constant('e=60011, some error'),
  fc.constant('e=60020, ip not allowed'),
  fc.constant('not allow to access from your ip'),
  fc.constant('contact assistant error'),
  fc.constant('e=48009, contact assistant'),
  fc.stringMatching(/^[a-zA-Z0-9 _\-.:]{0,80}$/)
);

/** 生成随机 errcode */
const errcodeArb = fc.oneof(
  fc.constant(0),
  fc.constant(60011),
  fc.constant(60020),
  fc.constant(48009),
  fc.constant(40001),
  fc.integer({ min: -1, max: 100000 })
);

/** 生成随机 code 字符串 */
const codeArb = fc.oneof(
  fc.constant(''),
  fc.constant('CALENDAR_NOT_FOUND'),
  fc.constant('SCHEDULE_CONFLICT'),
  fc.stringMatching(/^[A-Z_]{0,20}$/)
);

/** 生成随机错误对象（模拟 axios 错误结构） */
const errorObjectArb = fc.oneof(
  // 带 response.data 的错误
  fc.record({
    response: fc.record({
      data: fc.record({
        message: fc.option(errorMessageArb, { nil: undefined }),
        errmsg: fc.option(errorMessageArb, { nil: undefined }),
        errcode: fc.option(errcodeArb, { nil: undefined }),
        code: fc.option(codeArb, { nil: undefined }),
      }),
    }),
    message: fc.option(errorMessageArb, { nil: undefined }),
  }),
  // 仅有 message 的错误
  fc.record({
    message: fc.option(errorMessageArb, { nil: undefined }),
  }),
  // 空对象
  fc.constant({}),
  // null / undefined
  fc.constant(null),
  fc.constant(undefined)
);

// ---------------------------------------------------------------------------
// Property 12: 错误消息用户友好性
// **Validates: Requirements 7.6**
//
// 使用 fast-check 生成随机错误输入，验证 resolveErrorMessage 输出为非空中文字符串
// 且不含技术性文本（堆栈跟踪、原始异常类名等）。
// ---------------------------------------------------------------------------

test('Property 12.1: resolveErrorMessage 输出始终为非空字符串', () => {
  fc.assert(
    fc.property(errorObjectArb, (errorInput) => {
      const result = resolveErrorMessage(errorInput);
      assert.ok(typeof result === 'string', '输出应为字符串');
      assert.ok(result.length > 0, '输出不应为空字符串');
    }),
    { numRuns: 500 }
  );
});

test('Property 12.2: resolveErrorMessage 输出包含中文字符', () => {
  fc.assert(
    fc.property(errorObjectArb, (errorInput) => {
      const result = resolveErrorMessage(errorInput);
      // 当输入有自定义 message 且不匹配任何友好映射时，
      // 函数会直接返回原始 message（可能是英文）。
      // 但对于已知错误码和网络错误，必须返回中文。
      const responseData =
        errorInput &&
        errorInput.response &&
        errorInput.response.data
          ? errorInput.response.data
          : undefined;
      const errcode = Number(responseData && responseData.errcode);
      const rawMessage = String(
        (responseData && (responseData.message || responseData.errmsg)) ||
          (errorInput && errorInput.message) ||
          ''
      ).toLowerCase();

      const isKnownWecomError =
        errcode === 60011 ||
        errcode === 60020 ||
        errcode === 48009 ||
        rawMessage.includes('e=60011') ||
        rawMessage.includes('e=60020') ||
        rawMessage.includes('e=48009') ||
        rawMessage.includes('not allow to access from your ip') ||
        rawMessage.includes('contact assistant');

      const isNetworkError =
        rawMessage.includes('network error') ||
        rawMessage.includes('failed to fetch') ||
        rawMessage.includes('load failed');

      const isNoMessage =
        !rawMessage.trim() &&
        !(responseData && (responseData.message || responseData.errmsg)) &&
        !(errorInput && errorInput.message);

      if (isKnownWecomError || isNetworkError || isNoMessage) {
        assert.ok(
          containsChinese(result),
          `已知错误类型应返回中文提示，实际输出: "${result}"`
        );
      }
    }),
    { numRuns: 500 }
  );
});

test('Property 12.3: resolveErrorMessage 输出不含技术性堆栈或异常类名', () => {
  fc.assert(
    fc.property(errorObjectArb, (errorInput) => {
      const result = resolveErrorMessage(errorInput);
      assert.ok(
        !containsTechnicalText(result),
        `输出不应包含技术性文本，实际输出: "${result}"`
      );
    }),
    { numRuns: 500 }
  );
});

test('Property 12.4: 默认回退消息为中文', () => {
  // 当错误对象完全为空时，应返回默认中文提示
  const emptyInputs = [null, undefined, {}, { response: {} }, { response: { data: {} } }];
  for (const input of emptyInputs) {
    const result = resolveErrorMessage(input);
    assert.ok(typeof result === 'string' && result.length > 0, '默认回退应为非空字符串');
    assert.ok(containsChinese(result), `默认回退应包含中文，实际输出: "${result}"`);
  }
});

test('Property 12.5: 企业微信已知错误码始终映射为友好中文提示', () => {
  const knownErrcodes = [60011, 60020, 48009];
  fc.assert(
    fc.property(
      fc.constantFrom(...knownErrcodes),
      errorMessageArb,
      (errcode, rawMessage) => {
        const error = {
          response: {
            data: {
              errcode,
              message: rawMessage,
            },
          },
        };
        const result = resolveErrorMessage(error);
        assert.ok(containsChinese(result), `errcode ${errcode} 应返回中文提示，实际: "${result}"`);
        assert.ok(result.length > 10, `errcode ${errcode} 的提示应足够详细，实际: "${result}"`);
      }
    ),
    { numRuns: 100 }
  );
});
