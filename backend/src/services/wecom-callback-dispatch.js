const { normalizeText } = require('./task-lifecycle');

// getFromObjectPath
// 是什么：对象路径安全读取函数。
// 做什么：按给定路径读取嵌套对象值，任意一层缺失时返回 `undefined`。
// 为什么：企业微信模板卡片事件存在多种嵌套字段结构，直接点取容易抛异常。
const getFromObjectPath = (target, path) => {
  return path.reduce((accumulator, key) => {
    if (!accumulator || accumulator[key] === undefined || accumulator[key] === null) {
      return undefined;
    }

    return accumulator[key];
  }, target);
};

// resolveTaskIdFromMessage
// 是什么：模板卡片任务 ID 解析函数。
// 做什么：兼容多种字段命名与嵌套结构，解析交互关联的任务 ID。
// 为什么：企业微信模板卡片回调在不同资料和版本里字段位置不完全一致，需要统一抽取。
const resolveTaskIdFromMessage = (message) => {
  const candidates = [
    message && message.TaskId,
    message && message.TaskID,
    message && message.task_id,
    getFromObjectPath(message, ['TemplateCardEvent', 'TaskId']),
    getFromObjectPath(message, ['TemplateCardEvent', 'TaskID']),
  ];

  for (const candidate of candidates) {
    const normalized = normalizeText(candidate);
    if (normalized) {
      return normalized;
    }
  }

  return '';
};

// resolveSelectedKeyFromMessage
// 是什么：模板卡片动作键解析函数。
// 做什么：兼容按钮直出和下拉选项两种结构，解析用户选择的动作键。
// 为什么：任务闭环依赖动作键分发，不统一抽取会导致同一事件格式需要多处分支。
const resolveSelectedKeyFromMessage = (message) => {
  const candidates = [
    message && message.SelectedKey,
    message && message.EventKey,
    getFromObjectPath(message, ['ButtonSelection', 'Key']),
    getFromObjectPath(message, ['TemplateCardEvent', 'SelectedItems', 'SelectedItem', 'OptionIds']),
    getFromObjectPath(message, ['TemplateCardEvent', 'SelectedItems', 'SelectedItem', 'OptionId']),
  ];

  for (const candidate of candidates) {
    const normalized = normalizeText(candidate);
    if (normalized) {
      return normalized;
    }
  }

  return '';
};

// resolveTaskService
// 是什么：任务服务依赖解析函数。
// 做什么：优先使用外部注入的 stub，否则懒加载默认任务服务实现。
// 为什么：回调分发单测不应依赖数据库与外部模块，懒加载可降低耦合。
const resolveTaskService = (dependencies = {}) => {
  if (dependencies.taskService) {
    return dependencies.taskService;
  }

  return require('./task').taskService;
};

// resolveContactSyncService
// 是什么：通讯录同步服务依赖解析函数。
// 做什么：优先使用外部注入的 stub，否则懒加载默认通讯录同步服务实现。
// 为什么：这样可以让纯分发测试不依赖 SQLite 环境，同时保持生产代码默认行为。
const resolveContactSyncService = (dependencies = {}) => {
  if (dependencies.contactSyncService) {
    return dependencies.contactSyncService;
  }

  return require('./contact-sync');
};

// dispatchWecomCallbackMessage
// 是什么：企业微信回调消息分发函数。
// 做什么：根据 `MsgType/Event` 将消息分发到模板卡片处理或通讯录同步服务。
// 为什么：路由层只负责验签与解密，业务分发逻辑应下沉为可测试的纯服务。
const dispatchWecomCallbackMessage = async (message = {}, dependencies = {}) => {
  const msgType = normalizeText(message.MsgType);
  const event = normalizeText(message.Event);

  if (msgType === 'event' && event === 'template_card_event') {
    const taskService = resolveTaskService(dependencies);
    const interactionPayload = {
      UserID: normalizeText(message.FromUserName),
      TaskId: resolveTaskIdFromMessage(message),
      SelectedKey: resolveSelectedKeyFromMessage(message),
    };
    const interactionResult = await taskService.handleInteraction(interactionPayload);

    return {
      success: true,
      kind: 'template_card_event',
      interactionPayload,
      interactionResult,
    };
  }

  if (msgType === 'event' && event === 'change_contact') {
    const contactSyncService = resolveContactSyncService(dependencies);
    const changeResult = await contactSyncService.handleChangeContactEvent(message, {
      traceId: normalizeText(dependencies.traceId),
    });

    return {
      kind: 'change_contact',
      ...changeResult,
    };
  }

  return {
    success: false,
    skipped: true,
    reason: 'unsupported_message_type_or_event',
    msgType,
    event,
  };
};

module.exports = {
  dispatchWecomCallbackMessage,
};
