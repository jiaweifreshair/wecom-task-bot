const test = require('node:test');
const assert = require('node:assert/strict');

process.env.USER_CALENDAR_MAP = 'zhangsan:cal-a,lisi:cal-b';
process.env.DEFAULT_CAL_ID = 'default-cal';

const db = require('../src/models/db');
const wecom = require('../src/services/wecom');
const syncService = require('../src/services/sync');
const { taskService } = require('../src/services/task');

const runSql = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) {
        reject(err);
        return;
      }

      resolve({
        changes: this.changes || 0,
        lastID: this.lastID,
      });
    });
  });
};

const withStub = async (target, key, replacement, run) => {
  const original = target[key];
  target[key] = replacement;
  try {
    return await run();
  } finally {
    target[key] = original;
  }
};

test.beforeEach(async () => {
  await runSql('DELETE FROM user_calendar_map');
});

test('syncSchedules 应按员工日历逐个拉取并汇总', async () => {
  const queriedCalIds = [];
  const processedScheduleIds = [];

  await withStub(
    wecom,
    'getScheduleList',
    async (calId) => {
      queriedCalIds.push(calId);

      if (calId === 'cal-a') {
        return {
          errcode: 0,
          schedule_list: [
            { schedule_id: 's-1' },
            { schedule_id: 's-dup' },
          ],
        };
      }

      if (calId === 'cal-b') {
        return {
          errcode: 0,
          schedule_list: [
            { schedule_id: 's-2' },
            { schedule_id: 's-dup' },
          ],
        };
      }

      return {
        errcode: 41001,
        errmsg: 'invalid cal id',
      };
    },
    async () => {
      await withStub(
        syncService,
        'processSchedule',
        async (scheduleId) => {
          processedScheduleIds.push(scheduleId);

          return {
            inserted: scheduleId === 's-1',
            updated: scheduleId === 's-2',
            skipped: scheduleId !== 's-1' && scheduleId !== 's-2',
          };
        },
        async () => {
          await withStub(
            syncService,
            'dispatchDateReminders',
            async () => ({ sent_count: 3, checked_count: 5 }),
            async () => {
              const result = await syncService.syncSchedules();

              assert.equal(result.success, true);
              assert.deepEqual(queriedCalIds, ['cal-a', 'cal-b', 'default-cal']);
              assert.deepEqual(processedScheduleIds, ['s-1', 's-dup', 's-2']);
              assert.equal(result.calendar_count, 3);
              assert.equal(result.calendar_success_count, 2);
              assert.equal(result.calendar_failed_count, 1);
              assert.equal(result.schedule_count, 4);
              assert.equal(result.unique_schedule_count, 3);
              assert.equal(result.inserted_count, 1);
              assert.equal(result.updated_count, 1);
              assert.equal(result.skipped_count, 2);
              assert.equal(result.reminder_sent_count, 3);
            }
          );
        }
      );
    }
  );
});

test('processSchedule 应兼容详情接口的 schedule_list 返回结构', async () => {
  const syncTaskCalls = [];

  await withStub(
    wecom,
    'getSchedule',
    async () => ({
      errcode: 0,
      errmsg: 'ok',
      schedule_list: [
        {
          schedule_id: 's-detail-1',
          summary: '详情接口任务',
          organizer: { userid: 'zhangsan' },
          attendees: [{ userid: 'lisi' }],
          start_time: 1760000000,
          end_time: 1760003600,
          cal_id: 'cal-a',
        },
      ],
    }),
    async () => {
      await withStub(
        taskService,
        'syncScheduleTask',
        async (schedule, calendarContext) => {
          syncTaskCalls.push({ schedule, calendarContext });
          return {
            inserted: true,
            updated: false,
            skipped: false,
          };
        },
        async () => {
          const result = await syncService.processSchedule('s-detail-1', {
            user_id: 'zhangsan',
            cal_id: 'cal-a',
          });

          assert.equal(result.inserted, true);
          assert.equal(syncTaskCalls.length, 1);
          assert.equal(syncTaskCalls[0].schedule.schedule_id, 's-detail-1');
          assert.equal(syncTaskCalls[0].calendarContext.cal_id, 'cal-a');
        }
      );
    }
  );
});

