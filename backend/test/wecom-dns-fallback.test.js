const test = require('node:test');
const assert = require('node:assert/strict');
const wecomModule = require('../src/services/wecom');

const { WeComService, parseCommaList, pickFirstIpv4Address } = wecomModule;

test('parseCommaList 应按逗号拆分并去除空白项', () => {
  const result = parseCommaList(' 8.8.8.8, ,1.1.1.1 ,,114.114.114.114 ');
  assert.deepEqual(result, ['8.8.8.8', '1.1.1.1', '114.114.114.114']);
});

test('pickFirstIpv4Address 应兼容字符串与对象结构', () => {
  assert.equal(pickFirstIpv4Address(['1.1.1.1', '2.2.2.2']), '1.1.1.1');
  assert.equal(
    pickFirstIpv4Address([{ address: '3.3.3.3', family: 4 }, { address: '4.4.4.4', family: 4 }]),
    '3.3.3.3'
  );
});

test('resolveWecomHostAddress 在系统解析失败时应回退自定义 resolver', async () => {
  const service = new WeComService();
  service.resolveViaSystemLookup = async () => {
    throw new Error('system lookup failed');
  };
  service.resolveViaCustomResolver = async () => '101.1.1.1';

  const address = await service.resolveWecomHostAddress(service.wecomHost);
  assert.equal(address, '101.1.1.1');
});

test('resolveWecomHostAddress 在 DNS 全失败时应使用配置备用 IP 轮询', async () => {
  const service = new WeComService();
  service.resolveViaSystemLookup = async () => {
    throw new Error('system lookup failed');
  };
  service.resolveViaCustomResolver = async () => {
    throw new Error('custom resolver failed');
  };
  service.fallbackIps = ['10.0.0.1', '10.0.0.2'];
  service.fallbackIpCursor = 0;

  const first = await service.resolveWecomHostAddress(service.wecomHost);
  const second = await service.resolveWecomHostAddress(service.wecomHost);

  assert.equal(first, '10.0.0.1');
  assert.equal(second, '10.0.0.2');
});

test('lookupWithFallback 应返回企微域名的回退地址', async () => {
  const service = new WeComService();
  service.resolveWecomHostAddress = async () => '10.9.8.7';

  const result = await new Promise((resolve, reject) => {
    service.lookupWithFallback(service.wecomHost, { all: false, family: 4 }, (error, address, family) => {
      if (error) {
        reject(error);
        return;
      }

      resolve({ address, family });
    });
  });

  assert.equal(result.address, '10.9.8.7');
  assert.equal(result.family, 4);
});

test('buildAxiosConfig 应禁用环境代理继承，避免 protocol mismatch', () => {
  const service = new WeComService();
  const config = service.buildAxiosConfig();

  assert.equal(config.proxy, false);
  assert.equal(Boolean(config.httpsAgent), true);
});
