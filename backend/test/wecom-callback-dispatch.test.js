const test = require('node:test');
const assert = require('node:assert/strict');

const { dispatchWecomCallbackMessage } = require('../src/services/wecom-callback-dispatch');

test('dispatchWecomCallbackMessage 应分发模板卡片事件', async () => {
  const interactionCalls = [];

  const result = await dispatchWecomCallbackMessage(
    {
      MsgType: 'event',
      Event: 'template_card_event',
      FromUserName: 'zhangsan',
      TaskId: 'task-001',
      SelectedKey: 'action_pass',
    },
    {
      taskService: {
        handleInteraction: async (payload) => {
          interactionCalls.push(payload);
          return {
            success: true,
            task_id: payload.TaskId,
          };
        },
      },
      contactSyncService: {
        handleChangeContactEvent: async () => {
          throw new Error('should not call contact sync');
        },
      },
    }
  );

  assert.equal(result.success, true);
  assert.equal(result.kind, 'template_card_event');
  assert.deepEqual(interactionCalls, [
    {
      UserID: 'zhangsan',
      TaskId: 'task-001',
      SelectedKey: 'action_pass',
    },
  ]);
});

test('dispatchWecomCallbackMessage 应分发通讯录变更事件', async () => {
  const contactCalls = [];

  const result = await dispatchWecomCallbackMessage(
    {
      MsgType: 'event',
      Event: 'change_contact',
      ChangeType: 'create_user',
      UserID: 'lisi',
      Name: '李四',
      Department: '1',
    },
    {
      taskService: {
        handleInteraction: async () => {
          throw new Error('should not call task interaction');
        },
      },
      contactSyncService: {
        handleChangeContactEvent: async (message) => {
          contactCalls.push(message);
          return {
            success: true,
            change_type: message.ChangeType,
            entity_id: message.UserID,
          };
        },
      },
    }
  );

  assert.equal(result.success, true);
  assert.equal(result.kind, 'change_contact');
  assert.equal(result.change_type, 'create_user');
  assert.equal(result.entity_id, 'lisi');
  assert.equal(contactCalls.length, 1);
  assert.equal(contactCalls[0].UserID, 'lisi');
});

test('dispatchWecomCallbackMessage 对不支持事件应返回 skipped', async () => {
  const result = await dispatchWecomCallbackMessage({
    MsgType: 'event',
    Event: 'unknown_event',
  });

  assert.equal(result.success, false);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'unsupported_message_type_or_event');
});
