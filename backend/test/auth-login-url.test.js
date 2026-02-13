const test = require('node:test');
const assert = require('node:assert/strict');

const {
  LOGIN_MODE,
  resolveAuthLoginMode,
  buildAuthLoginRedirectUrl,
} = require('../src/services/auth-login-url');

test('resolveAuthLoginMode 在浏览器默认走扫码模式', () => {
  const mode = resolveAuthLoginMode({
    queryMode: '',
    envMode: 'AUTO',
    userAgent: 'Mozilla/5.0',
  });

  assert.equal(mode, LOGIN_MODE.QR);
});

test('resolveAuthLoginMode 在企业微信内置浏览器走 OAuth 模式', () => {
  const mode = resolveAuthLoginMode({
    queryMode: '',
    envMode: 'AUTO',
    userAgent: 'Mozilla/5.0 wxwork/4.1.36',
  });

  assert.equal(mode, LOGIN_MODE.OAUTH);
});

test('resolveAuthLoginMode 应允许 query 参数覆盖 env 配置', () => {
  const mode = resolveAuthLoginMode({
    queryMode: 'oauth',
    envMode: 'QR',
    userAgent: 'Mozilla/5.0',
  });

  assert.equal(mode, LOGIN_MODE.OAUTH);
});

test('buildAuthLoginRedirectUrl 在 QR 模式应返回企业微信扫码 URL', () => {
  const url = buildAuthLoginRedirectUrl({
    mode: LOGIN_MODE.QR,
    corpId: 'ww123',
    agentId: '1000002',
    redirectUri: 'https://example.com/api/auth/callback',
    state: 'MY_STATE',
  });

  assert.equal(url.startsWith('https://open.work.weixin.qq.com/wwopen/sso/qrConnect?'), true);
  assert.equal(url.includes('appid=ww123'), true);
  assert.equal(url.includes('agentid=1000002'), true);
  assert.equal(url.includes('state=MY_STATE'), true);
});

test('buildAuthLoginRedirectUrl 在 OAuth 模式应返回带 wechat_redirect 的 URL', () => {
  const url = buildAuthLoginRedirectUrl({
    mode: LOGIN_MODE.OAUTH,
    corpId: 'ww123',
    agentId: '1000002',
    redirectUri: 'https://example.com/api/auth/callback',
    state: 'STATE',
  });

  assert.equal(url.startsWith('https://open.weixin.qq.com/connect/oauth2/authorize?'), true);
  assert.equal(url.includes('appid=ww123'), true);
  assert.equal(url.endsWith('#wechat_redirect'), true);
});

test('buildAuthLoginRedirectUrl 应清洗非法 state', () => {
  const url = buildAuthLoginRedirectUrl({
    mode: LOGIN_MODE.QR,
    corpId: 'ww123',
    agentId: '1000002',
    redirectUri: 'https://example.com/api/auth/callback',
    state: 'STATE=BAD',
  });

  assert.equal(url.includes('state=STATE'), true);
});
