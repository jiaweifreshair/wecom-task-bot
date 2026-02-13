const test = require('node:test');
const assert = require('node:assert/strict');

const {
  REMINDER_KIND,
  parseGlobalVerifiers,
  canUserCompleteTask,
  canUserVerifyTask,
  normalizeActionKey,
  mapTaskRowToApi,
  getReminderKind,
  shouldSendReminder,
  buildTaskKpi,
} = require('../src/services/task-lifecycle');

test('parseGlobalVerifiers 应去空格并去重', () => {
  const result = parseGlobalVerifiers(' leader1, leader2 ,leader1 ,, ');
  assert.deepEqual(result, ['leader1', 'leader2']);
});

test('canUserCompleteTask 仅允许执行人处理待执行任务', () => {
  const baseTask = {
    status: 'PENDING',
    executor_userid: 'executor-a',
  };

  assert.equal(canUserCompleteTask(baseTask, 'executor-a'), true);
  assert.equal(canUserCompleteTask(baseTask, 'executor-b'), false);
  assert.equal(
    canUserCompleteTask({ ...baseTask, status: 'WAITING_VERIFY' }, 'executor-a'),
    false
  );
});

test('canUserVerifyTask 支持创建人和全局验收人', () => {
  const task = {
    status: 'WAITING_VERIFY',
    creator_userid: 'manager-a',
  };

  assert.equal(canUserVerifyTask(task, 'manager-a', ['leader-x']), true);
  assert.equal(canUserVerifyTask(task, 'leader-x', ['leader-x']), true);
  assert.equal(canUserVerifyTask(task, 'executor-a', ['leader-x']), false);
  assert.equal(canUserVerifyTask({ ...task, status: 'PENDING' }, 'manager-a', []), false);
});

test('normalizeActionKey 兼容卡片回调动作键', () => {
  assert.equal(normalizeActionKey('ACTION_COMPLETE'), 'ACTION_COMPLETE');
  assert.equal(normalizeActionKey('action_pass'), 'ACTION_PASS');
  assert.equal(normalizeActionKey(' Action_Reject '), 'ACTION_REJECT');
  assert.equal(normalizeActionKey('UNKNOWN_ACTION'), 'UNKNOWN_ACTION');
});

test('mapTaskRowToApi 应补充权限与时效字段', () => {
  const now = new Date('2026-02-12T12:00:00.000Z');
  const row = {
    id: 1,
    wecom_schedule_id: 'schedule-1',
    title: '测试任务',
    creator_userid: 'manager-a',
    executor_userid: 'executor-a',
    start_time: '2026-02-12T08:00:00.000Z',
    end_time: '2026-02-12T18:00:00.000Z',
    status: 'PENDING',
    reject_reason: null,
  };

  const mapped = mapTaskRowToApi(row, {
    now,
    currentUserId: 'executor-a',
    globalVerifiers: ['leader-x'],
  });

  assert.equal(mapped.can_complete, true);
  assert.equal(mapped.can_verify, false);
  assert.equal(mapped.is_due_soon, true);
  assert.equal(mapped.is_overdue, false);
});

test('getReminderKind 应返回到期与逾期提醒类型', () => {
  const now = new Date('2026-02-12T12:00:00.000Z');

  const dueSoonTask = {
    status: 'PENDING',
    end_time: '2026-02-13T10:00:00.000Z',
  };

  const overdueTask = {
    status: 'PENDING',
    end_time: '2026-02-12T10:00:00.000Z',
  };

  assert.equal(getReminderKind(dueSoonTask, now), REMINDER_KIND.DUE_SOON);
  assert.equal(getReminderKind(overdueTask, now), REMINDER_KIND.OVERDUE);
  assert.equal(
    getReminderKind({ ...dueSoonTask, status: 'COMPLETED' }, now),
    REMINDER_KIND.NONE
  );
});

test('shouldSendReminder 应按冷却窗口抑制重复发送', () => {
  const now = new Date('2026-02-12T12:00:00.000Z');

  const firstSendTask = {
    last_reminder_kind: null,
    last_reminder_at: null,
  };

  const cooldownTask = {
    last_reminder_kind: REMINDER_KIND.DUE_SOON,
    last_reminder_at: '2026-02-12T08:30:00.000Z',
  };

  const expiredCooldownTask = {
    last_reminder_kind: REMINDER_KIND.DUE_SOON,
    last_reminder_at: '2026-02-11T00:00:00.000Z',
  };

  assert.equal(shouldSendReminder(firstSendTask, REMINDER_KIND.DUE_SOON, now), true);
  assert.equal(shouldSendReminder(cooldownTask, REMINDER_KIND.DUE_SOON, now), false);
  assert.equal(shouldSendReminder(expiredCooldownTask, REMINDER_KIND.DUE_SOON, now), true);
});

test('buildTaskKpi 应聚合核心闭环指标', () => {
  const now = new Date('2026-02-12T12:00:00.000Z');

  const rows = [
    {
      status: 'PENDING',
      end_time: '2026-02-12T20:00:00.000Z',
    },
    {
      status: 'WAITING_VERIFY',
      end_time: '2026-02-12T11:00:00.000Z',
    },
    {
      status: 'COMPLETED',
      end_time: '2026-02-12T10:00:00.000Z',
      completion_time: '2026-02-12T09:00:00.000Z',
    },
  ];

  const kpi = buildTaskKpi(rows, now);

  assert.equal(kpi.total_tasks, 3);
  assert.equal(kpi.completed_tasks, 1);
  assert.equal(kpi.waiting_verify_tasks, 1);
  assert.equal(kpi.overdue_tasks, 1);
  assert.equal(kpi.due_soon_tasks, 1);
  assert.equal(kpi.completion_rate, 33.33);
  assert.equal(kpi.on_time_rate, 100);
});
