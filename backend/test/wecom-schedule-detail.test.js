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

test('getSchedule 应按 schedule_id_list 请求并返回首条 schedule', async () => {
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
            schedule_list: [
              {
                schedule_id: 'sch-1',
                summary: '同步测试',
              },
            ],
          },
        };
      },
      async () => {
        const result = await wecom.getSchedule('sch-1');

        assert.equal(postCalls.length, 1);
        assert.deepEqual(postCalls[0].payload, {
          schedule_id_list: ['sch-1'],
        });
        assert.equal(Array.isArray(result.schedule_list), true);
        assert.equal(result.schedule_list.length, 1);
        assert.equal(result.schedule.schedule_id, 'sch-1');
      }
    );
  });
});

test('getSchedules 应按 schedule_id_list 批量请求并返回 schedule_list', async () => {
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
            schedule_list: [
              {
                schedule_id: 'sch-1',
              },
              {
                schedule_id: 'sch-2',
              },
            ],
          },
        };
      },
      async () => {
        const result = await wecom.getSchedules(['sch-1', 'sch-2']);

        assert.equal(postCalls.length, 1);
        assert.deepEqual(postCalls[0].payload, {
          schedule_id_list: ['sch-1', 'sch-2'],
        });
        assert.equal(Array.isArray(result.schedule_list), true);
        assert.equal(result.schedule_list.length, 2);
      }
    );
  });
});
