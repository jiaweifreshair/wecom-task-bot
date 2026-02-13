const { normalizeText } = require('./task-lifecycle');

const LOGIN_MODE = {
  QR: 'QR',
  OAUTH: 'OAUTH',
  AUTO: 'AUTO',
};

const DEFAULT_STATE = 'STATE';

// normalizeLoginMode
// 是什么：登录模式标准化函数。
// 做什么：将输入值转换为系统支持的登录模式（QR/OAUTH/AUTO）。
// 为什么：模式值可能来自环境变量或请求参数，需统一口径避免分支失效。
const normalizeLoginMode = (value) => {
  const normalized = normalizeText(value).toUpperCase();
  if (normalized === LOGIN_MODE.QR || normalized === LOGIN_MODE.OAUTH || normalized === LOGIN_MODE.AUTO) {
    return normalized;
  }
  return LOGIN_MODE.AUTO;
};

// normalizeLoginState
// 是什么：OAuth 状态参数清洗函数。
// 做什么：仅允许字母数字下划线中划线，非法值回退默认状态。
// 为什么：状态参数会进入重定向 URL，需避免注入类风险并控制长度。
const normalizeLoginState = (value) => {
  const normalized = normalizeText(value);
  const valid = /^[a-zA-Z0-9_-]{1,64}$/.test(normalized);
  return valid ? normalized : DEFAULT_STATE;
};

// isWeComClientUserAgent
// 是什么：企业微信客户端识别函数。
// 做什么：通过 User-Agent 判断当前请求是否来自企业微信内置浏览器。
// 为什么：AUTO 模式下客户端优先走 OAuth，普通浏览器优先走扫码登录。
const isWeComClientUserAgent = (userAgent) => {
  const normalized = normalizeText(userAgent).toLowerCase();
  if (!normalized) {
    return false;
  }

  return normalized.includes('wxwork') || normalized.includes('wework');
};

// resolveAuthLoginMode
// 是什么：最终登录模式决策函数。
// 做什么：按“请求参数 > 环境变量 > AUTO 策略”计算最终模式。
// 为什么：既满足运维统一配置，也支持单次登录的显式覆盖。
const resolveAuthLoginMode = ({ queryMode, envMode, userAgent }) => {
  const queryResolvedMode = normalizeLoginMode(queryMode);
  const hasQueryMode = Boolean(normalizeText(queryMode));
  const envResolvedMode = normalizeLoginMode(envMode);

  const preferredMode = hasQueryMode ? queryResolvedMode : envResolvedMode;
  if (preferredMode === LOGIN_MODE.QR || preferredMode === LOGIN_MODE.OAUTH) {
    return preferredMode;
  }

  return isWeComClientUserAgent(userAgent) ? LOGIN_MODE.OAUTH : LOGIN_MODE.QR;
};

// buildOAuthLoginUrl
// 是什么：OAuth 登录地址构建函数。
// 做什么：拼装企业微信 OAuth 授权 URL（含 `#wechat_redirect`）。
// 为什么：企业微信内浏览器无法扫码，需走 OAuth 静默授权链路。
const buildOAuthLoginUrl = ({ corpId, redirectUri, state }) => {
  const params = new URLSearchParams({
    appid: normalizeText(corpId),
    redirect_uri: normalizeText(redirectUri),
    response_type: 'code',
    scope: 'snsapi_base',
    state: normalizeLoginState(state),
  });

  return `https://open.weixin.qq.com/connect/oauth2/authorize?${params.toString()}#wechat_redirect`;
};

// buildQrLoginUrl
// 是什么：扫码登录地址构建函数。
// 做什么：拼装企业微信扫码登录页 URL（`wwopen/sso/qrConnect`）。
// 为什么：桌面浏览器需要二维码入口，用户可用企业微信扫码完成登录。
const buildQrLoginUrl = ({ corpId, agentId, redirectUri, state }) => {
  const params = new URLSearchParams({
    appid: normalizeText(corpId),
    agentid: normalizeText(agentId),
    redirect_uri: normalizeText(redirectUri),
    state: normalizeLoginState(state),
  });

  return `https://open.work.weixin.qq.com/wwopen/sso/qrConnect?${params.toString()}`;
};

// buildAuthLoginRedirectUrl
// 是什么：登录重定向地址统一构建函数。
// 做什么：根据最终模式返回 OAuth 或扫码登录 URL。
// 为什么：路由层只需处理模式决策，不必感知不同登录协议细节。
const buildAuthLoginRedirectUrl = ({ mode, corpId, agentId, redirectUri, state }) => {
  if (mode === LOGIN_MODE.OAUTH) {
    return buildOAuthLoginUrl({
      corpId,
      redirectUri,
      state,
    });
  }

  return buildQrLoginUrl({
    corpId,
    agentId,
    redirectUri,
    state,
  });
};

module.exports = {
  LOGIN_MODE,
  resolveAuthLoginMode,
  buildAuthLoginRedirectUrl,
};
