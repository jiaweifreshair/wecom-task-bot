const test = require('node:test');
const assert = require('node:assert/strict');

const axios = require('axios');
const wecom = require('../src/services/wecom');

// withStub
// 是什么：运行期打桩辅助函数。
// 做什么：临时替换对象方法并在用例结束后恢复原始实现。
// 为什么：隔离外部 HTTP 依赖，确保测试只验证请求拼装逻辑。
const withStub = async (target, key, replacement, run) => {
  const original = target[key];
  target[key] = replacement;
  try {
    return await run();
  } finally {
    target[key] = original;
  }
};

test('createCalendar 应支持透传完整 calendar 对象', async () => {
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
            cal_id: 'cal-1',
          },
        };
      },
      async () => {
        const result = await wecom.createCalendar({
          calendar: {
            summary: '项目协作日历',
            color: '#FF3030',
            description: '测试描述',
            admins: ['JiaWei'],
            shares: [{ userid: 'JiaWei', permission: 1 }],
          },
          agentid: 1000002,
        });

        assert.equal(postCalls.length, 1);
        assert.equal(
          postCalls[0].url,
          'https://qyapi.weixin.qq.com/cgi-bin/oa/calendar/add?access_token=mock_token'
        );
        assert.deepEqual(postCalls[0].payload, {
          calendar: {
            summary: '项目协作日历',
            color: '#FF3030',
            description: '测试描述',
            admins: ['JiaWei'],
            shares: [{ userid: 'JiaWei', permission: 1 }],
          },
          agentid: 1000002,
        });
        assert.equal(result.errcode, 0);
        assert.equal(result.cal_id, 'cal-1');
      }
    );
  });
});

test('updateCalendar 应调用 oa/calendar/update 并支持 skip_public_range', async () => {
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
        const result = await wecom.updateCalendar(
          {
            cal_id: 'cal-1',
            summary: '项目协作日历-更新',
            color: '#00AAFF',
            description: '更新描述',
          },
          { skip_public_range: 1 }
        );

        assert.equal(postCalls.length, 1);
        assert.equal(
          postCalls[0].url,
          'https://qyapi.weixin.qq.com/cgi-bin/oa/calendar/update?access_token=mock_token'
        );
        assert.deepEqual(postCalls[0].payload, {
          skip_public_range: 1,
          calendar: {
            cal_id: 'cal-1',
            summary: '项目协作日历-更新',
            color: '#00AAFF',
            description: '更新描述',
          },
        });
        assert.equal(result.errcode, 0);
      }
    );
  });
});

test('deleteCalendar 应调用 oa/calendar/del', async () => {
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
        const result = await wecom.deleteCalendar('cal-1');

        assert.equal(postCalls.length, 1);
        assert.equal(
          postCalls[0].url,
          'https://qyapi.weixin.qq.com/cgi-bin/oa/calendar/del?access_token=mock_token'
        );
        assert.deepEqual(postCalls[0].payload, {
          cal_id: 'cal-1',
        });
        assert.equal(result.errcode, 0);
      }
    );
  });
});

test('addScheduleAttendees 应调用 oa/schedule/add_attendees', async () => {
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
        const result = await wecom.addScheduleAttendees('sch-1', [{ userid: 'lisi' }]);

        assert.equal(postCalls.length, 1);
        assert.equal(
          postCalls[0].url,
          'https://qyapi.weixin.qq.com/cgi-bin/oa/schedule/add_attendees?access_token=mock_token'
        );
        assert.deepEqual(postCalls[0].payload, {
          schedule_id: 'sch-1',
          attendees: [{ userid: 'lisi' }],
        });
        assert.equal(result.errcode, 0);
      }
    );
  });
});

test('removeScheduleAttendees 应调用 oa/schedule/del_attendees', async () => {
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
        const result = await wecom.removeScheduleAttendees('sch-1', [{ userid: 'lisi' }]);

        assert.equal(postCalls.length, 1);
        assert.equal(
          postCalls[0].url,
          'https://qyapi.weixin.qq.com/cgi-bin/oa/schedule/del_attendees?access_token=mock_token'
        );
        assert.deepEqual(postCalls[0].payload, {
          schedule_id: 'sch-1',
          attendees: [{ userid: 'lisi' }],
        });
        assert.equal(result.errcode, 0);
      }
    );
  });
});

test('listUsersByDepartment 应调用 user/list 并透传部门参数', async () => {
  const getCalls = [];

  await withStub(wecom, 'getAccessToken', async () => 'mock_token', async () => {
    await withStub(
      axios,
      'get',
      async (url) => {
        getCalls.push({ url });
        return {
          data: {
            errcode: 0,
            errmsg: 'ok',
            userlist: [{ userid: 'JiaWei', name: '贾伟' }],
          },
        };
      },
      async () => {
        const result = await wecom.listUsersByDepartment(1, 1, 0);

        assert.equal(getCalls.length, 1);
        assert.equal(
          getCalls[0].url,
          'https://qyapi.weixin.qq.com/cgi-bin/user/list?access_token=mock_token&department_id=1&fetch_child=1&status=0'
        );
        assert.equal(result.errcode, 0);
        assert.equal(Array.isArray(result.userlist), true);
      }
    );
  });
});