test('syncSchedules 应按 offset 分页拉取同一日历', async () => {
  const originalUserCalendarMap = process.env.USER_CALENDAR_MAP;
  const originalDefaultCalId = process.env.DEFAULT_CAL_ID;
  const originalPageLimit = process.env.WECOM_SYNC_PAGE_LIMIT;
  const originalServiceDefaultCalId = syncService.defaultCalId;

  process.env.USER_CALENDAR_MAP = 'zhangsan:cal-paged';
  process.env.DEFAULT_CAL_ID = '';
  process.env.WECOM_SYNC_PAGE_LIMIT = '1';
  syncService.defaultCalId = '';

  const pageCalls = [];
  const processedScheduleIds = [];

  try {
    await withStub(
      wecom,
      'getScheduleList',
      async (calId, offset, limit) => {
        pageCalls.push({ calId, offset, limit });

        if (offset === 0) {
          return { errcode: 0, schedule_list: [{ schedule_id: 'page-s-1' }] };
        }

        if (offset === 1) {
          return { errcode: 0, schedule_list: [{ schedule_id: 'page-s-2' }] };
        }

        return { errcode: 0, schedule_list: [] };
      },
      async () => {
        await withStub(
          syncService,
          'processSchedule',
          async (scheduleId) => {
            processedScheduleIds.push(scheduleId);
            return { inserted: true, updated: false, skipped: false };
          },
          async () => {
            await withStub(
              syncService,
              'dispatchDateReminders',
              async () => ({ sent_count: 0, checked_count: 0 }),
              async () => {
                const result = await syncService.syncSchedules();

                assert.equal(result.success, true);
                assert.equal(result.calendar_count, 1);
                assert.equal(result.calendar_success_count, 1);
                assert.equal(result.schedule_count, 2);
                assert.deepEqual(processedScheduleIds, ['page-s-1', 'page-s-2']);
                assert.deepEqual(
                  pageCalls.map((item) => item.offset),
                  [0, 1, 2]
                );
              }
            );
          }
        );
      }
    );
  } finally {
    process.env.USER_CALENDAR_MAP = originalUserCalendarMap;
    process.env.DEFAULT_CAL_ID = originalDefaultCalId;
    process.env.WECOM_SYNC_PAGE_LIMIT = originalPageLimit;
    syncService.defaultCalId = originalServiceDefaultCalId;
  }
});

test('syncSchedules 缺少映射时应返回 missing_calendar_targets', async () => {
  const originalUserCalendarMap = process.env.USER_CALENDAR_MAP;
  const originalDefaultCalId = process.env.DEFAULT_CAL_ID;
  const originalServiceDefaultCalId = syncService.defaultCalId;
  const originalServiceUserCalendarMapRaw = syncService.userCalendarMapRaw;
  process.env.USER_CALENDAR_MAP = '';
  process.env.DEFAULT_CAL_ID = '';
  syncService.defaultCalId = '';
  syncService.userCalendarMapRaw = '';

  try {
    const result = await syncService.syncSchedules();
    assert.equal(result.success, false);
    assert.equal(result.reason, 'missing_calendar_targets');
  } finally {
    process.env.USER_CALENDAR_MAP = originalUserCalendarMap;
    process.env.DEFAULT_CAL_ID = originalDefaultCalId;
    syncService.defaultCalId = originalServiceDefaultCalId;
    syncService.userCalendarMapRaw = originalServiceUserCalendarMapRaw;
  }
});

test('resolveSyncCalendarTargets 应包含数据库用户日历映射', async () => {
  const originalUserCalendarMap = process.env.USER_CALENDAR_MAP;
  const originalDefaultCalId = process.env.DEFAULT_CAL_ID;
  const originalServiceDefaultCalId = syncService.defaultCalId;
  const originalServiceUserCalendarMapRaw = syncService.userCalendarMapRaw;

  process.env.USER_CALENDAR_MAP = '';
  process.env.DEFAULT_CAL_ID = '';
  syncService.defaultCalId = '';
  syncService.userCalendarMapRaw = '';

  try {
    await runSql(
      `INSERT INTO user_calendar_map (user_id, cal_id, source, updated_at) VALUES (?, ?, ?, datetime('now'))`,
      ['user-db', 'cal-db', 'auto_created_login']
    );

    const targets = await syncService.resolveSyncCalendarTargets();
    assert.equal(targets.length, 1);
    assert.equal(targets[0].user_id, 'user-db');
    assert.equal(targets[0].cal_id, 'cal-db');
  } finally {
    process.env.USER_CALENDAR_MAP = originalUserCalendarMap;
    process.env.DEFAULT_CAL_ID = originalDefaultCalId;
    syncService.defaultCalId = originalServiceDefaultCalId;
    syncService.userCalendarMapRaw = originalServiceUserCalendarMapRaw;
  }
});
