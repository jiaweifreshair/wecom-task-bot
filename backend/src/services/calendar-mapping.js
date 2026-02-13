const { normalizeText } = require('./task-lifecycle');

// toCalendarMappingRecord
// 是什么：员工日历映射标准化函数。
// 做什么：将任意输入结构归一化为 `{ user_id, cal_id, source }`，非法值返回 `null`。
// 为什么：环境变量与数据库行格式可能不一致，统一结构后才能安全复用。
const toCalendarMappingRecord = (input, fallbackSource = 'env_map') => {
  const userId = normalizeText(
    input && (input.user_id || input.userid || input.userId || input.user || input.organizer)
  );
  const calId = normalizeText(input && (input.cal_id || input.calId || input.calendar_id || input.calendarId));
  const source = normalizeText(input && input.source) || fallbackSource;

  if (!calId) {
    return null;
  }

  return {
    user_id: userId,
    cal_id: calId,
    source,
  };
};

// parseUserCalendarMapFromJson
// 是什么：员工日历映射 JSON 解析函数。
// 做什么：支持 `{"userid":"cal_id"}` 与数组对象两种 JSON 结构。
// 为什么：便于运维用结构化配置一次性维护多员工映射关系。
const parseUserCalendarMapFromJson = (normalizedRaw) => {
  const parsed = JSON.parse(normalizedRaw);

  if (Array.isArray(parsed)) {
    return parsed
      .map((item) => toCalendarMappingRecord(item, 'env_map'))
      .filter((item) => item && item.user_id);
  }

  if (parsed && typeof parsed === 'object') {
    return Object.entries(parsed)
      .map(([userId, calId]) =>
        toCalendarMappingRecord(
          {
            user_id: userId,
            cal_id: calId,
            source: 'env_map',
          },
          'env_map'
        )
      )
      .filter((item) => item && item.user_id);
  }

  return [];
};

// parseUserCalendarMapFromPairs
// 是什么：员工日历映射键值串解析函数。
// 做什么：解析 `zhangsan:cal_a,lisi:cal_b` 或 `zhangsan=cal_a` 格式。
// 为什么：兼容轻量配置方式，降低首次接入成本。
const parseUserCalendarMapFromPairs = (normalizedRaw) => {
  return normalizedRaw
    .split(',')
    .map((item) => normalizeText(item))
    .filter(Boolean)
    .map((item) => {
      const separatorIndex = item.includes(':') ? item.indexOf(':') : item.indexOf('=');
      if (separatorIndex <= 0) {
        return null;
      }

      const userId = normalizeText(item.slice(0, separatorIndex));
      const calId = normalizeText(item.slice(separatorIndex + 1));
      return toCalendarMappingRecord(
        {
          user_id: userId,
          cal_id: calId,
          source: 'env_map',
        },
        'env_map'
      );
    })
    .filter((item) => item && item.user_id);
};

// mergeCalendarMappingsByUser
// 是什么：按员工去重合并函数。
// 做什么：以 `user_id` 为键合并映射，后写入值覆盖先写入值。
// 为什么：同一员工可能在多处配置，需保证最终映射唯一且可预测。
const mergeCalendarMappingsByUser = (rows = []) => {
  const merged = new Map();
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const normalized = toCalendarMappingRecord(row, normalizeText(row && row.source) || 'db');
    if (!normalized || !normalized.user_id) {
      return;
    }

    merged.set(normalized.user_id, normalized);
  });

  return Array.from(merged.values());
};

// deduplicateCalendarTargetsByCalId
// 是什么：按日历去重函数。
// 做什么：基于 `cal_id` 去重同步目标，保留首个目标以避免重复拉取。
// 为什么：多个员工可能错误绑定同一日历，重复拉取会导致额外开销与重复处理。
const deduplicateCalendarTargetsByCalId = (targets = []) => {
  const seenCalIds = new Set();
  const result = [];

  (Array.isArray(targets) ? targets : []).forEach((target) => {
    const normalized = toCalendarMappingRecord(target, normalizeText(target && target.source) || 'default');
    if (!normalized || seenCalIds.has(normalized.cal_id)) {
      return;
    }

    seenCalIds.add(normalized.cal_id);
    result.push(normalized);
  });

  return result;
};

// parseUserCalendarMap
// 是什么：员工日历映射统一解析函数。
// 做什么：自动识别 JSON 或键值串配置并输出去重后的映射列表。
// 为什么：同步服务与任务创建都需要同一套映射口径，避免配置解释不一致。
const parseUserCalendarMap = (rawValue) => {
  const normalizedRaw = normalizeText(rawValue);
  if (!normalizedRaw) {
    return [];
  }

  const firstChar = normalizedRaw[0];
  const parsedRows = firstChar === '{' || firstChar === '['
    ? (() => {
        try {
          return parseUserCalendarMapFromJson(normalizedRaw);
        } catch (error) {
          return parseUserCalendarMapFromPairs(normalizedRaw);
        }
      })()
    : parseUserCalendarMapFromPairs(normalizedRaw);

  return mergeCalendarMappingsByUser(parsedRows);
};

// buildSyncCalendarTargets
// 是什么：日程同步目标构建函数。
// 做什么：融合数据库映射、环境变量映射与默认日历，生成最终待同步日历列表。
// 为什么：支持“每员工一个 cal_id”与历史默认日历模式并存，保障平滑迁移。
const buildSyncCalendarTargets = (options = {}) => {
  const defaultCalId = normalizeText(options.defaultCalId);
  const envMapRows = parseUserCalendarMap(options.userCalendarMapRaw);
  const dbRows = mergeCalendarMappingsByUser(options.userCalendarRows || []);

  const mergedByUser = mergeCalendarMappingsByUser([...envMapRows, ...dbRows]);

  const targets = deduplicateCalendarTargetsByCalId(mergedByUser);

  if (defaultCalId) {
    const defaultTarget = {
      user_id: '',
      cal_id: defaultCalId,
      source: 'default',
    };
    targets.push(defaultTarget);
  }

  return deduplicateCalendarTargetsByCalId(targets);
};

// resolveCalendarIdByUser
// 是什么：员工目标日历解析函数。
// 做什么：按员工ID优先返回映射日历，缺失时回退默认日历。
// 为什么：手动创建任务时需要稳定选择写入日历，确保任务能落到个人业务日历。
const resolveCalendarIdByUser = (userId, options = {}) => {
  const normalizedUserId = normalizeText(userId);
  const defaultCalId = normalizeText(options.defaultCalId);

  if (!normalizedUserId) {
    return defaultCalId;
  }

  const mappingRows = mergeCalendarMappingsByUser([
    ...parseUserCalendarMap(options.userCalendarMapRaw),
    ...(Array.isArray(options.userCalendarRows) ? options.userCalendarRows : []),
  ]);
  const mappingByUser = new Map(mappingRows.map((item) => [item.user_id, item.cal_id]));

  if (mappingByUser.has(normalizedUserId)) {
    return mappingByUser.get(normalizedUserId);
  }

  return defaultCalId;
};

module.exports = {
  parseUserCalendarMap,
  buildSyncCalendarTargets,
  resolveCalendarIdByUser,
};
