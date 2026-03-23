const test = require('node:test');
const assert = require('node:assert/strict');
const { createUserCalendarService } = require('../src/services/user-calendar');

// ORIGINAL_ENV_FLAGS
// 是什么：测试前环境变量快照。
// 做什么：记录登录建历相关环境变量，便于每个用例后恢复现场。
// 为什么：避免测试互相污染，确保不同用例的配置独立可控。
const ORIGINAL_ENV_FLAGS = {
  USER_CALENDAR_MAP: process.env.USER_CALENDAR_MAP,
  AUTO_CREATE_USER_CALENDAR_ON_LOGIN: process.env.AUTO_CREATE_USER_CALENDAR_ON_LOGIN,
  AUTO_USER_CALENDAR_COLOR: process.env.AUTO_USER_CALENDAR_COLOR,
};

test.afterEach(() => {
  process.env.USER_CALENDAR_MAP = ORIGINAL_ENV_FLAGS.USER_CALENDAR_MAP;
  process.env.AUTO_CREATE_USER_CALENDAR_ON_LOGIN = ORIGINAL_ENV_FLAGS.AUTO_CREATE_USER_CALENDAR_ON_LOGIN;
  process.env.AUTO_USER_CALENDAR_COLOR = ORIGINAL_ENV_FLAGS.AUTO_USER_CALENDAR_COLOR;
});

test('ensureUserCalendarForUser 应优先复用环境变量映射并回写数据库映射', async () => {
  process.env.USER_CALENDAR_MAP = 'zhangsan:cal-env-1';
  process.env.AUTO_CREATE_USER_CALENDAR_ON_LOGIN = 'true';

  const upsertPayloads = [];
  const store = {
    upsertUserCalendarRow: async (payload) => {
      upsertPayloads.push(payload);
      return payload;
    },
    getUserCalendarRowByUserId: async () => null,
  };
  const wecomClient = {
    getCalendarByIds: async () => {
      throw new Error('env 映射分支不应调用 getCalendarByIds');
    },
    createCalendar: async () => {
      throw new Error('env 映射分支不应调用 createCalendar');
    },
  };

  const service = createUserCalendarService({
    wecomClient,
    store,
  });

  const result = await service.ensureUserCalendarForUser({
    userId: 'zhangsan',
    userName: '张三',
    source: 'unit_test',
    traceId: 'trace-env-map',
  });

  assert.equal(result.ensured, true);
  assert.equal(result.created, false);
  assert.equal(result.reason, 'env_map_reused');
  assert.equal(result.cal_id, 'cal-env-1');
  assert.equal(upsertPayloads.length, 1);
  assert.equal(upsertPayloads[0].user_id, 'zhangsan');
  assert.equal(upsertPayloads[0].cal_id, 'cal-env-1');
  assert.equal(upsertPayloads[0].source, 'env_map');
});

test('ensureUserCalendarForUser 应复用可访问的数据库映射', async () => {
  process.env.USER_CALENDAR_MAP = '';
  process.env.AUTO_CREATE_USER_CALENDAR_ON_LOGIN = 'true';

  const store = {
    upsertUserCalendarRow: async () => {
      throw new Error('复用 DB 映射分支不应调用 upsert');
    },
    getUserCalendarRowByUserId: async () => ({
      user_id: 'lisi',
      cal_id: 'cal-db-1',
      source: 'auto_created_login',
    }),
  };
  const wecomClient = {
    getCalendarByIds: async (calIdList) => {
      assert.deepEqual(calIdList, ['cal-db-1']);
      return {
        errcode: 0,
        errmsg: 'ok',
        calendar_list: [{ cal_id: 'cal-db-1' }],
      };
    },
    createCalendar: async () => {
      throw new Error('复用 DB 映射分支不应调用 createCalendar');
    },
  };

  const service = createUserCalendarService({
    wecomClient,
    store,
  });

  const result = await service.ensureUserCalendarForUser({
    userId: 'lisi',
    userName: '李四',
    source: 'unit_test',
    traceId: 'trace-db-map',
  });

  assert.equal(result.ensured, true);
  assert.equal(result.created, false);
  assert.equal(result.reason, 'db_map_reused');
  assert.equal(result.cal_id, 'cal-db-1');
});

