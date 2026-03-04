const test = require('node:test');
const assert = require('node:assert/strict');

const axios = require('axios');
const wecom = require('../src/services/wecom');

// withStub
// 是什么：运行期打桩辅助函数。
// 做什么：临时替换对象方法并在用例结束后恢复原始实现。
// 为什么：隔离外部 HTTP 依赖，确保测试只验证模板卡片请求体拼装逻辑。
const withStub = async (target, key, replacement, run) => {
  const original = target[key];
  target[key] = replacement;
  try {
    return await run();
  } finally {
    target[key] = original;
  }
};

test('sendTemplateCard 单按钮时应使用 button_list，避免 button_selection 触发 40016', async () => {
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
        await wecom.sendTemplateCard({
          touser: 'JiaWei',
          task_id: 'task-1',
          title: '单按钮卡片',
          description: '执行人确认',
          buttons: [{ id: 'ACTION_COMPLETE', text: '我已完成' }],
        });

        assert.equal(postCalls.length, 1);
        assert.equal(
          postCalls[0].url,
          'https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=mock_token'
        );

        const card = postCalls[0].payload.template_card;
        assert.equal(card.button_selection, undefined);
        assert.deepEqual(card.button_list, [
          {
            text: '我已完成',
            key: 'ACTION_COMPLETE',
            style: 1,
          },
        ]);
      }
    );
  });
});

test('sendTemplateCard 多按钮时应使用 button_selection 并保留选项顺序', async () => {
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
        await wecom.sendTemplateCard({
          touser: 'JiaWei',
          task_id: 'task-2',
          title: '多按钮卡片',
          description: '验收操作',
          buttons: [
            { id: 'ACTION_PASS', text: '确认通过' },
            { id: 'ACTION_REJECT', text: '驳回重做' },
          ],
        });

        assert.equal(postCalls.length, 1);
        const card = postCalls[0].payload.template_card;
        assert.deepEqual(card.button_selection, {
          question_key: 'task_action',
          title: '请确认任务进度',
          option_list: [
            { id: 'ACTION_PASS', text: '确认通过' },
            { id: 'ACTION_REJECT', text: '驳回重做' },
          ],
        });
        assert.equal(card.button_list, undefined);
      }
    );
  });
});
