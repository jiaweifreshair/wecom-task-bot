const test = require('node:test');
const assert = require('node:assert/strict');

process.env.USER_CALENDAR_MAP = 'zhangsan:cal-a,lisi:cal-b';
process.env.DEFAULT_CAL_ID = 'default-cal';

const wecom = require('../src/services/wecom');
const syncService = require('../src/services/sync');

const withStub = async (target, key, replacement, run) => {
  const original = target[key];
  target[key] = replacement;
  try {
    return await run();
  } finally {
    target[key] = original;
  }
};

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