test('listUsersByDepartment 在 contact 返回 60020 时应回退 default secret', async () => {
  const getCalls = [];
  const tokenCalls = [];
  const originalContactSecret = wecom.contactSecret;
  const originalCorpSecret = wecom.corpSecret;
  wecom.contactSecret = 'contact-secret-for-test';
  wecom.corpSecret = 'default-secret-for-test';

  try {
    await withStub(
      wecom,
      'getAccessToken',
      async (options = {}) => {
        tokenCalls.push(options);
        if (options.cacheKey === 'contact') {
          return 'contact_token';
        }
        return 'default_token';
      },
      async () => {
        await withStub(
          axios,
          'get',
          async (url) => {
            getCalls.push({ url });
            if (url.includes('access_token=contact_token')) {
              return {
                data: {
                  errcode: 60020,
                  errmsg: 'ip not allow',
                  userlist: [],
                },
              };
            }

            return {
              data: {
                errcode: 0,
                errmsg: 'ok',
                userlist: [{ userid: 'JiaWei', name: '贾伟' }],
              },
            };
          },
          async () => {
            const result = await wecom.listUsersByDepartment(1, 1, 0);
            assert.equal(tokenCalls.length, 2);
            assert.equal(tokenCalls[0].cacheKey, 'contact');
            assert.equal(tokenCalls[1].cacheKey, 'default');
            assert.equal(getCalls.length, 2);
            assert.equal(getCalls[0].url.includes('access_token=contact_token'), true);
            assert.equal(getCalls[1].url.includes('access_token=default_token'), true);
            assert.equal(result.errcode, 0);
            assert.equal(Array.isArray(result.userlist), true);
            assert.equal(result.userlist.length, 1);
          }
        );
      }
    );
  } finally {
    wecom.contactSecret = originalContactSecret;
    wecom.corpSecret = originalCorpSecret;
  }
});

test('listUsersByDepartment 在 contact 返回 48009 时应回退 default secret', async () => {
  const getCalls = [];
  const tokenCalls = [];
  const originalContactSecret = wecom.contactSecret;
  const originalCorpSecret = wecom.corpSecret;
  const originalContactSecretUserListDenied = wecom.contactSecretUserListDenied;
  wecom.contactSecret = 'contact-secret-for-test';
  wecom.corpSecret = 'default-secret-for-test';
  wecom.contactSecretUserListDenied = false;

  try {
    await withStub(
      wecom,
      'getAccessToken',
      async (options = {}) => {
        tokenCalls.push(options);
        if (options.cacheKey === 'contact') {
          return 'contact_token';
        }
        return 'default_token';
      },
      async () => {
        await withStub(
          axios,
          'get',
          async (url) => {
            getCalls.push({ url });
            if (url.includes('access_token=contact_token')) {
              return {
                data: {
                  errcode: 48009,
                  errmsg: 'api forbidden for contact assistant',
                  userlist: [],
                },
              };
            }

            return {
              data: {
                errcode: 0,
                errmsg: 'ok',
                userlist: [{ userid: 'JiaWei', name: '贾伟' }],
              },
            };
          },
          async () => {
            const result = await wecom.listUsersByDepartment(1, 1, 0);
            assert.equal(tokenCalls.length, 2);
            assert.equal(tokenCalls[0].cacheKey, 'contact');
            assert.equal(tokenCalls[1].cacheKey, 'default');
            assert.equal(getCalls.length, 2);
            assert.equal(getCalls[0].url.includes('access_token=contact_token'), true);
            assert.equal(getCalls[1].url.includes('access_token=default_token'), true);
            assert.equal(result.errcode, 0);
            assert.equal(Array.isArray(result.userlist), true);
            assert.equal(result.userlist.length, 1);
          }
        );
      }
    );
  } finally {
    wecom.contactSecret = originalContactSecret;
    wecom.corpSecret = originalCorpSecret;
    wecom.contactSecretUserListDenied = originalContactSecretUserListDenied;
  }
});

test('listUsersByDepartment 在 contact 命中 48009 后，后续查询应跳过 contact secret', async () => {
  const getCalls = [];
  const tokenCalls = [];
  const originalContactSecret = wecom.contactSecret;
  const originalCorpSecret = wecom.corpSecret;
  const originalContactSecretUserListDenied = wecom.contactSecretUserListDenied;
  wecom.contactSecret = 'contact-secret-for-test';
  wecom.corpSecret = 'default-secret-for-test';
  wecom.contactSecretUserListDenied = false;

  try {
    await withStub(
      wecom,
      'getAccessToken',
      async (options = {}) => {
        tokenCalls.push(options);
        if (options.cacheKey === 'contact') {
          return 'contact_token';
        }
        return 'default_token';
      },
      async () => {
        await withStub(
          axios,
          'get',
          async (url) => {
            getCalls.push({ url });
            if (url.includes('access_token=contact_token')) {
              return {
                data: {
                  errcode: 48009,
                  errmsg: 'api forbidden for contact assistant',
                  userlist: [],
                },
              };
            }

            return {
              data: {
                errcode: 0,
                errmsg: 'ok',
                userlist: [{ userid: 'JiaWei', name: '贾伟' }],
              },
            };
          },
          async () => {
            const firstResult = await wecom.listUsersByDepartment(1, 1, 0);
            const secondResult = await wecom.listUsersByDepartment(1, 1, 0);

            assert.equal(firstResult.errcode, 0);
            assert.equal(secondResult.errcode, 0);
            assert.equal(wecom.contactSecretUserListDenied, true);
            assert.equal(tokenCalls.length, 3);
            assert.equal(tokenCalls[0].cacheKey, 'contact');
            assert.equal(tokenCalls[1].cacheKey, 'default');
            assert.equal(tokenCalls[2].cacheKey, 'default');
            assert.equal(getCalls.length, 3);
            assert.equal(getCalls[0].url.includes('access_token=contact_token'), true);
            assert.equal(getCalls[1].url.includes('access_token=default_token'), true);
            assert.equal(getCalls[2].url.includes('access_token=default_token'), true);
          }
        );
      }
    );
  } finally {
    wecom.contactSecret = originalContactSecret;
    wecom.corpSecret = originalCorpSecret;
    wecom.contactSecretUserListDenied = originalContactSecretUserListDenied;
  }
});
