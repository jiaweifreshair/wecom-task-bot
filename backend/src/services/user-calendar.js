const wecom = require('./wecom');
const { parseUserCalendarMap } = require('./calendar-mapping');
const { normalizeText } = require('./task-lifecycle');
const userCalendarStore = require('./user-calendar-store');
const { createTraceId, logWithTrace } = require('../utils/logger');

// DEFAULT_USER_CALENDAR_COLOR
// 是什么：自动创建用户日历的默认颜色常量。
// 做什么：在未配置 `AUTO_USER_CALENDAR_COLOR` 时，使用稳定默认值创建日历。
// 为什么：企业微信日历创建要求颜色字段，必须保证始终有合法输入。
const DEFAULT_USER_CALENDAR_COLOR = '#FF3030';

// parseBooleanFlag
// 是什么：布尔配置解析函数。
// 做什么：将字符串配置解析为布尔值，支持 `1/true/yes/on`。
// 为什么：环境变量天然是字符串，需要统一解析后再驱动流程开关。
const parseBooleanFlag = (value, fallbackValue = false) => {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) {
    return Boolean(fallbackValue);
  }

  return ['1', 'true', 'yes', 'on'].includes(normalized);
};

// resolveCalendarColor
// 是什么：自动建历颜色解析函数。
// 做什么：优先读取 `AUTO_USER_CALENDAR_COLOR`，缺失时回退默认色。
// 为什么：允许运维按组织规范统一日历颜色，同时保留默认值兜底。
const resolveCalendarColor = () => {
  return normalizeText(process.env.AUTO_USER_CALENDAR_COLOR) || DEFAULT_USER_CALENDAR_COLOR;
};

// buildUserCalendarSummary
// 是什么：自动创建日历标题生成函数。
// 做什么：根据用户名或用户ID生成可识别的日历标题。
// 为什么：需要让运维快速识别“哪个账号对应哪个自动日历”。
const buildUserCalendarSummary = (userId, userName) => {
  const normalizedUserName = normalizeText(userName);
  const normalizedUserId = normalizeText(userId);
  const displayName = normalizedUserName || normalizedUserId || 'unknown';
  return `任务管家-${displayName}`;
};

// resolveEnvMappedCalendarId
// 是什么：环境变量映射日历解析函数。
// 做什么：从 `USER_CALENDAR_MAP` 中提取当前用户已配置的 `cal_id`。
// 为什么：运维手工指定映射时应优先复用，避免重复创建日历。
const resolveEnvMappedCalendarId = (userId) => {
  const normalizedUserId = normalizeText(userId);
  if (!normalizedUserId) {
    return '';
  }

  const envMapRows = parseUserCalendarMap(process.env.USER_CALENDAR_MAP || '');
  const matched = envMapRows.find((item) => normalizeText(item && item.user_id) === normalizedUserId);
  return normalizeText(matched && matched.cal_id);
};

// createUserCalendarService
// 是什么：用户日历服务工厂函数。
// 做什么：组合企业微信客户端与映射存储，输出“登录建历”能力。
// 为什么：通过依赖注入可隔离外部接口，便于单元测试与后续扩展。
const createUserCalendarService = (dependencies = {}) => {
  const wecomClient = dependencies.wecomClient || wecom;
  const store = dependencies.store || userCalendarStore;

  // isCalendarIdReachable
  // 是什么：日历可用性检测函数。
  // 做什么：调用 `calendar/get` 校验目标 `cal_id` 是否仍可访问。
  // 为什么：历史映射可能因日历被删除而失效，需在登录时自动修复。
  const isCalendarIdReachable = async (calId) => {
    const normalizedCalId = normalizeText(calId);
    if (!normalizedCalId) {
      return false;
    }

    const response = await wecomClient.getCalendarByIds([normalizedCalId]);
    if (!response || response.errcode !== 0) {
      return false;
    }

    const calendarList = Array.isArray(response.calendar_list) ? response.calendar_list : [];
    return calendarList.some((item) => normalizeText(item && item.cal_id) === normalizedCalId);
  };

  // createCalendarForUser
  // 是什么：个人日历创建函数。
  // 做什么：按账号信息调用 `calendar/add` 创建日历并返回 `cal_id`。
  // 为什么：首次登录缺少映射时需要自动补齐，避免后续同步链路中断。
  const createCalendarForUser = async (userId, userName) => {
    const calendarSummary = buildUserCalendarSummary(userId, userName);
    const createResult = await wecomClient.createCalendar({
      summary: calendarSummary,
      color: resolveCalendarColor(),
      description: `任务管家自动创建，绑定账号 ${normalizeText(userId)}`,
    });

    return {
      calendarSummary,
      createResult,
      calId: normalizeText(createResult && createResult.cal_id),
    };
  };

  // ensureUserCalendarForUser
  // 是什么：登录场景用户日历确保函数。
  // 做什么：优先复用 env/db 映射，缺失或失效时自动创建并回写映射。
  // 为什么：落实“登录即判断并创建日历”的业务策略，消除手工配置依赖。
  const ensureUserCalendarForUser = async (options = {}) => {
    const traceId = normalizeText(options.traceId) || createTraceId();
    const userId = normalizeText(options.userId);
    const userName = normalizeText(options.userName);
    const source = normalizeText(options.source) || 'auth_callback';
    const autoCreateEnabled = parseBooleanFlag(process.env.AUTO_CREATE_USER_CALENDAR_ON_LOGIN, true);

    if (!userId) {
      return {
        ensured: false,
        reason: 'user_id_missing',
      };
    }

    if (!autoCreateEnabled) {
      return {
        ensured: false,
        reason: 'auto_create_disabled',
      };
    }

    const envMappedCalId = resolveEnvMappedCalendarId(userId);
    if (envMappedCalId) {
      await store.upsertUserCalendarRow({
        user_id: userId,
        cal_id: envMappedCalId,
        calendar_summary: '',
        source: 'env_map',
      });
      return {
        ensured: true,
        created: false,
        reason: 'env_map_reused',
        cal_id: envMappedCalId,
      };
    }

    const existedMapping = await store.getUserCalendarRowByUserId(userId);
    if (existedMapping && normalizeText(existedMapping.cal_id)) {
      try {
        const reachable = await isCalendarIdReachable(existedMapping.cal_id);
        if (reachable) {
          return {
            ensured: true,
            created: false,
            reason: 'db_map_reused',
            cal_id: normalizeText(existedMapping.cal_id),
          };
        }
      } catch (error) {
        logWithTrace(traceId, 'user-calendar', 'ensure.calendar_validate_error', {
          userId,
          message: error.message,
          source,
        });
      }
    }

    const { calendarSummary, createResult, calId } = await createCalendarForUser(userId, userName);
    if (!createResult || createResult.errcode !== 0 || !calId) {
      return {
        ensured: false,
        created: false,
        reason: 'calendar_create_failed',
        errcode: createResult && createResult.errcode,
        errmsg: createResult && createResult.errmsg,
      };
    }

    await store.upsertUserCalendarRow({
      user_id: userId,
      cal_id: calId,
      calendar_summary: calendarSummary,
      source: 'auto_created_login',
    });

    logWithTrace(traceId, 'user-calendar', 'ensure.calendar_created', {
      userId,
      calId,
      calendarSummary,
      source,
    });

    return {
      ensured: true,
      created: true,
      reason: 'calendar_created',
      cal_id: calId,
    };
  };

  return {
    ensureUserCalendarForUser,
  };
};

const userCalendarService = createUserCalendarService();

module.exports = {
  createUserCalendarService,
  userCalendarService,
};

