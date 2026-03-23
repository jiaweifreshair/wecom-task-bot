const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/models/db');
const wecom = require('../src/services/wecom');
const { taskService } = require('../src/services/task');

// runSql
// 是什么：测试专用 SQLite 写操作包装函数。
// 做什么：以 Promise 形式执行 `db.run`，便于串行准备和校验测试数据。
// 为什么：提醒回归测试需要精确控制任务表状态并读取更新结果。
const runSql = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) {
        reject(err);
        return;
      }

      resolve({
        changes: this.changes || 0,
        lastID: this.lastID || 0,
      });
    });
  });
};

// getSql
// 是什么：测试专用 SQLite 单行查询包装函数。
// 做什么：读取单条任务记录，便于断言提醒时间与提醒类型更新。
// 为什么：`dispatchTaskReminder` 的副作用落在数据库里，需要直接校验。
const getSql = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
        return;
      }

      resolve(row || null);
    });
  });
};

test.beforeEach(async () => {
  await runSql('DELETE FROM tasks');
});

test.after(async () => {
  await runSql('DELETE FROM tasks');
});

test('dispatchTaskReminder 应为同步后的临近日程发送到期提醒', async () => {
  const sentCards = [];
  const originalSendTemplateCard = wecom.sendTemplateCard;
  wecom.sendTemplateCard = async (payload) => {
    sentCards.push(payload);
    return { errcode: 0, errmsg: 'ok' };
  };

  try {
    const syncResult = await taskService.syncScheduleTask(
      {
        schedule_id: 'schedule-due-soon',
        summary: '今晚回访客户',
        description: '同步自日历',
        organizer: { userid: 'manager-a' },
        attendees: [{ userid: 'executor-a' }],
        start_time: Math.floor(new Date('2026-03-10T10:00:00.000Z').getTime() / 1000),
        end_time: Math.floor(new Date('2026-03-10T11:00:00.000Z').getTime() / 1000),
      },
      {
        user_id: 'manager-a',
        cal_id: 'cal-manager-a',
      }
    );

    assert.equal(syncResult.inserted, true);

    const task = await getSql(`SELECT * FROM tasks WHERE wecom_schedule_id = ?`, ['schedule-due-soon']);
    assert.ok(task);

    const result = await taskService.dispatchTaskReminder(
      {
        ...task,
        end_time: '2026-03-10T11:00:00.000Z',
      },
      'unit_test',
      new Date('2026-03-10T10:30:00.000Z')
    );

    assert.equal(result.sent, true);
    assert.equal(result.kind, 'DUE_SOON');
    assert.equal(sentCards.length, 2);
    assert.equal(sentCards[1].title, '🕒 任务到期提醒');
    assert.match(sentCards[1].description, /24小时内到期/);

    const updatedTask = await getSql(`SELECT * FROM tasks WHERE wecom_schedule_id = ?`, ['schedule-due-soon']);
    assert.equal(updatedTask.last_reminder_kind, 'DUE_SOON');
    assert.ok(updatedTask.last_reminder_at);
  } finally {
    wecom.sendTemplateCard = originalSendTemplateCard;
  }
});

test('dispatchTaskReminder 应抑制冷却窗口内的重复提醒', async () => {
  const sentCards = [];
  const originalSendTemplateCard = wecom.sendTemplateCard;
  wecom.sendTemplateCard = async (payload) => {
    sentCards.push(payload);
    return { errcode: 0, errmsg: 'ok' };
  };

  try {
    await runSql(
      `INSERT INTO tasks (
        wecom_schedule_id,
        title,
        description,
        creator_userid,
        executor_userid,
        owner_userid,
        owner_cal_id,
        start_time,
        end_time,
        status,
        last_reminder_at,
        last_reminder_kind,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      [
        'schedule-cooldown',
        '重复提醒抑制',
        '测试',
        'manager-a',
        'executor-a',
        'executor-a',
        'cal-executor-a',
        '2026-03-10T08:00:00.000Z',
        '2026-03-10T11:00:00.000Z',
        'PENDING',
        '2026-03-10T09:30:00.000Z',
        'DUE_SOON',
      ]
    );

    const task = await getSql(`SELECT * FROM tasks WHERE wecom_schedule_id = ?`, ['schedule-cooldown']);
    const result = await taskService.dispatchTaskReminder(
      task,
      'unit_test',
      new Date('2026-03-10T10:30:00.000Z')
    );

    assert.equal(result.sent, false);
    assert.equal(result.kind, 'DUE_SOON');
    assert.equal(sentCards.length, 0);
  } finally {
    wecom.sendTemplateCard = originalSendTemplateCard;
  }
});

test('dispatchTaskReminder 应为逾期日程发送逾期提醒', async () => {
  const sentCards = [];
  const originalSendTemplateCard = wecom.sendTemplateCard;
  wecom.sendTemplateCard = async (payload) => {
    sentCards.push(payload);
    return { errcode: 0, errmsg: 'ok' };
  };

  try {
    await runSql(
      `INSERT INTO tasks (
        wecom_schedule_id,
        title,
        description,
        creator_userid,
        executor_userid,
        owner_userid,
        owner_cal_id,
        start_time,
        end_time,
        status,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      [
        'schedule-overdue',
        '逾期客户回访',
        '测试',
        'manager-a',
        'executor-a',
        'executor-a',
        'cal-executor-a',
        '2026-03-10T08:00:00.000Z',
        '2026-03-10T09:00:00.000Z',
        'PENDING',
      ]
    );

    const task = await getSql(`SELECT * FROM tasks WHERE wecom_schedule_id = ?`, ['schedule-overdue']);
    const result = await taskService.dispatchTaskReminder(
      task,
      'unit_test',
      new Date('2026-03-10T10:30:00.000Z')
    );

    assert.equal(result.sent, true);
    assert.equal(result.kind, 'OVERDUE');
    assert.equal(sentCards.length, 1);
    assert.equal(sentCards[0].title, '⏰ 任务逾期提醒');
    assert.match(sentCards[0].description, /已逾期/);
  } finally {
    wecom.sendTemplateCard = originalSendTemplateCard;
  }
});
