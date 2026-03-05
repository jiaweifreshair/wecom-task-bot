const test = require('node:test');
const assert = require('node:assert/strict');

const axios = require('axios');
const wecom = require('../src/services/wecom');

const withStub = async (target, key, replacement, run) => {
  const original = target[key];
  target[key] = replacement;
  try {
    return await run();
  } finally {
    target[key] = original;
  }
};

test('createSchedule 应忽略 organizer 字段，避免触发接口权限拒绝', async () => {
  const postCalls = [];

  await withStub(wecom, 'getAccessToken', async () => 'mock_token', async () => {
    await withStub(
      axios,
      'post',
      async (url, payload) => {
        postCalls.push({ url, payload });
        return {
          data: {
            errcode: 0,
            errmsg: 'ok',
            schedule_id: 'sch-created',
          },
        };
      },
      async () => {
        const result = await wecom.createSchedule({
          organizer: 'JiaWei',
          summary: '创建测试',
          description: '创建测试描述',
          start_time: 1700000000,
          end_time: 1700003600,
          attendees: [{ userid: 'JiaWei' }],
        });

        assert.equal(postCalls.length, 1);
        assert.equal(
          postCalls[0].url,
          'https://qyapi.weixin.qq.com/cgi-bin/oa/schedule/add?access_token=mock_token'
        );
        assert.equal(postCalls[0].payload.schedule.organizer, undefined);
        assert.equal(postCalls[0].payload.schedule.summary, '创建测试');
        assert.equal(result.errcode, 0);
        assert.equal(result.schedule_id, 'sch-created');
      }
    );
  });
});

test('createSchedule 在 48009 时应自动切换备用 Secret 重试', async () => {
  const postCalls = [];
  const tokenCalls = [];
  const originalCorpSecret = wecom.corpSecret;
  const originalContactSecret = wecom.contactSecret;
  const originalOaSecret = wecom.oaSecret;

  wecom.corpSecret = 'default-secret-for-test';
  wecom.contactSecret = '';
  wecom.oaSecret = 'oa-secret-for-test';

  try {
    await withStub(
      wecom,
      'getAccessToken',
      async (options = {}) => {
        tokenCalls.push(options);
        if (options.cacheKey === 'oa_explicit') {
          return 'oa_token';
        }
        return 'default_token';
      },
      async () => {
        await withStub(
          axios,
          'post',
          async (url, payload) => {
            postCalls.push({ url, payload });
            if (url.includes('access_token=default_token')) {
              return {
                data: {
                  errcode: 48009,
                  errmsg: 'api forbidden for contact assistant',
                },
              };
            }

            return {
              data: {
                errcode: 0,
                errmsg: 'ok',
                schedule_id: 'sch-retry-success',
              },
            };
          },
          async () => {
            const result = await wecom.createSchedule({
              summary: '重试测试',
              start_time: 1700000000,
              end_time: 1700003600,
            });

            assert.equal(tokenCalls.length, 2);
            assert.equal(tokenCalls[0].cacheKey, 'default');
            assert.equal(tokenCalls[1].cacheKey, 'oa_explicit');
            assert.equal(postCalls.length, 2);
            assert.equal(postCalls[0].url.includes('access_token=default_token'), true);
            assert.equal(postCalls[1].url.includes('access_token=oa_token'), true);
            assert.equal(result.errcode, 0);
            assert.equal(result.schedule_id, 'sch-retry-success');
          }
        );
      }
    );
  } finally {
    wecom.corpSecret = originalCorpSecret;
    wecom.contactSecret = originalContactSecret;
    wecom.oaSecret = originalOaSecret;
  }
});

test('updateSchedule 应调用 oa/schedule/update 并透传可选参数', async () => {
  const postCalls = [];

  await withStub(wecom, 'getAccessToken', async () => 'mock_token', async () => {
    await withStub(
      axios,
      'post',
      async (url, payload) => {
        postCalls.push({ url, payload });
        return {
          data: {
            errcode: 0,
            errmsg: 'ok',
            schedule_id: 'sch-updated',
          },
        };
      },
      async () => {
        const result = await wecom.updateSchedule(
          {
            schedule_id: 'sch-1',
            summary: '更新后的标题',
            start_time: 1700000000,
            end_time: 1700003600,
          },
          {
            skip_attendees: 1,
            op_mode: 2,
            op_start_time: 1700000000,
          }
        );

        assert.equal(postCalls.length, 1);
        assert.equal(
          postCalls[0].url,
          'https://qyapi.weixin.qq.com/cgi-bin/oa/schedule/update?access_token=mock_token'
        );
        assert.deepEqual(postCalls[0].payload, {
          schedule: {
            schedule_id: 'sch-1',
            summary: '更新后的标题',
            start_time: 1700000000,
            end_time: 1700003600,
          },
          skip_attendees: 1,
          op_mode: 2,
          op_start_time: 1700000000,
        });
        assert.equal(result.errcode, 0);
        assert.equal(result.schedule_id, 'sch-updated');
      }
    );
  });
});

test('cancelSchedule 应调用 oa/schedule/del 并默认只提交 schedule_id', async () => {
  const postCalls = [];

  await withStub(wecom, 'getAccessToken', async () => 'mock_token', async () => {
    await withStub(
      axios,
      'post',
      async (url, payload) => {
        postCalls.push({ url, payload });
        return {
          data: {
            errcode: 0,
            errmsg: 'ok',
          },
        };
      },
      async () => {
        const result = await wecom.cancelSchedule('sch-2');

        assert.equal(postCalls.length, 1);
        assert.equal(
          postCalls[0].url,
          'https://qyapi.weixin.qq.com/cgi-bin/oa/schedule/del?access_token=mock_token'
        );
        assert.deepEqual(postCalls[0].payload, {
          schedule_id: 'sch-2',
        });
        assert.equal(result.errcode, 0);
      }
    );
  });
});
