const test = require('node:test');
const assert = require('node:assert/strict');

process.env.USER_CALENDAR_MAP = 'zhangsan:cal-zhangsan,lisi:cal-lisi';
process.env.DEFAULT_CAL_ID = 'default-cal';

const db = require('../src/models/db');
const wecom = require('../src/services/wecom');
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

const allSql = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(rows || []);
    });
  });
};

test.beforeEach(async () => {
  await runSql('DELETE FROM tasks');
});

test.after(async () => {
  await runSql('DELETE FROM tasks');
});

test('createManualTask 应按创建人映射 cal_id 并写入企微日程ID', async () => {
  const createdSchedules = [];

  const originalCreateSchedule = wecom.createSchedule;
  const originalSendTemplateCard = wecom.sendTemplateCard;

  wecom.createSchedule = async (payload) => {
    createdSchedules.push(payload);
    return {
      errcode: 0,
      errmsg: 'ok',
      schedule_id: 'sch-wecom-1',
    };
  };
  wecom.sendTemplateCard = async () => ({ errcode: 0, errmsg: 'ok' });

  try {
    const result = await taskService.createManualTask(
      {
        title: '周会纪要补齐',
        description: '整理并提交周会纪要',
        executor_userid: 'lisi',
        start_time: '2026-02-12T09:00:00.000Z',
        end_time: '2026-02-12T11:00:00.000Z',
      },
      'zhangsan',
      'unit_test'
    );

    assert.equal(createdSchedules.length, 1);
    assert.equal(createdSchedules[0].cal_id, 'cal-lisi');
    assert.equal(createdSchedules[0].organizer, 'lisi');
    assert.equal(result.task.wecom_schedule_id, 'sch-wecom-1');
  } finally {
    wecom.createSchedule = originalCreateSchedule;
    wecom.sendTemplateCard = originalSendTemplateCard;
  }
});

test('syncScheduleTask 应回写 owner_cal_id 字段', async () => {
  const originalSendTemplateCard = wecom.sendTemplateCard;
  wecom.sendTemplateCard = async () => ({ errcode: 0, errmsg: 'ok' });

  try {
    const syncResult = await taskService.syncScheduleTask(
      {
        schedule_id: 'schedule-from-cal-a',
        summary: '同步任务A',
        description: '来自员工日历A',
        organizer: { userid: 'zhangsan' },
        attendees: [{ userid: 'lisi' }],
        start_time: 1760000000,
        end_time: 1760003600,
      },
      {
        user_id: 'zhangsan',
        cal_id: 'cal-a',
      }
    );

    assert.equal(syncResult.inserted, true);

    const rows = await allSql('SELECT * FROM tasks WHERE wecom_schedule_id = ?', ['schedule-from-cal-a']);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].owner_cal_id, 'cal-a');
  } finally {
    wecom.sendTemplateCard = originalSendTemplateCard;
  }
});
