const test = require('node:test');
const assert = require('node:assert/strict');

// ORIGINAL_ENV
// 是什么：任务服务测试环境变量快照。
// 做什么：保存任务建历相关配置，便于每个用例后恢复现场。
// 为什么：本文件既覆盖“已有映射”也覆盖“缺失映射自动建历”分支，必须隔离环境副作用。
const ORIGINAL_ENV = {
  USER_CALENDAR_MAP: process.env.USER_CALENDAR_MAP,
  DEFAULT_CAL_ID: process.env.DEFAULT_CAL_ID,
  AUTO_USER_CALENDAR_COLOR: process.env.AUTO_USER_CALENDAR_COLOR,
};

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
  process.env.USER_CALENDAR_MAP = 'zhangsan:cal-zhangsan,lisi:cal-lisi';
  process.env.DEFAULT_CAL_ID = 'default-cal';
  process.env.AUTO_USER_CALENDAR_COLOR = ORIGINAL_ENV.AUTO_USER_CALENDAR_COLOR;
  await runSql('DELETE FROM tasks');
  await runSql('DELETE FROM user_calendar_map');
});

test.after(async () => {
  await runSql('DELETE FROM tasks');
  await runSql('DELETE FROM user_calendar_map');
  process.env.USER_CALENDAR_MAP = ORIGINAL_ENV.USER_CALENDAR_MAP;
  process.env.DEFAULT_CAL_ID = ORIGINAL_ENV.DEFAULT_CAL_ID;
  process.env.AUTO_USER_CALENDAR_COLOR = ORIGINAL_ENV.AUTO_USER_CALENDAR_COLOR;
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

test('syncScheduleTask 在缺失参与人时应回退到日历归属用户', async () => {
  const originalSendTemplateCard = wecom.sendTemplateCard;
  wecom.sendTemplateCard = async () => ({ errcode: 0, errmsg: 'ok' });

  try {
    const syncResult = await taskService.syncScheduleTask(
      {
        schedule_id: 'schedule-no-attendee',
        summary: '无参与人日程',
        description: '仅有时间字段',
        attendees: [],
        start_time: 1760000000,
        end_time: 1760003600,
      },
      {
        user_id: 'JiaWei',
        cal_id: 'cal-jiawei',
      }
    );

    assert.equal(syncResult.inserted, true);

    const rows = await allSql('SELECT * FROM tasks WHERE wecom_schedule_id = ?', ['schedule-no-attendee']);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].creator_userid, 'JiaWei');
    assert.equal(rows[0].executor_userid, 'JiaWei');
    assert.equal(rows[0].owner_userid, 'JiaWei');
    assert.equal(rows[0].owner_cal_id, 'cal-jiawei');
  } finally {
    wecom.sendTemplateCard = originalSendTemplateCard;
  }
});

test('createManualTask 在执行人未绑定日历时应自动创建个人日历并落为真实日程', async () => {
  process.env.USER_CALENDAR_MAP = '';
  process.env.DEFAULT_CAL_ID = '';
  process.env.AUTO_USER_CALENDAR_COLOR = '#1D4ED8';

  const createdCalendars = [];
  const createdSchedules = [];

  const originalCreateCalendar = wecom.createCalendar;
  const originalCreateSchedule = wecom.createSchedule;
  const originalSendTemplateCard = wecom.sendTemplateCard;

  wecom.createCalendar = async (payload) => {
    createdCalendars.push(payload);
    return {
      errcode: 0,
      errmsg: 'ok',
      cal_id: 'cal-auto-executor',
    };
  };
  wecom.createSchedule = async (payload) => {
    createdSchedules.push(payload);
    return {
      errcode: 0,
      errmsg: 'ok',
      schedule_id: 'sch-auto-created',
    };
  };
  wecom.sendTemplateCard = async () => ({ errcode: 0, errmsg: 'ok' });

  try {
    const result = await taskService.createManualTask(
      {
        title: '自动建历任务',
        description: '执行人首次接任务时自动补齐日历',
        executor_userid: 'new-executor',
        start_time: '2026-02-12T09:00:00.000Z',
        end_time: '2026-02-12T11:00:00.000Z',
      },
      'zhangsan',
      'unit_test'
    );

    const mappingRows = await allSql(
      `SELECT user_id, cal_id, source FROM user_calendar_map WHERE user_id = ?`,
      ['new-executor']
    );

    assert.equal(createdCalendars.length, 1);
    assert.equal(createdCalendars[0].summary, '任务管家-new-executor');
    assert.equal(createdCalendars[0].color, '#1D4ED8');
    assert.equal(createdSchedules.length, 1);
    assert.equal(createdSchedules[0].cal_id, 'cal-auto-executor');
    assert.equal(createdSchedules[0].organizer, 'new-executor');
    assert.equal(result.task.wecom_schedule_id, 'sch-auto-created');
    assert.equal(mappingRows.length, 1);
    assert.equal(mappingRows[0].cal_id, 'cal-auto-executor');
    assert.equal(mappingRows[0].source, 'task_auto_created');
  } finally {
    wecom.createCalendar = originalCreateCalendar;
    wecom.createSchedule = originalCreateSchedule;
    wecom.sendTemplateCard = originalSendTemplateCard;
  }
});