test('ensureUserCalendarForUser 应在数据库映射失效时自动创建新日历并回写映射', async () => {
  process.env.USER_CALENDAR_MAP = '';
  process.env.AUTO_CREATE_USER_CALENDAR_ON_LOGIN = 'true';
  process.env.AUTO_USER_CALENDAR_COLOR = '#2D8CF0';

  const upsertPayloads = [];
  const store = {
    upsertUserCalendarRow: async (payload) => {
      upsertPayloads.push(payload);
      return payload;
    },
    getUserCalendarRowByUserId: async () => ({
      user_id: 'wangwu',
      cal_id: 'cal-obsolete',
      source: 'auto_created_login',
    }),
  };
  const wecomClient = {
    getCalendarByIds: async () => ({
      errcode: 0,
      errmsg: 'ok',
      calendar_list: [],
    }),
    createCalendar: async (options) => {
      assert.equal(options.color, '#2D8CF0');
      assert.equal(options.summary, '任务管家-王五');
      return {
        errcode: 0,
        errmsg: 'ok',
        cal_id: 'cal-new-1',
      };
    },
  };

  const service = createUserCalendarService({
    wecomClient,
    store,
  });

  const result = await service.ensureUserCalendarForUser({
    userId: 'wangwu',
    userName: '王五',
    source: 'unit_test',
    traceId: 'trace-create-calendar',
  });

  assert.equal(result.ensured, true);
  assert.equal(result.created, true);
  assert.equal(result.reason, 'calendar_created');
  assert.equal(result.cal_id, 'cal-new-1');
  assert.equal(upsertPayloads.length, 1);
  assert.equal(upsertPayloads[0].user_id, 'wangwu');
  assert.equal(upsertPayloads[0].cal_id, 'cal-new-1');
  assert.equal(upsertPayloads[0].source, 'auto_created_login');
  assert.equal(upsertPayloads[0].calendar_summary, '任务管家-王五');
});

test('ensureUserCalendarForUser 在自动建历开关关闭时应直接跳过', async () => {
  process.env.USER_CALENDAR_MAP = '';
  process.env.AUTO_CREATE_USER_CALENDAR_ON_LOGIN = 'false';

  const store = {
    upsertUserCalendarRow: async () => {
      throw new Error('开关关闭时不应写入映射');
    },
    getUserCalendarRowByUserId: async () => {
      throw new Error('开关关闭时不应查询映射');
    },
  };
  const wecomClient = {
    getCalendarByIds: async () => {
      throw new Error('开关关闭时不应请求企业微信');
    },
    createCalendar: async () => {
      throw new Error('开关关闭时不应创建日历');
    },
  };

  const service = createUserCalendarService({
    wecomClient,
    store,
  });

  const result = await service.ensureUserCalendarForUser({
    userId: 'zhaoliu',
    userName: '赵六',
    source: 'unit_test',
    traceId: 'trace-disabled',
  });

  assert.equal(result.ensured, false);
  assert.equal(result.reason, 'auto_create_disabled');
});

test('ensureUserCalendarForUser 在显式确保场景下应忽略自动建历开关并创建日历', async () => {
  process.env.USER_CALENDAR_MAP = '';
  process.env.AUTO_CREATE_USER_CALENDAR_ON_LOGIN = 'false';

  const upsertPayloads = [];
  const store = {
    upsertUserCalendarRow: async (payload) => {
      upsertPayloads.push(payload);
      return payload;
    },
    getUserCalendarRowByUserId: async () => null,
  };
  const wecomClient = {
    getCalendarByIds: async () => {
      throw new Error('显式确保首建分支不应校验旧日历');
    },
    createCalendar: async (options) => {
      assert.equal(options.summary, '任务管家-孙七');
      return {
        errcode: 0,
        errmsg: 'ok',
        cal_id: 'cal-force-ensure-1',
      };
    },
  };

  const service = createUserCalendarService({
    wecomClient,
    store,
  });

  const result = await service.ensureUserCalendarForUser({
    userId: 'sunqi',
    userName: '孙七',
    source: 'calendar_manage_page',
    forceEnsure: true,
    traceId: 'trace-force-ensure',
  });

  assert.equal(result.ensured, true);
  assert.equal(result.created, true);
  assert.equal(result.reason, 'calendar_created');
  assert.equal(result.cal_id, 'cal-force-ensure-1');
  assert.equal(upsertPayloads.length, 1);
  assert.equal(upsertPayloads[0].user_id, 'sunqi');
  assert.equal(upsertPayloads[0].cal_id, 'cal-force-ensure-1');
});
