import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CalendarClock,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  PencilLine,
  RefreshCw,
  Search,
  Trash2,
  UserRoundPlus,
} from 'lucide-react';
import {
  addScheduleAttendees,
  cancelSchedule,
  createSchedule,
  ensureUserCalendar,
  getCalendarMappings,
  getCalendarSchedules,
  getOrgUsers,
  removeScheduleAttendees,
  updateSchedule,
  type CalendarMappingRow,
  type OrgUserProfile,
  type OrgUsersResponse,
  type WecomApiResult,
} from '../api';
import { useAuth } from '../contexts/AuthContext';
import { useTranslation } from '../contexts/LanguageContext';

// WEEKDAY_LABELS
// 是什么：周标题常量。
// 做什么：定义月视图展示顺序为周日到周六。
// 为什么：与企业微信日历默认布局一致，降低用户理解成本。
const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

// toDatetimeLocal
// 是什么：日期时间本地字符串格式化函数。
// 做什么：将 Date 转换为 `<input type="datetime-local">` 可用格式。
// 为什么：用于创建/更新日程表单，减少用户手动输入。
const toDatetimeLocal = (value: Date) => {
  const local = new Date(value.getTime() - value.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
};

// toDateKey
// 是什么：日期主键格式化函数。
// 做什么：将时间值统一转换为 `YYYY-MM-DD` 格式字符串。
// 为什么：月历网格与事件索引需要稳定键值做映射。
const toDateKey = (value: Date) => {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

// buildEventDayKeys
// 是什么：日程覆盖日期键列表构建函数。
// 做什么：把一个日程的开始/结束时间展开为其跨越的所有自然日 `YYYY-MM-DD` 键值。
// 为什么：跨天日程不能只挂在开始日期，否则结束日和中间日期都无法在日历中正确展示。
const buildEventDayKeys = (startUnixSeconds: number, endUnixSeconds: number) => {
  const startDate = new Date(Number(startUnixSeconds || 0) * 1000);
  const endDate = new Date(Number(endUnixSeconds || 0) * 1000);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    return [] as string[];
  }

  const startDay = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
  const endDay = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
  if (endDay.getTime() < startDay.getTime()) {
    return [] as string[];
  }

  const result: string[] = [];
  const cursor = new Date(startDay);
  while (cursor.getTime() <= endDay.getTime() && result.length < 90) {
    result.push(toDateKey(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return result;
};

// doesEventIntersectMonth
// 是什么：日程与目标月份交集判断函数。
// 做什么：判断某个日程是否覆盖目标月份内任意一天。
// 为什么：跨月日程若仅按开始时间计数，会导致当前月份“可见日程数”与实际月历展示不一致。
const doesEventIntersectMonth = (event: { startTime: number; endTime: number }, month: Date) => {
  const monthStart = new Date(month.getFullYear(), month.getMonth(), 1).getTime();
  const nextMonthStart = new Date(month.getFullYear(), month.getMonth() + 1, 1).getTime();
  const eventStart = Number(event.startTime || 0) * 1000;
  const eventEnd = Number(event.endTime || 0) * 1000;
  return eventStart < nextMonthStart && eventEnd >= monthStart;
};

// formatMonthTitle
// 是什么：月标题格式化函数。
// 做什么：输出“YYYY年M月”样式。
// 为什么：保证主月历与迷你月历展示一致。
const formatMonthTitle = (value: Date) => `${value.getFullYear()}年${value.getMonth() + 1}月`;

// toUnixSeconds
// 是什么：本地时间转 Unix 秒函数。
// 做什么：将 datetime-local 字符串转换为秒级时间戳。
// 为什么：企业微信日程接口要求秒级时间戳。
const toUnixSeconds = (input: string): number | undefined => {
  if (!input.trim()) {
    return undefined;
  }

  const date = new Date(input);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  return Math.floor(date.getTime() / 1000);
};

// fromUnixSecondsToDatetimeLocal
// 是什么：Unix 秒转 datetime-local 字符串函数。
// 做什么：将秒级时间戳回填到更新表单。
// 为什么：编辑日程时需要把已选日程时间回显到输入框。
const fromUnixSecondsToDatetimeLocal = (seconds: number) => {
  return toDatetimeLocal(new Date(seconds * 1000));
};

// buildMonthCells
// 是什么：月视图网格构建函数。
// 做什么：基于目标月份生成固定 6x7 共 42 个日期单元。
// 为什么：保持月视图高度稳定，避免跨月时页面抖动。
const buildMonthCells = (month: Date): Date[] => {
  const startOfMonth = new Date(month.getFullYear(), month.getMonth(), 1);
  const offset = startOfMonth.getDay();
  const gridStart = new Date(startOfMonth);
  gridStart.setDate(gridStart.getDate() - offset);

  return Array.from({ length: 42 }).map((_, index) => {
    const next = new Date(gridStart);
    next.setDate(gridStart.getDate() + index);
    return next;
  });
};

// buildDefaultRangeByDayKey
// 是什么：按日期生成默认时间区间函数。
// 做什么：返回指定日期的 09:00 - 10:00 默认时段。
// 为什么：让用户创建日程时快速完成最小输入。
const buildDefaultRangeByDayKey = (dayKey: string) => {
  const [year, month, day] = String(dayKey || '')
    .split('-')
    .map((item) => Number(item));
  if (!year || !month || !day) {
    const fallbackStart = new Date();
    const fallbackEnd = new Date(fallbackStart.getTime() + 60 * 60 * 1000);
    return {
      startAt: toDatetimeLocal(fallbackStart),
      endAt: toDatetimeLocal(fallbackEnd),
    };
  }

  const start = new Date(year, month - 1, day, 9, 0, 0, 0);
  const end = new Date(year, month - 1, day, 10, 0, 0, 0);
  return {
    startAt: toDatetimeLocal(start),
    endAt: toDatetimeLocal(end),
  };
};

// MENTION_TOKEN_REGEX
// 是什么：`@提及` 词元正则常量。
// 做什么：从输入文本中提取 `@姓名` / `@姓名(userid)` 片段。
// 为什么：创建/编辑日程时需要将提及对象转换为内部参与人或外部提醒对象。
const MENTION_TOKEN_REGEX = /@([^\s@，,。；;]+)/g;

// EXTERNAL_REMINDER_PREFIX
// 是什么：外部提醒描述前缀常量。
// 做什么：统一在日程说明中写入外部提醒标记行。
// 为什么：企业微信日程参与人仅支持内部成员，外部提醒需落在说明文本中。
const EXTERNAL_REMINDER_PREFIX = '外部提醒：';

// MentionResolvedResult
// 是什么：`@提及` 解析结果模型。
// 做什么：承载内部成员、外部提醒对象与原始提及词元集合。
// 为什么：创建/更新日程时需要同时处理“参与人写入”和“说明补充”两类行为。
interface MentionResolvedResult {
  internalUsers: Array<{ userid: string; displayName: string }>;
  externalNames: string[];
  rawMentionTokens: string[];
  rawTextEntries: string[];
}

// extractMentionTokens
// 是什么：提及词元提取函数。
// 做什么：从输入文本中提取去重后的 `@` 词元并去掉前导 `@`。
// 为什么：后续需要基于稳定词元做内部成员匹配与外部提醒归类。
const extractMentionTokens = (value: string) => {
  const normalizedText = String(value || '').trim();
  if (!normalizedText) {
    return [] as string[];
  }

  const tokenSet = new Set<string>();
  for (const matched of normalizedText.matchAll(MENTION_TOKEN_REGEX)) {
    const rawToken = String((matched && matched[1]) || '').trim();
    if (rawToken) {
      tokenSet.add(rawToken);
    }
  }
  return Array.from(tokenSet);
};

// extractPlainReminderEntries
// 是什么：纯文本提醒对象提取函数。
// 做什么：移除 `@提及` 片段后，将剩余文本按换行、逗号、顿号、分号拆分为提醒对象列表。
// 为什么：让“其他人”支持直接文本填写，不再强制使用 `@姓名` 格式。
const extractPlainReminderEntries = (value: string) => {
  const normalizedText = String(value || '').trim();
  if (!normalizedText) {
    return [] as string[];
  }

  const textWithoutMentionTokens = normalizedText.replace(MENTION_TOKEN_REGEX, ' ');
  const entrySet = new Set<string>();
  textWithoutMentionTokens
    .split(/[\n,，、;；]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .forEach((item) => entrySet.add(item));
  return Array.from(entrySet);
};

// buildMentionCandidates
// 是什么：内部成员提及候选构建函数。
// 做什么：按关键词过滤并返回最多 8 位可插入的组织成员。
// 为什么：降低手工输入 user_id 的门槛，支持在日程表单快速选择内部提醒人。
const buildMentionCandidates = (users: OrgUserProfile[], keyword: string) => {
  const normalizedKeyword = String(keyword || '').trim().toLowerCase();
  if (!normalizedKeyword) {
    return users.slice(0, 8);
  }

  return users
    .filter((item) => {
      const userId = String(item.userid || '').toLowerCase();
      const name = String(item.name || '').toLowerCase();
      return userId.includes(normalizedKeyword) || name.includes(normalizedKeyword);
    })
    .slice(0, 8);
};

// appendMentionToken
// 是什么：提及词元追加函数。
// 做什么：将 `@词元` 以去重方式追加到输入文本末尾。
// 为什么：点击候选成员后需快速补全提及文本，避免重复插入。
const appendMentionToken = (text: string, token: string) => {
  const normalizedToken = String(token || '')
    .trim()
    .replace(/^@+/, '');
  if (!normalizedToken) {
    return text;
  }

  const exists = extractMentionTokens(text).some(
    (item) => item.toLowerCase() === normalizedToken.toLowerCase()
  );
  if (exists) {
    return text;
  }

  const trimmedEnd = String(text || '').trimEnd();
  return `${trimmedEnd ? `${trimmedEnd} ` : ''}@${normalizedToken} `;
};

// resolveMentionTargets
// 是什么：提及对象归一化函数。
// 做什么：将 `@词元` 解析为内部成员与外部提醒对象两类结果。
// 为什么：内部成员需写入 `attendees`，外部对象需落库到说明文本实现提醒留痕。
const resolveMentionTargets = (value: string, users: OrgUserProfile[]): MentionResolvedResult => {
  const tokens = extractMentionTokens(value);
  const textEntries = extractPlainReminderEntries(value);
  const internalMap = new Map<string, { userid: string; displayName: string }>();
  const externalSet = new Set<string>();

  const usersByUserId = new Map<string, OrgUserProfile>();
  const usersByName = new Map<string, OrgUserProfile[]>();
  users.forEach((item) => {
    const userId = String(item.userid || '').trim();
    const name = String(item.name || '').trim();
    if (userId) {
      usersByUserId.set(userId.toLowerCase(), item);
    }
    if (name) {
      const key = name.toLowerCase();
      const existed = usersByName.get(key) || [];
      usersByName.set(key, [...existed, item]);
    }
  });

  const classifyReminderEntry = (entry: string) => {
    const normalizedToken = String(entry || '').trim();
    if (!normalizedToken) {
      return;
    }

    const bracketMatched = normalizedToken.match(/^(.+)\(([^()]+)\)$/);
    if (bracketMatched) {
      const displayName = String(bracketMatched[1] || '').trim();
      const bracketUserId = String(bracketMatched[2] || '').trim();
      const matchedUser = usersByUserId.get(bracketUserId.toLowerCase());
      if (matchedUser) {
        const userId = String(matchedUser.userid || '').trim();
        if (userId) {
          internalMap.set(userId, {
            userid: userId,
            displayName: String(matchedUser.name || userId).trim() || userId,
          });
          return;
        }
      }
      if (bracketUserId) {
        internalMap.set(bracketUserId, {
          userid: bracketUserId,
          displayName: displayName || bracketUserId,
        });
        return;
      }
      externalSet.add(displayName || normalizedToken);
      return;
    }

    const byUserId = usersByUserId.get(normalizedToken.toLowerCase());
    if (byUserId) {
      const userId = String(byUserId.userid || '').trim();
      if (userId) {
        internalMap.set(userId, {
          userid: userId,
          displayName: String(byUserId.name || userId).trim() || userId,
        });
        return;
      }
    }

    const byNameList = usersByName.get(normalizedToken.toLowerCase()) || [];
    if (byNameList.length === 1) {
      const matchedUser = byNameList[0];
      const userId = String(matchedUser.userid || '').trim();
      if (userId) {
        internalMap.set(userId, {
          userid: userId,
          displayName: String(matchedUser.name || userId).trim() || userId,
        });
        return;
      }
    }

    externalSet.add(normalizedToken);
  };

  tokens.forEach((token) => classifyReminderEntry(token));
  textEntries.forEach((entry) => classifyReminderEntry(entry));

  return {
    internalUsers: Array.from(internalMap.values()),
    externalNames: Array.from(externalSet),
    rawMentionTokens: tokens,
    rawTextEntries: textEntries,
  };
};

// ReminderChipItem
// 是什么：提醒对象展示标签模型。
// 做什么：统一描述右侧表单中“已选同事/其他文本对象”的标签展示与移除元数据。
// 为什么：点选同事与手工文本会共存在同一输入域，需要稳定的可视化结构承载。
interface ReminderChipItem {
  key: string;
  label: string;
  caption: string;
  tone: 'internal' | 'external';
  entryKind: 'mention' | 'text';
  rawValue: string;
}

// buildReminderChipItems
// 是什么：提醒对象标签构建函数。
// 做什么：把提及词元与纯文本提醒对象转换为可渲染、可移除的标签列表。
// 为什么：右侧交互需要明确展示“已选同事”和“其他对象”，减少用户对原始文本格式的理解负担。
const buildReminderChipItems = (value: string, users: OrgUserProfile[]): ReminderChipItem[] => {
  const usersByUserId = new Map<string, OrgUserProfile>();
  const usersByName = new Map<string, OrgUserProfile[]>();

  users.forEach((item) => {
    const userId = String(item.userid || '').trim();
    const name = String(item.name || '').trim();
    if (userId) {
      usersByUserId.set(userId.toLowerCase(), item);
    }
    if (name) {
      const key = name.toLowerCase();
      const existed = usersByName.get(key) || [];
      usersByName.set(key, [...existed, item]);
    }
  });

  const items: ReminderChipItem[] = [];
  const seenKeys = new Set<string>();

  const pushReminderChip = (rawValue: string, entryKind: 'mention' | 'text') => {
    const normalizedValue = String(rawValue || '').trim();
    if (!normalizedValue) {
      return;
    }

    const lowerValue = normalizedValue.toLowerCase();
    const bracketMatched = normalizedValue.match(/^(.+)\(([^()]+)\)$/);
    if (bracketMatched) {
      const displayName = String(bracketMatched[1] || '').trim();
      const bracketUserId = String(bracketMatched[2] || '').trim();
      const matchedUser = usersByUserId.get(bracketUserId.toLowerCase());
      const key = `${entryKind}:${lowerValue}`;
      if (seenKeys.has(key)) {
        return;
      }

      seenKeys.add(key);
      items.push({
        key,
        label:
          String((matchedUser && matchedUser.name) || displayName || bracketUserId).trim() ||
          normalizedValue,
        caption: bracketUserId || '内部同事',
        tone: 'internal',
        entryKind,
        rawValue: normalizedValue,
      });
      return;
    }

    const byUserId = usersByUserId.get(lowerValue);
    if (byUserId) {
      const userId = String(byUserId.userid || '').trim();
      const key = `${entryKind}:${lowerValue}`;
      if (seenKeys.has(key)) {
        return;
      }

      seenKeys.add(key);
      items.push({
        key,
        label: String(byUserId.name || userId).trim() || userId,
        caption: userId,
        tone: 'internal',
        entryKind,
        rawValue: normalizedValue,
      });
      return;
    }

    const byNameList = usersByName.get(lowerValue) || [];
    if (byNameList.length === 1) {
      const matchedUser = byNameList[0];
      const userId = String(matchedUser.userid || '').trim();
      const key = `${entryKind}:${lowerValue}`;
      if (seenKeys.has(key)) {
        return;
      }

      seenKeys.add(key);
      items.push({
        key,
        label: String(matchedUser.name || userId).trim() || normalizedValue,
        caption: userId || '内部同事',
        tone: 'internal',
        entryKind,
        rawValue: normalizedValue,
      });
      return;
    }

    const key = `${entryKind}:${lowerValue}`;
    if (seenKeys.has(key)) {
      return;
    }

    seenKeys.add(key);
    items.push({
      key,
      label: normalizedValue,
      caption: entryKind === 'mention' ? '文本提及' : '手动文本',
      tone: 'external',
      entryKind,
      rawValue: normalizedValue,
    });
  };

  extractMentionTokens(value).forEach((item) => pushReminderChip(item, 'mention'));
  extractPlainReminderEntries(value).forEach((item) => pushReminderChip(item, 'text'));
  return items;
};

// removeReminderEntry
// 是什么：提醒对象移除函数。
// 做什么：从原始输入文本中删除指定的提及词元或纯文本对象，并重新生成规范化文本。
// 为什么：右侧新交互需要支持点击标签直接移除对象，而不是要求用户手动改写整段输入。
const removeReminderEntry = (value: string, rawValue: string, entryKind: 'mention' | 'text') => {
  const normalizedRawValue = String(rawValue || '').trim().toLowerCase();
  const nextMentionTokens = extractMentionTokens(value).filter((item) => {
    if (entryKind !== 'mention') {
      return true;
    }
    return String(item || '').trim().toLowerCase() !== normalizedRawValue;
  });
  const nextTextEntries = extractPlainReminderEntries(value).filter((item) => {
    if (entryKind !== 'text') {
      return true;
    }
    return String(item || '').trim().toLowerCase() !== normalizedRawValue;
  });

  const mentionPart = nextMentionTokens.map((item) => `@${item}`).join(' ');
  const textPart = nextTextEntries.join('，');
  return [mentionPart, textPart].filter(Boolean).join('\n');
};

// composeDescriptionWithExternalMentions
// 是什么：说明文本与外部提醒合成函数。
// 做什么：移除旧的外部提醒行并追加最新 `外部提醒：@...` 标记。
// 为什么：避免重复堆叠提醒文本，确保更新日程时描述内容始终可读且幂等。
const composeDescriptionWithExternalMentions = (description: string, externalNames: string[]) => {
  const rawLines = String(description || '')
    .split('\n')
    .map((line) => line.trimEnd());
  const keptLines = rawLines.filter(
    (line) => !String(line || '').trim().startsWith(EXTERNAL_REMINDER_PREFIX)
  );
  const cleanedDescription = keptLines.join('\n').trim();

  if (!externalNames.length) {
    return cleanedDescription;
  }

  const reminderLine = `${EXTERNAL_REMINDER_PREFIX}${externalNames.map((item) => `@${item}`).join(' ')}`;
  return cleanedDescription ? `${cleanedDescription}\n\n${reminderLine}` : reminderLine;
};

// toRecord
// 是什么：弱类型对象归一化函数。
// 做什么：将未知输入安全转换为键值对象。
// 为什么：企业微信返回结构在不同接口间存在层级差异，需要容错处理。
const toRecord = (value: unknown): Record<string, unknown> => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
};

// parseUnixFromUnknown
// 是什么：通用 Unix 时间解析函数。
// 做什么：兼容 number/string/object(time 字段) 输入并输出秒级时间戳。
// 为什么：统一处理企微返回中不同形态的时间字段。
const parseUnixFromUnknown = (value: unknown): number => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.floor(value);
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return 0;
    }
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) {
      return Math.floor(numeric);
    }
    const date = new Date(trimmed);
    if (!Number.isNaN(date.getTime())) {
      return Math.floor(date.getTime() / 1000);
    }
  }

  const asObject = toRecord(value);
  if (Object.prototype.hasOwnProperty.call(asObject, 'time')) {
    return parseUnixFromUnknown(asObject.time);
  }
  if (Object.prototype.hasOwnProperty.call(asObject, 'start_time')) {
    return parseUnixFromUnknown(asObject.start_time);
  }
  if (Object.prototype.hasOwnProperty.call(asObject, 'end_time')) {
    return parseUnixFromUnknown(asObject.end_time);
  }
  return 0;
};

// extractScheduleRecords
// 是什么：日程列表提取函数。
// 做什么：从接口返回体中提取 `schedule_list` 并统一转为对象数组。
// 为什么：`get_by_calendar/get` 返回结构不完全一致，需要单点收敛。
const extractScheduleRecords = (result: unknown): Record<string, unknown>[] => {
  const root = toRecord(result);
  const directList = root.schedule_list;
  if (Array.isArray(directList)) {
    return directList.map((item) => toRecord(item));
  }

  const nested = toRecord(root.data);
  if (Array.isArray(nested.schedule_list)) {
    return nested.schedule_list.map((item) => toRecord(item));
  }
  return [];
};

// resolveErrorMessage
// 是什么：错误消息提取函数。
// 做什么：优先从接口返回中提取业务错误，其次回退异常 message。
// 为什么：给用户展示可理解的失败原因，避免技术栈细节泄漏。
const resolveErrorMessage = (error: unknown) => {
  const maybeError = error as {
    response?: { data?: { message?: string; errmsg?: string; code?: string; errcode?: number | string } };
    message?: string;
  };
  const responseData = maybeError && maybeError.response ? maybeError.response.data : undefined;
  const message =
    (responseData && (responseData.message || responseData.errmsg)) || maybeError.message || '系统繁忙，请稍后重试';
  const errcode = Number(responseData && responseData.errcode);

  // resolveWecomFriendlyError
  // 是什么：企业微信错误友好文案映射函数。
  // 做什么：将 `60011/60020` 及等价关键字转换为用户可理解提示。
  // 为什么：结果面板不应暴露原始英文报错与调试链接，避免用户感知技术细节。
  const resolveWecomFriendlyError = (inputErrcode: number, inputMessage: string) => {
    const normalizedMessage = String(inputMessage || '').toLowerCase();
    if (inputErrcode === 60011 || normalizedMessage.includes('e=60011')) {
      return '当前应用缺少通讯录权限，暂时无法读取组织成员。请联系管理员在企业微信后台开启通讯录可见范围。';
    }
    if (
      inputErrcode === 60020 ||
      normalizedMessage.includes('e=60020') ||
      normalizedMessage.includes('not allow to access from your ip')
    ) {
      return '当前服务器出口 IP 尚未加入企微可信 IP，暂时无法读取组织成员。请在企业微信后台补充可信 IP 后重试。';
    }
    if (
      inputErrcode === 48009 ||
      normalizedMessage.includes('e=48009') ||
      normalizedMessage.includes('contact assistant')
    ) {
      return '当前日程接口被“通讯录助手”凭证拒绝（48009）。请将 `CORP_SECRET` 配置为业务应用 Secret，或新增 `WECOM_OA_SECRET/WECOM_AGENT_SECRET` 后重试。';
    }
    return '';
  };

  const friendlyMessage = resolveWecomFriendlyError(errcode, String(message));
  if (friendlyMessage) {
    return friendlyMessage;
  }

  const normalizedMessage = String(message || '').toLowerCase();
  if (
    normalizedMessage.includes('network error') ||
    normalizedMessage.includes('failed to fetch') ||
    normalizedMessage.includes('load failed')
  ) {
    return '组织成员服务暂时不可达，可能是企业微信网络、服务连接或代理配置异常。';
  }

  const code = responseData && typeof responseData.code === 'string' ? responseData.code.trim() : '';
  if (code && (code.startsWith('CALENDAR_') || code.startsWith('SCHEDULE_'))) {
    return `${message}（${code}）`;
  }
  return String(message);
};

// normalizeOrgUserProfiles
// 是什么：组织成员候选归一化函数。
// 做什么：对成员列表按 `userid` 去重，并按姓名排序输出稳定结果。
// 为什么：实时通讯录、本地快照和当前登录人回退可能同时进入页面，需要统一收口为一个候选集合。
const normalizeOrgUserProfiles = (rows: OrgUserProfile[]) => {
  const deduped = new Map<string, OrgUserProfile>();

  rows.forEach((item) => {
    const userId = String(item && item.userid ? item.userid : '').trim();
    if (!userId) {
      return;
    }

    deduped.set(userId, {
      ...item,
      userid: userId,
      name: String(item && item.name ? item.name : '').trim() || userId,
    });
  });

  return Array.from(deduped.values()).sort((left, right) => {
    const leftLabel = String(left.name || left.userid || '');
    const rightLabel = String(right.name || right.userid || '');
    return leftLabel.localeCompare(rightLabel, 'zh-Hans-CN');
  });
};

// buildOrgUsersDegradedHint
// 是什么：组织成员降级提示文案生成函数。
// 做什么：根据 `/api/users` 的降级标记生成可操作的页面提示。
// 为什么：用户需要知道当前候选来自本地缓存，而不是把系统状态误判成彻底失败。
const buildOrgUsersDegradedHint = (result: OrgUsersResponse, hasCandidates: boolean) => {
  if (!result || !result.degraded) {
    return '';
  }

  if (result.source === 'local_cache') {
    if (hasCandidates) {
      return '当前企业微信通讯录暂不可用，已回退到本地通讯录快照，候选成员可能略有延迟。';
    }
    return '当前企业微信通讯录暂不可用，本地通讯录快照也为空，请先手工输入联系人。';
  }

  return '当前组织成员列表已进入降级模式，请优先使用手工输入完成排期。';
};

// CalendarBoardEvent
// 是什么：月视图事件的数据模型。
// 做什么：承载 UI 展示必需字段（标题、时间、地点、参与人数等）。
// 为什么：与原始接口结构解耦，提升渲染稳定性。
interface CalendarBoardEvent {
  id: string;
  calId: string;
  summary: string;
  description: string;
  location: string;
  startTime: number;
  endTime: number;
  attendeesCount: number;
  attendeeUserIds: string[];
  ownerUserId: string;
  source: string;
}

// OperationRecord
// 是什么：操作反馈记录模型。
// 做什么：记录最近操作的结果与时间，供“结果”面板展示。
// 为什么：用用户可读反馈替代 JSON 原始输出。
interface OperationRecord {
  id: string;
  action: string;
  status: 'success' | 'error' | 'info';
  message: string;
  createdAt: string;
}

// ScheduleComposerState
// 是什么：创建日程表单模型。
// 做什么：承载用户创建日程所需基础字段。
// 为什么：保持创建流程极简，聚焦业务输入。
interface ScheduleComposerState {
  summary: string;
  description: string;
  location: string;
  startAt: string;
  endAt: string;
}

// ScheduleEditorState
// 是什么：编辑日程表单模型。
// 做什么：承载选中日程的可编辑字段。
// 为什么：以“选择事件后编辑”替代输入 schedule_id 的工程化方式。
interface ScheduleEditorState {
  summary: string;
  description: string;
  location: string;
  startAt: string;
  endAt: string;
}

// mapResultToBoardEvents
// 是什么：接口结果到月视图事件的映射函数。
// 做什么：将企微日程结构转换为统一事件模型。
// 为什么：查询结果需要直接可视化，减少页面层重复解析。
const mapResultToBoardEvents = (
  result: unknown,
  fallbackCalId = '',
  fallbackOwnerUserId = '',
  sourceTag = 'api_fetch'
): CalendarBoardEvent[] => {
  const scheduleRecords = extractScheduleRecords(result);

  return scheduleRecords
    .map((rawItem) => {
      const scheduleLayer = toRecord(rawItem.schedule);
      const source = Object.keys(scheduleLayer).length > 0 ? scheduleLayer : rawItem;
      const scheduleId = String(source.schedule_id || rawItem.schedule_id || '').trim();
      const calId = String(source.cal_id || rawItem.cal_id || fallbackCalId || '').trim();
      const summary = String(source.summary || source.title || '未命名日程').trim();
      const description = String(source.description || '').trim();
      const location = String(source.location || '').trim();
      const startTime = parseUnixFromUnknown(source.start_time || rawItem.start_time);
      const endTime = parseUnixFromUnknown(source.end_time || rawItem.end_time);
      const attendees = Array.isArray(source.attendees) ? source.attendees : [];
      const attendeeUserIds = Array.from(
        new Set(
          attendees
            .map((item) => String((toRecord(item).userid || item || '')).trim())
            .filter(Boolean)
        )
      );
      const ownerUserId = String(
        toRecord(source.organizer).userid || source.organizer || fallbackOwnerUserId || ''
      ).trim();

      if (!scheduleId || !startTime || !endTime) {
        return null;
      }

      return {
        id: scheduleId,
        calId,
        summary,
        description,
        location,
        startTime,
        endTime,
        attendeesCount: attendees.length,
        attendeeUserIds,
        ownerUserId,
        source: sourceTag,
      };
    })
    .filter((item): item is CalendarBoardEvent => Boolean(item));
};

// mergeBoardEvents
// 是什么：事件合并函数。
// 做什么：按 `id` 去重并以新事件覆盖旧事件。
// 为什么：避免“本地创建”和“接口回拉”产生重复展示。
const mergeBoardEvents = (currentEvents: CalendarBoardEvent[], incomingEvents: CalendarBoardEvent[]) => {
  const merged = new Map<string, CalendarBoardEvent>();
  currentEvents.forEach((item) => merged.set(item.id, item));
  incomingEvents.forEach((item) => merged.set(item.id, item));
  return Array.from(merged.values()).sort((a, b) => a.startTime - b.startTime);
};

// replaceBoardEventsByCalendarId
// 是什么：指定日历事件替换函数。
// 做什么：用远端最新快照替换目标日历的本地事件，同时保留其他日历事件。
// 为什么：页面重挂载或手动刷新后，应以当前日历的服务端数据为准，避免旧内存数据残留或丢失。
const replaceBoardEventsByCalendarId = (
  currentEvents: CalendarBoardEvent[],
  calId: string,
  incomingEvents: CalendarBoardEvent[]
) => {
  const normalizedCalId = String(calId || '').trim();
  if (!normalizedCalId) {
    return mergeBoardEvents(currentEvents, incomingEvents);
  }

  const eventsFromOtherCalendars = currentEvents.filter(
    (item) => String(item.calId || '').trim() !== normalizedCalId
  );
  return mergeBoardEvents(eventsFromOtherCalendars, incomingEvents);
};

// buildComparableParticipantUserIds
// 是什么：冲突校验参与人集合构建函数。
// 做什么：优先使用内部参与人列表，缺失时回退到日历归属人/组织者，输出去重后的账号集合。
// 为什么：用户允许“不同负责人同时间重叠”，冲突校验不能再只看时间段本身。
const buildComparableParticipantUserIds = (participantUserIds: string[] = [], fallbackUserId = '') => {
  const normalizedIds = Array.from(
    new Set(
      (Array.isArray(participantUserIds) ? participantUserIds : [])
        .map((item) => String(item || '').trim().toLowerCase())
        .filter(Boolean)
    )
  );

  if (normalizedIds.length > 0) {
    return normalizedIds;
  }

  const normalizedFallbackUserId = String(fallbackUserId || '').trim().toLowerCase();
  return normalizedFallbackUserId ? [normalizedFallbackUserId] : [];
};

// canUserViewCalendarEvent
// 是什么：日历事件可见性判定函数。
// 做什么：管理员可见全部事件，普通成员仅可见“自己创建”或“需要自己执行/参与”的事件。
// 为什么：日历页需要按登录身份裁剪可见范围，避免成员看到与自己无关的排期。
const canUserViewCalendarEvent = (
  event: Pick<CalendarBoardEvent, 'attendeeUserIds' | 'ownerUserId'>,
  options: { currentUserId: string; isAdmin: boolean }
) => {
  if (options.isAdmin) {
    return true;
  }

  const normalizedCurrentUserId = String(options.currentUserId || '').trim().toLowerCase();
  if (!normalizedCurrentUserId) {
    return false;
  }

  const comparableParticipantUserIds = buildComparableParticipantUserIds(
    event.attendeeUserIds,
    event.ownerUserId
  );
  return comparableParticipantUserIds.includes(normalizedCurrentUserId);
};

// canUserMutateCalendarEvent
// 是什么：日历事件编辑/删除权限判定函数。
// 做什么：管理员可修改全部事件，普通成员仅可修改自己创建的事件。
// 为什么：成员虽然能看到分配给自己的日程，但不能改动他人创建的执行安排。
const canUserMutateCalendarEvent = (
  event: Pick<CalendarBoardEvent, 'ownerUserId'>,
  options: { currentUserId: string; isAdmin: boolean }
) => {
  if (options.isAdmin) {
    return true;
  }

  const normalizedCurrentUserId = String(options.currentUserId || '').trim().toLowerCase();
  const normalizedOwnerUserId = String(event.ownerUserId || '').trim().toLowerCase();
  if (!normalizedCurrentUserId || !normalizedOwnerUserId) {
    return false;
  }

  return normalizedCurrentUserId === normalizedOwnerUserId;
};

// hasInvalidDateTimeRange
// 是什么：日期时间区间合法性判定函数。
// 做什么：在开始/结束时间都已填写后，校验结束时间是否严格晚于开始时间。
// 为什么：仅靠提交时兜底提示不够，界面层也需要即时阻止无效区间继续提交。
const hasInvalidDateTimeRange = (startAt: string, endAt: string) => {
  const normalizedStartAt = String(startAt || '').trim();
  const normalizedEndAt = String(endAt || '').trim();
  if (!normalizedStartAt || !normalizedEndAt) {
    return false;
  }

  const startTime = toUnixSeconds(normalizedStartAt);
  const endTime = toUnixSeconds(normalizedEndAt);
  if (!startTime || !endTime) {
    return true;
  }

  return endTime <= startTime;
};

// findConflictingEvent
// 是什么：时间冲突检测函数。
// 做什么：在同一日历事件集合内检测与目标时间段重叠的首个事件。
// 为什么：创建/编辑日程前需阻止时间冲突，避免同一用户日历重复占用时段。
const findConflictingEvent = (
  events: CalendarBoardEvent[],
  options: {
    calId: string;
    startTime: number;
    endTime: number;
    excludeEventId?: string;
    participantUserIds?: string[];
    fallbackOwnerUserId?: string;
  }
) => {
  const targetCalId = String(options.calId || '').trim();
  const targetStartTime = Number(options.startTime || 0);
  const targetEndTime = Number(options.endTime || 0);
  const excludeEventId = String(options.excludeEventId || '').trim();
  const targetParticipantUserIds = buildComparableParticipantUserIds(
    options.participantUserIds,
    options.fallbackOwnerUserId
  );

  if (!targetCalId || !targetStartTime || !targetEndTime || targetEndTime <= targetStartTime) {
    return null;
  }

  return (
    events.find((event) => {
      if (excludeEventId && event.id === excludeEventId) {
        return false;
      }
      if (String(event.calId || '').trim() !== targetCalId) {
        return false;
      }

      // overlap
      // 是什么：时间区间重叠判定。
      // 做什么：采用 `[start,end)` 规则判断两个区间是否交叠。
      // 为什么：避免相邻边界被误判冲突，同时兼容日程分钟级编辑。
      const overlap = targetStartTime < event.endTime && event.startTime < targetEndTime;
      if (!overlap) {
        return false;
      }

      const existingParticipantUserIds = buildComparableParticipantUserIds(
        event.attendeeUserIds,
        event.ownerUserId
      );
      if (targetParticipantUserIds.length > 0 && existingParticipantUserIds.length > 0) {
        const existingParticipantSet = new Set(existingParticipantUserIds);
        const hasSharedParticipant = targetParticipantUserIds.some((item) => existingParticipantSet.has(item));
        if (!hasSharedParticipant) {
          return false;
        }
      }

      return true;
    }) || null
  );
};

// ReminderInputPanelProps
// 是什么：提醒对象输入面板属性模型。
// 做什么：统一描述“选择同事 + 文本补充”交互所需的状态、数据和事件回调。
// 为什么：创建态和编辑态交互一致，抽成复用面板可避免两套 UI 漂移。
interface ReminderInputPanelProps {
  title: string;
  helperText: string;
  searchKeyword: string;
  onSearchKeywordChange: (value: string) => void;
  rawValue: string;
  onRawValueChange: (value: string) => void;
  chips: ReminderChipItem[];
  mentionResult: MentionResolvedResult;
  candidates: OrgUserProfile[];
  onPickMember: (member: OrgUserProfile) => void;
  onRemoveChip: (chip: ReminderChipItem) => void;
  disabled?: boolean;
  loading: boolean;
  orgUsersLoading: boolean;
  orgUsersErrorHint: string;
}

// ReminderInputPanel
// 是什么：提醒对象混合输入面板组件。
// 做什么：提供“搜索并点选同事”与“手工文本填写其他对象”的组合交互，同时显示已选摘要。
// 为什么：把复杂的 `@提及` 心智改成可视化操作，减少培训成本和输入错误。
const ReminderInputPanel: React.FC<ReminderInputPanelProps> = ({
  title,
  helperText,
  searchKeyword,
  onSearchKeywordChange,
  rawValue,
  onRawValueChange,
  chips,
  mentionResult,
  candidates,
  onPickMember,
  onRemoveChip,
  disabled = false,
  loading,
  orgUsersLoading,
  orgUsersErrorHint,
}) => {
  const [dropdownOpen, setDropdownOpen] = useState(false);

  return (
    <div className="space-y-3 rounded-2xl border border-slate-200 bg-gradient-to-b from-slate-50 via-white to-white p-3 shadow-[0_16px_30px_-24px_rgba(15,23,42,0.7)]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold text-slate-900">{title}</p>
          <p className="mt-1 text-[11px] leading-5 text-slate-500">{helperText}</p>
        </div>
        <div className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-600">
          内部 {mentionResult.internalUsers.length} · 其他 {mentionResult.externalNames.length}
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">已加入对象</p>
        {chips.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-200 bg-white px-3 py-3 text-[11px] text-slate-400">
            还没有跟进对象。点选同事或在下方直接输入其他联系人。
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {chips.map((chip) => (
              <div
                key={chip.key}
                className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1.5 text-[11px] ${
                  chip.tone === 'internal'
                    ? 'border-blue-200 bg-blue-50 text-blue-700'
                    : 'border-amber-200 bg-amber-50 text-amber-700'
                }`}
              >
                <span className="font-semibold">{chip.label}</span>
                <span className="text-[10px] opacity-80">{chip.caption}</span>
                <button
                  type="button"
                  onClick={() => onRemoveChip(chip)}
                  className="rounded-full border border-current/20 px-1.5 py-0.5 text-[10px] transition hover:bg-white/60"
                  disabled={disabled || loading}
                >
                  移除
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="space-y-2 rounded-xl border border-slate-200 bg-white p-3">
        <div className="flex items-center gap-2">
          <UserRoundPlus className="h-4 w-4 text-blue-600" />
          <p className="text-[11px] font-semibold text-slate-700">选择跟进同事</p>
        </div>
        <div className="relative">
          <label className="relative block">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
            <input
              value={searchKeyword}
              onChange={(event) => onSearchKeywordChange(event.target.value)}
              onFocus={() => setDropdownOpen(true)}
              onBlur={() => setTimeout(() => setDropdownOpen(false), 150)}
              placeholder={orgUsersLoading ? '正在加载组织成员...' : '搜索姓名、账号或岗位...'}
              className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2 pl-9 pr-3 text-sm text-slate-700 transition focus:border-blue-400 focus:bg-white focus:outline-none"
              disabled={disabled || loading}
            />
          </label>
          {dropdownOpen && (
            <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg">
              {candidates.length > 0 ? (
                <div className="max-h-48 overflow-y-auto">
                  {candidates.map((member) => {
                    const userId = String(member.userid || '').trim();
                    if (!userId) return null;
                    const displayName = String(member.name || userId).trim() || userId;
                    const position = String(member.position || '').trim();
                    return (
                      <button
                        key={`reminder-candidate-${userId}`}
                        type="button"
                        onMouseDown={() => {
                          onPickMember(member);
                          onSearchKeywordChange('');
                          setDropdownOpen(false);
                        }}
                        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-blue-50 disabled:opacity-60"
                        disabled={disabled || loading}
                      >
                        <span className="text-sm font-medium text-slate-800">{displayName}</span>
                        <span className="text-xs text-slate-400">
                          {userId}
                          {position ? ` · ${position}` : ''}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="px-3 py-3 text-[11px] text-slate-400">
                  {orgUsersLoading ? '正在加载候选成员...' : searchKeyword ? '没有找到匹配的同事' : '没有更多可加入的同事'}
                </div>
              )}
            </div>
          )}
        </div>
        {orgUsersErrorHint ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-5 text-amber-700">
            {orgUsersErrorHint}
          </div>
        ) : null}
      </div>

      <div className="space-y-2 rounded-xl border border-slate-200 bg-white p-3">
        <div className="flex items-center gap-2">
          <PencilLine className="h-4 w-4 text-slate-500" />
          <p className="text-[11px] font-semibold text-slate-700">其他人 / 文本补充</p>
        </div>
        <textarea
          value={rawValue}
          onChange={(event) => onRawValueChange(event.target.value)}
          placeholder="@张三(zhangsan)\n客户王总，供应商李工"
          className="min-h-[92px] w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700 transition focus:border-blue-400 focus:bg-white focus:outline-none"
          disabled={disabled || loading}
        />
        <p className="text-[10px] leading-5 text-slate-400">
          内部同事可直接点选；其他人支持直接输入文本，建议用换行、逗号或顿号分隔。若填写 `@姓名(userid)`，系统会优先按企业账号识别。
        </p>
      </div>
    </div>
  );
};

interface CalendarManagerProps {
  onTaskDataChanged?: () => Promise<void> | void;
}

const CalendarManager: React.FC<CalendarManagerProps> = ({ onTaskDataChanged }) => {
  const { t } = useTranslation();
  const { user } = useAuth();

  const [loading, setLoading] = useState(false);
  const [mappings, setMappings] = useState<CalendarMappingRow[]>([]);
  // mappingsLoaded
  // 是什么：日历映射首次加载完成标记。
  // 做什么：区分“尚未拉取映射”和“已确认当前用户暂无映射”两种状态。
  // 为什么：只有在确认当前没有映射后，页面才应自动触发个人日历确保，避免把已有映射误判成缺失。
  const [mappingsLoaded, setMappingsLoaded] = useState(false);
  const [events, setEvents] = useState<CalendarBoardEvent[]>([]);
  const [eventKeyword, setEventKeyword] = useState('');
  const [activeCalId, setActiveCalId] = useState('');
  const [selectedEventId, setSelectedEventId] = useState('');
  const [latestOperation, setLatestOperation] = useState<OperationRecord | null>(null);
  const [operationHistory, setOperationHistory] = useState<OperationRecord[]>([]);
  const [orgUsers, setOrgUsers] = useState<OrgUserProfile[]>([]);
  const [orgUsersLoading, setOrgUsersLoading] = useState(false);
  // orgUsersErrorHint
  // 是什么：组织成员加载失败提示状态。
  // 做什么：承载参与人面板中的友好错误文案。
  // 为什么：成员为空时需要区分“筛选无结果”和“接口不可用”。
  const [orgUsersErrorHint, setOrgUsersErrorHint] = useState('');
  // miniCalendarCollapsed
  // 是什么：迷你月历折叠状态。
  // 做什么：控制桌面端辅助月历是否仅保留标题栏。
  // 为什么：用户需要左右分屏主视图，同时又希望迷你月历可以按需收起减少占位。
  const [miniCalendarCollapsed, setMiniCalendarCollapsed] = useState(() => {
    if (typeof window === 'undefined') {
      return false;
    }
    return window.innerWidth < 1280;
  });
  const [attendeeKeyword, setAttendeeKeyword] = useState('');
  const [selectedAttendeeUserIds, setSelectedAttendeeUserIds] = useState<string[]>([]);
  // scheduleComposerMentions
  // 是什么：创建日程提及输入状态。
  // 做什么：保存用户在创建区输入的 `@姓名` / `@姓名(userid)` 文本。
  // 为什么：创建时需直接带出参与人提醒，避免再切到“参与人”菜单补操作。
  const [scheduleComposerMentions, setScheduleComposerMentions] = useState('');
  // scheduleComposerMentionKeyword
  // 是什么：创建区同事搜索关键字状态。
  // 做什么：用于过滤“跟进同事”候选列表，不直接写入提交内容。
  // 为什么：让用户通过搜索点选同事，而不是先理解 `@提及` 语法。
  const [scheduleComposerMentionKeyword, setScheduleComposerMentionKeyword] = useState('');
  // scheduleEditorMentions
  // 是什么：编辑日程提及输入状态。
  // 做什么：保存用户在编辑区输入的提及对象文本。
  // 为什么：支持更新日程时同步维护提醒对象，减少重复录入。
  const [scheduleEditorMentions, setScheduleEditorMentions] = useState('');
  // scheduleEditorMentionKeyword
  // 是什么：编辑区同事搜索关键字状态。
  // 做什么：用于过滤编辑态下的跟进同事候选列表。
  // 为什么：编辑现有日程时也应保留和创建态一致的低门槛选择体验。
  const [scheduleEditorMentionKeyword, setScheduleEditorMentionKeyword] = useState('');
  // ensuringCalendarPromiseRef
  // 是什么：个人日历确保中的共享 Promise 引用。
  // 做什么：串行化“页面初始化 / 刷新日程 / 创建日程”对同一确保流程的并发调用。
  // 为什么：避免同一用户在短时间内重复调用确保接口，导致重复建历或状态抖动。
  const ensuringCalendarPromiseRef = useRef<Promise<string> | null>(null);
  // hydratedCalendarIdsRef
  // 是什么：已完成日程首轮同步的日历ID集合。
  // 做什么：记录当前挂载周期内哪些日历已经自动回拉过日程。
  // 为什么：切页返回时需要自动恢复事件，但不能在每次渲染或状态波动时重复请求接口。
  const hydratedCalendarIdsRef = useRef<Set<string>>(new Set());
  // hydratingSchedulesPromiseMapRef
  // 是什么：按日历维度缓存中的日程同步 Promise 映射。
  // 做什么：合并同一日历的并发回拉请求，让自动同步和手动刷新复用同一个请求。
  // 为什么：避免短时间内重复拉取同一日历日程，导致界面抖动和重复反馈。
  const hydratingSchedulesPromiseMapRef = useRef<Map<string, Promise<CalendarBoardEvent[]>>>(new Map());
  // scheduleFetchSequenceMapRef
  // 是什么：按日历记录的日程快照请求序号映射。
  // 做什么：为每次远端快照拉取生成递增序号，只允许最新请求结果写回页面。
  // 为什么：自动回拉、冲突校验预取和手动刷新可能并发返回，较早的旧结果不应覆盖较新的本地状态。
  const scheduleFetchSequenceMapRef = useRef<Map<string, number>>(new Map());

  const initialMonth = useMemo(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  }, []);
  const [viewMonth, setViewMonth] = useState(initialMonth);
  const [selectedDayKey, setSelectedDayKey] = useState(() => toDateKey(new Date()));

  const [scheduleComposer, setScheduleComposer] = useState<ScheduleComposerState>(() => {
    const defaults = buildDefaultRangeByDayKey(toDateKey(new Date()));
    return {
      summary: '新的工作日程',
      description: '',
      location: '',
      startAt: defaults.startAt,
      endAt: defaults.endAt,
    };
  });

  const [scheduleEditor, setScheduleEditor] = useState<ScheduleEditorState>(() => {
    const defaults = buildDefaultRangeByDayKey(toDateKey(new Date()));
    return {
      summary: '',
      description: '',
      location: '',
      startAt: defaults.startAt,
      endAt: defaults.endAt,
    };
  });

  const monthCells = useMemo(() => buildMonthCells(viewMonth), [viewMonth]);
  const monthTitle = useMemo(() => formatMonthTitle(viewMonth), [viewMonth]);
  const todayKey = useMemo(() => toDateKey(new Date()), []);

  // resolvedCurrentUserId
  // 是什么：当前登录用户ID兼容解析值。
  // 做什么：优先读取 `id`，并兼容历史结构中的 `userid`。
  // 为什么：避免上下文字段差异导致已绑定日历被误判为“未配置”。
  const resolvedCurrentUserId = String(
    (user as { id?: string; userid?: string } | null)?.id ||
      (user as { id?: string; userid?: string } | null)?.userid ||
      ''
  ).trim();
  const currentUserName = String(user?.name || '').trim();
  const currentUserIsAdmin = Boolean(user?.isAdmin);
  // canManageCalendar
  // 是什么：日历维护能力开关。
  // 做什么：仅当当前用户具备管理员权限时显示“日历维护/映射”模块。
  // 为什么：执行对象只能操作自己的日程，不应暴露系统级绑定与维护能力。
  const canManageCalendar = currentUserIsAdmin;
  // currentUserFallbackOrgUsers
  // 是什么：当前登录人候选回退列表。
  // 做什么：在通讯录接口与本地快照都不可用时，至少保留当前登录账号供页面点选。
  // 为什么：避免“跟进对象”区域完全无候选，导致用户被迫中断排期流程。
  const currentUserFallbackOrgUsers = useMemo(() => {
    if (!resolvedCurrentUserId) {
      return [] as OrgUserProfile[];
    }

    return [
      {
        userid: resolvedCurrentUserId,
        name: currentUserName || resolvedCurrentUserId,
      },
    ];
  }, [currentUserName, resolvedCurrentUserId]);

  const currentUserMapping = useMemo(() => {
    if (!resolvedCurrentUserId) {
      return null;
    }
    return mappings.find((row) => String(row.user_id || '').trim() === resolvedCurrentUserId) || null;
  }, [mappings, resolvedCurrentUserId]);

  // visibleEvents
  // 是什么：当前用户可见事件集合。
  // 做什么：管理员保留全量事件，普通成员只保留自己创建或需要自己执行的事件。
  // 为什么：页面展示层必须与权限模型一致，避免把无关日程暴露给执行对象。
  const visibleEvents = useMemo(() => {
    return events.filter((event) =>
      canUserViewCalendarEvent(event, {
        currentUserId: resolvedCurrentUserId,
        isAdmin: currentUserIsAdmin,
      })
    );
  }, [currentUserIsAdmin, events, resolvedCurrentUserId]);

  const filteredEvents = useMemo(() => {
    const keyword = eventKeyword.trim().toLowerCase();
    if (!keyword) {
      return visibleEvents;
    }
    return visibleEvents.filter((event) => {
      const target = `${event.summary} ${event.description} ${event.location}`.toLowerCase();
      return target.includes(keyword);
    });
  }, [eventKeyword, visibleEvents]);

  const eventMapByDay = useMemo(() => {
    const grouped = new Map<string, CalendarBoardEvent[]>();
    filteredEvents.forEach((event) => {
      buildEventDayKeys(event.startTime, event.endTime).forEach((key) => {
        const list = grouped.get(key) || [];
        list.push(event);
        grouped.set(key, list);
      });
    });
    grouped.forEach((list) => list.sort((a, b) => a.startTime - b.startTime));
    return grouped;
  }, [filteredEvents]);

  const selectedDayEvents = useMemo(() => {
    return eventMapByDay.get(selectedDayKey) || [];
  }, [eventMapByDay, selectedDayKey]);

  const selectedEvent = useMemo(() => {
    return visibleEvents.find((item) => item.id === selectedEventId) || null;
  }, [selectedEventId, visibleEvents]);

  // canMutateSelectedEvent
  // 是什么：当前选中事件的可编辑状态。
  // 做什么：根据管理员身份与事件创建人，计算当前选中事件是否允许编辑、删除和维护参与人。
  // 为什么：同一日历中可见不代表可改，界面需要给出明确的只读边界。
  const canMutateSelectedEvent = useMemo(() => {
    if (!selectedEvent) {
      return false;
    }

    return canUserMutateCalendarEvent(selectedEvent, {
      currentUserId: resolvedCurrentUserId,
      isAdmin: currentUserIsAdmin,
    });
  }, [currentUserIsAdmin, resolvedCurrentUserId, selectedEvent]);

  // selectedEventReadonlyHint
  // 是什么：当前选中事件只读提示文案。
  // 做什么：当成员选中他人创建的执行日程时，输出统一只读提示。
  // 为什么：按钮禁用之外还需要告诉用户“为什么不能改”。
  const selectedEventReadonlyHint = useMemo(() => {
    if (!selectedEvent || canMutateSelectedEvent) {
      return '';
    }
    return '当前日程由其他人创建，你可以查看执行安排，但不能编辑或删除。';
  }, [canMutateSelectedEvent, selectedEvent]);

  // composerHasInvalidTimeRange / editorHasInvalidTimeRange
  // 是什么：创建态与编辑态时间区间校验结果。
  // 做什么：实时判断开始/结束时间是否满足“结束严格晚于开始”。
  // 为什么：提交按钮和输入区提示需要即时响应用户输入，而不是等到提交时才报错。
  const composerHasInvalidTimeRange = useMemo(
    () => hasInvalidDateTimeRange(scheduleComposer.startAt, scheduleComposer.endAt),
    [scheduleComposer.endAt, scheduleComposer.startAt]
  );
  const editorHasInvalidTimeRange = useMemo(
    () => hasInvalidDateTimeRange(scheduleEditor.startAt, scheduleEditor.endAt),
    [scheduleEditor.endAt, scheduleEditor.startAt]
  );

  useEffect(() => {
    if (!selectedEventId) {
      return;
    }
    if (selectedEvent) {
      return;
    }

    setSelectedEventId('');
  }, [selectedEvent, selectedEventId]);

  const monthlyVisibleCount = useMemo(() => {
    return filteredEvents.filter((event) => doesEventIntersectMonth(event, viewMonth)).length;
  }, [filteredEvents, viewMonth]);

  // filteredOrgUsers
  // 是什么：组织成员筛选结果。
  // 做什么：基于关键字过滤可选参与人列表。
  // 为什么：组织成员量大时需要快速定位目标成员。
  const filteredOrgUsers = useMemo(() => {
    const keyword = attendeeKeyword.trim().toLowerCase();
    if (!keyword) {
      return orgUsers;
    }

    return orgUsers.filter((item) => {
      const name = String(item.name || '').toLowerCase();
      const userId = String(item.userid || '').toLowerCase();
      const position = String(item.position || '').toLowerCase();
      return name.includes(keyword) || userId.includes(keyword) || position.includes(keyword);
    });
  }, [orgUsers, attendeeKeyword]);

  // composerMentionResult
  // 是什么：创建日程提及解析结果。
  // 做什么：将创建区提及文本转换为内部成员与外部提醒对象。
  // 为什么：创建提交前需要直接组装 `attendees` 与说明文案。
  const composerMentionResult = useMemo(
    () => resolveMentionTargets(scheduleComposerMentions, orgUsers),
    [scheduleComposerMentions, orgUsers]
  );

  // editorMentionResult
  // 是什么：编辑日程提及解析结果。
  // 做什么：将编辑区提及文本转换为内部成员与外部提醒对象。
  // 为什么：更新时需要有条件覆盖参与人并写入外部提醒。
  const editorMentionResult = useMemo(
    () => resolveMentionTargets(scheduleEditorMentions, orgUsers),
    [scheduleEditorMentions, orgUsers]
  );

  // composerReminderChipItems
  // 是什么：创建区提醒对象标签列表。
  // 做什么：把当前创建区内已选同事与文本对象转换为可视化标签。
  // 为什么：用户需要直观看到“已经加入哪些跟进对象”，降低误操作概率。
  const composerReminderChipItems = useMemo(
    () => buildReminderChipItems(scheduleComposerMentions, orgUsers),
    [scheduleComposerMentions, orgUsers]
  );

  // editorReminderChipItems
  // 是什么：编辑区提醒对象标签列表。
  // 做什么：把当前编辑区提醒对象转换为可视化标签。
  // 为什么：编辑时经常要删改个别对象，标签化比纯文本更易操作。
  const editorReminderChipItems = useMemo(
    () => buildReminderChipItems(scheduleEditorMentions, orgUsers),
    [scheduleEditorMentions, orgUsers]
  );

  // composerMentionCandidates
  // 是什么：创建区提及候选成员列表。
  // 做什么：基于搜索关键字过滤未加入的组织成员候选。
  // 为什么：支持“先搜再点”的跟进同事选择交互，不再依赖输入 `@`。
  const composerMentionCandidates = useMemo(() => {
    const selectedUserIds = new Set(
      composerMentionResult.internalUsers.map((item) => String(item.userid || '').trim().toLowerCase())
    );
    const availableUsers = orgUsers.filter(
      (item) => !selectedUserIds.has(String(item.userid || '').trim().toLowerCase())
    );
    return buildMentionCandidates(availableUsers, scheduleComposerMentionKeyword);
  }, [orgUsers, composerMentionResult, scheduleComposerMentionKeyword]);

  // editorMentionCandidates
  // 是什么：编辑区提及候选成员列表。
  // 做什么：基于搜索关键字过滤未加入的组织成员候选。
  // 为什么：保证编辑流程和创建流程拥有一致的“搜人再加入”体验。
  const editorMentionCandidates = useMemo(() => {
    const selectedUserIds = new Set(
      editorMentionResult.internalUsers.map((item) => String(item.userid || '').trim().toLowerCase())
    );
    const availableUsers = orgUsers.filter(
      (item) => !selectedUserIds.has(String(item.userid || '').trim().toLowerCase())
    );
    return buildMentionCandidates(availableUsers, scheduleEditorMentionKeyword);
  }, [orgUsers, editorMentionResult, scheduleEditorMentionKeyword]);

  // appendComposerMentionUser
  // 是什么：创建区成员提及追加函数。
  // 做什么：点击候选成员后向创建区输入框追加标准化提及词元。
  // 为什么：减少手工输入错误并提升内部成员匹配准确率。
  const appendComposerMentionUser = useCallback((member: OrgUserProfile) => {
    const userId = String(member.userid || '').trim();
    if (!userId) {
      return;
    }
    const displayName = String(member.name || userId).trim() || userId;
    setScheduleComposerMentions((prev) => appendMentionToken(prev, `${displayName}(${userId})`));
    setScheduleComposerMentionKeyword('');
  }, []);

  // appendEditorMentionUser
  // 是什么：编辑区成员提及追加函数。
  // 做什么：点击候选成员后向编辑区输入框追加标准化提及词元。
  // 为什么：统一编辑态的内部成员点选行为，避免手工维护参与人时误填。
  const appendEditorMentionUser = useCallback((member: OrgUserProfile) => {
    const userId = String(member.userid || '').trim();
    if (!userId) {
      return;
    }
    const displayName = String(member.name || userId).trim() || userId;
    setScheduleEditorMentions((prev) => appendMentionToken(prev, `${displayName}(${userId})`));
    setScheduleEditorMentionKeyword('');
  }, []);

  // removeComposerReminderChip
  // 是什么：创建区提醒对象移除函数。
  // 做什么：点击标签后从创建区原始输入中移除对应对象。
  // 为什么：比手工回删整段文本更快，也更不容易误删其他对象。
  const removeComposerReminderChip = useCallback((chip: ReminderChipItem) => {
    setScheduleComposerMentions((prev) => removeReminderEntry(prev, chip.rawValue, chip.entryKind));
  }, []);

  // removeEditorReminderChip
  // 是什么：编辑区提醒对象移除函数。
  // 做什么：点击标签后从编辑区原始输入中移除对应对象。
  // 为什么：编辑既有日程时经常是微调单个对象，单点移除更符合实际操作路径。
  const removeEditorReminderChip = useCallback((chip: ReminderChipItem) => {
    setScheduleEditorMentions((prev) => removeReminderEntry(prev, chip.rawValue, chip.entryKind));
  }, []);

  // pushOperation
  // 是什么：操作反馈写入函数。
  // 做什么：将操作结果写入“最新反馈”与“历史记录”。
  // 为什么：用自然语言反馈替代技术化日志输出。
  const pushOperation = useCallback((action: string, status: OperationRecord['status'], message: string) => {
    const createdAt = new Date().toLocaleString();
    const record: OperationRecord = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      action,
      status,
      message,
      createdAt,
    };
    setLatestOperation(record);
    setOperationHistory((prev) => [record, ...prev].slice(0, 12));
  }, []);

  // refreshTaskLinkedViews
  // 是什么：任务关联视图刷新函数。
  // 做什么：在日历工作项成功变更后，通知上层刷新任务列表与仪表盘状态。
  // 为什么：任务、日历、仪表盘和团队统计使用同一工作内容时，前端状态也必须即时对齐。
  const refreshTaskLinkedViews = useCallback(async () => {
    if (!onTaskDataChanged) {
      return;
    }

    try {
      await onTaskDataChanged();
    } catch (error) {
      pushOperation('刷新任务看板', 'info', '日历工作项已保存，但任务 / 仪表盘刷新失败，请稍后手动刷新。');
      console.error(error);
    }
  }, [onTaskDataChanged, pushOperation]);

  // loadMappings
  // 是什么：映射列表加载函数。
  // 做什么：拉取当前日历绑定信息并写入状态。
  // 为什么：后续操作全部依赖“当前用户对应日历”的可用性。
  const loadMappings = useCallback(async () => {
    const result = await getCalendarMappings();
    setMappings(Array.isArray(result.mappings) ? result.mappings : []);
    setMappingsLoaded(true);
    return result;
  }, []);

  // hydrateSchedulesByCalId
  // 是什么：指定日历日程同步函数。
  // 做什么：拉取目标日历的最新日程并替换本地对应事件快照，可按需静默执行。
  // 为什么：CalendarManager 切出页面后会被卸载，回来时必须自动从服务端恢复当前日历的工作项。
  const hydrateSchedulesByCalId = useCallback(
    async (
      calId: string,
      options: {
        silent?: boolean;
      } = {}
    ) => {
      const normalizedCalId = String(calId || '').trim();
      if (!normalizedCalId) {
        return [] as CalendarBoardEvent[];
      }

      const existingPromise = hydratingSchedulesPromiseMapRef.current.get(normalizedCalId);
      if (existingPromise) {
        return existingPromise;
      }

      const hydrationPromise = (async () => {
        const requestSequence = (scheduleFetchSequenceMapRef.current.get(normalizedCalId) || 0) + 1;
        scheduleFetchSequenceMapRef.current.set(normalizedCalId, requestSequence);
        const result = await getCalendarSchedules(normalizedCalId, {
          offset: 0,
          limit: 500,
        });
        const incomingEvents = mapResultToBoardEvents(
          result,
          normalizedCalId,
          resolvedCurrentUserId,
          options.silent ? 'api_hydrate' : 'api_fetch'
        );
        if ((scheduleFetchSequenceMapRef.current.get(normalizedCalId) || 0) !== requestSequence) {
          return incomingEvents;
        }
        setEvents((prev) => replaceBoardEventsByCalendarId(prev, normalizedCalId, incomingEvents));
        hydratedCalendarIdsRef.current.add(normalizedCalId);
        if (!options.silent) {
          pushOperation(
            '刷新我的日程',
            'success',
            incomingEvents.length > 0 ? `已同步 ${incomingEvents.length} 条日程。` : '当前没有可展示的日程。'
          );
        }
        return incomingEvents;
      })()
        .catch((error) => {
          if (!options.silent) {
            pushOperation('刷新我的日程', 'error', resolveErrorMessage(error));
          }
          throw error;
        })
        .finally(() => {
          hydratingSchedulesPromiseMapRef.current.delete(normalizedCalId);
        });

      hydratingSchedulesPromiseMapRef.current.set(normalizedCalId, hydrationPromise);
      return hydrationPromise;
    },
    [pushOperation, resolvedCurrentUserId]
  );

  // ensureCurrentUserCalendarReady
  // 是什么：当前用户个人日历确保函数。
  // 做什么：在确认当前用户未绑定日历时，调用后端执行“已有复用、缺失创建”，并回写前端状态。
  // 为什么：日历创建入口已默认隐藏，页面必须自行保证“每人一历”成立，用户不应再手工创建。
  const ensureCurrentUserCalendarReady = useCallback(async () => {
    if (!resolvedCurrentUserId) {
      pushOperation('准备个人日历', 'error', '未获取到登录身份，请重新登录后重试。');
      return '';
    }

    if (activeCalId) {
      return activeCalId;
    }

    if (ensuringCalendarPromiseRef.current) {
      return ensuringCalendarPromiseRef.current;
    }

    const pendingPromise = (async () => {
      try {
        const result = await ensureUserCalendar({
          user_id: resolvedCurrentUserId,
          user_name: currentUserName,
          source: 'calendar_manage_page',
        });
        const ensuredCalId = String((result as WecomApiResult).cal_id || '').trim();
        if (!ensuredCalId) {
          throw new Error(resolveErrorMessage({ response: { data: result } }));
        }

        setActiveCalId(ensuredCalId);
        try {
          await loadMappings();
        } catch (error) {
          pushOperation('准备个人日历', 'info', '个人日历已就绪，但映射刷新失败，请稍后手动刷新状态。');
        }
        pushOperation(
          '准备个人日历',
          'success',
          result.created ? '未发现个人日历，已自动创建并完成绑定。' : '已自动确认并加载你的个人日历。'
        );
        return ensuredCalId;
      } catch (error) {
        pushOperation('准备个人日历', 'error', resolveErrorMessage(error));
        return '';
      } finally {
        ensuringCalendarPromiseRef.current = null;
      }
    })();

    ensuringCalendarPromiseRef.current = pendingPromise;
    return pendingPromise;
  }, [activeCalId, currentUserName, loadMappings, pushOperation, resolvedCurrentUserId]);

  // loadOrgUsers
  // 是什么：组织成员加载函数。
  // 做什么：从后端读取组织成员并归一化为可选列表。
  // 为什么：参与人操作需要从组织成员中选择，不应要求手工输入用户ID。
  const loadOrgUsers = useCallback(async () => {
    setOrgUsersLoading(true);
    try {
      const result = await getOrgUsers({
        department_id: 1,
        fetch_child: 1,
        status: 0,
      });
      const errcode = Number(result && result.errcode);

      // orgUsersDegradeMode
      // 是什么：组织成员查询降级处理分支。
      // 做什么：当后端返回业务错误码（如权限或可信 IP 受限）时，不抛异常，改为提示并保留页面可用。
      // 为什么：该场景属于可预期配置问题，页面应继续允许手工 `@姓名(userid)` 提及，不应中断核心日程流程。
      if (Number.isFinite(errcode) && errcode !== 0) {
        const message = resolveErrorMessage({
          response: {
            data: result,
          },
        });
        const fallbackRows = normalizeOrgUserProfiles(currentUserFallbackOrgUsers);
        const nextMessage = `${message}${fallbackRows.length > 0 ? ' 已保留当前登录账号作为候选，其余联系人可先手工输入。' : ''}`;
        setOrgUsers(fallbackRows);
        setOrgUsersErrorHint(nextMessage);
        pushOperation('加载组织成员', fallbackRows.length > 0 ? 'info' : 'error', nextMessage);
        return result;
      }

      const normalizedRows = normalizeOrgUserProfiles([
        ...(Array.isArray(result.userlist) ? result.userlist : []),
        ...currentUserFallbackOrgUsers,
      ]);
      const degradedHint = buildOrgUsersDegradedHint(result, normalizedRows.length > 0);

      setOrgUsers(normalizedRows);
      setOrgUsersErrorHint(degradedHint);
      if (degradedHint) {
        pushOperation('加载组织成员', 'info', degradedHint);
      }
      return result;
    } catch (error) {
      const fallbackRows = normalizeOrgUserProfiles(currentUserFallbackOrgUsers);
      const message = `${resolveErrorMessage(error)}${fallbackRows.length > 0 ? ' 已保留当前登录账号作为候选，其余联系人可先手工输入。' : ' 当前无法加载任何候选成员，请先手工输入联系人。'}`;
      setOrgUsers(fallbackRows);
      setOrgUsersErrorHint(message);
      pushOperation('加载组织成员', fallbackRows.length > 0 ? 'info' : 'error', message);
      return null;
    } finally {
      setOrgUsersLoading(false);
    }
  }, [currentUserFallbackOrgUsers, pushOperation]);

  // withLoading
  // 是什么：异步执行包装函数。
  // 做什么：统一维护 loading 状态并沉淀友好反馈。
  // 为什么：减少重复 try/catch 并保持交互一致。
  const withLoading = useCallback(
    async <T,>(action: string, runner: () => Promise<T>, successMessage: string) => {
      setLoading(true);
      try {
        const result = await runner();
        pushOperation(action, 'success', successMessage);
        return result;
      } catch (error) {
        pushOperation(action, 'error', resolveErrorMessage(error));
        throw error;
      } finally {
        setLoading(false);
      }
    },
    [pushOperation]
  );

  useEffect(() => {
    withLoading('加载日历信息', loadMappings, '已加载当前日历状态').catch(() => undefined);
  }, [loadMappings, withLoading]);

  useEffect(() => {
    if (!mappingsLoaded || !resolvedCurrentUserId || currentUserMapping || activeCalId) {
      return;
    }

    ensureCurrentUserCalendarReady().catch(() => undefined);
  }, [activeCalId, currentUserMapping, ensureCurrentUserCalendarReady, mappingsLoaded, resolvedCurrentUserId]);

  useEffect(() => {
    loadOrgUsers().catch(() => undefined);
  }, [loadOrgUsers]);

  useEffect(() => {
    const normalizedCalId = String(activeCalId || '').trim();
    if (!normalizedCalId) {
      return;
    }
    if (hydratedCalendarIdsRef.current.has(normalizedCalId)) {
      return;
    }

    hydrateSchedulesByCalId(normalizedCalId, { silent: true }).catch(() => undefined);
  }, [activeCalId, hydrateSchedulesByCalId]);

  useEffect(() => {
    const nextCalId = String(currentUserMapping?.cal_id || '').trim();
    setActiveCalId(nextCalId);
  }, [currentUserMapping]);

  useEffect(() => {
    const defaults = buildDefaultRangeByDayKey(selectedDayKey);
    setScheduleComposer((prev) => ({
      ...prev,
      startAt: defaults.startAt,
      endAt: defaults.endAt,
    }));
  }, [selectedDayKey]);

  useEffect(() => {
    if (!selectedEvent) {
      setScheduleEditorMentions('');
      setScheduleEditorMentionKeyword('');
      setSelectedAttendeeUserIds([]);
      return;
    }
    setScheduleEditor({
      summary: selectedEvent.summary,
      description: selectedEvent.description,
      location: selectedEvent.location,
      startAt: fromUnixSecondsToDatetimeLocal(selectedEvent.startTime),
      endAt: fromUnixSecondsToDatetimeLocal(selectedEvent.endTime),
    });
    setScheduleEditorMentions('');
    setScheduleEditorMentionKeyword('');
    setSelectedAttendeeUserIds([]);
  }, [selectedEvent]);

  // refreshMySchedules
  // 是什么：个人日程刷新函数。
  // 做什么：拉取当前日历下日程并同步到月视图。
  // 为什么：让页面以“可视化日历”为主，不暴露查询参数细节。
  const refreshMySchedules = async () => {
    const targetCalId = activeCalId || (await ensureCurrentUserCalendarReady());
    if (!targetCalId) {
      return;
    }

    setLoading(true);
    try {
      await hydrateSchedulesByCalId(targetCalId);
    } catch (error) {
      // 具体失败反馈已在 hydrateSchedulesByCalId 中处理，这里只负责结束 loading。
    } finally {
      setLoading(false);
    }
  };

  // buildLatestEventSnapshotByCalId
  // 是什么：指定日历最新事件快照构建函数。
  // 做什么：拉取远端最新日程并与本地事件合并，返回合并后的快照。
  // 为什么：创建/更新前需基于最新数据做冲突校验，避免仅凭本地缓存误判。
  const buildLatestEventSnapshotByCalId = useCallback(
    async (calId: string) => {
      const normalizedCalId = String(calId || '').trim();
      if (!normalizedCalId) {
        return events;
      }

      const requestSequence = (scheduleFetchSequenceMapRef.current.get(normalizedCalId) || 0) + 1;
      scheduleFetchSequenceMapRef.current.set(normalizedCalId, requestSequence);
      const result = await getCalendarSchedules(normalizedCalId, {
        offset: 0,
        limit: 500,
      });
      const incomingEvents = mapResultToBoardEvents(result, normalizedCalId, resolvedCurrentUserId, 'api_prefetch');
      if ((scheduleFetchSequenceMapRef.current.get(normalizedCalId) || 0) !== requestSequence) {
        return incomingEvents;
      }
      const merged = replaceBoardEventsByCalendarId(events, normalizedCalId, incomingEvents);
      setEvents(merged);
      return merged;
    },
    [events, resolvedCurrentUserId]
  );

  // createMySchedule
  // 是什么：创建日程函数。
  // 做什么：在当前绑定日历创建日程并回写到月视图。
  // 为什么：用户只关注“标题/时间/地点”，不感知 schedule_id。
  const createMySchedule = async () => {
    const targetCalId = activeCalId || (await ensureCurrentUserCalendarReady());
    if (!targetCalId) {
      return;
    }
    if (!scheduleComposer.summary.trim()) {
      pushOperation('创建日程', 'error', '请填写日程标题。');
      return;
    }

    const startTime = toUnixSeconds(scheduleComposer.startAt);
    const endTime = toUnixSeconds(scheduleComposer.endAt);
    if (!startTime || !endTime || endTime <= startTime) {
      pushOperation('创建日程', 'error', '请检查开始/结束时间，结束时间需晚于开始时间。');
      return;
    }

    const hasComposerMentionInput = String(scheduleComposerMentions || '').trim().length > 0;
    if (
      hasComposerMentionInput &&
      composerMentionResult.rawMentionTokens.length === 0 &&
      composerMentionResult.rawTextEntries.length === 0
    ) {
      pushOperation('创建日程', 'error', '跟进对象请填写姓名、账号，或使用 @姓名(userid) 形式。');
      return;
    }

    const composerInternalAttendees = composerMentionResult.internalUsers.map((item) => ({
      userid: item.userid,
    }));
    const composerDescription = composeDescriptionWithExternalMentions(
      scheduleComposer.description,
      composerMentionResult.externalNames
    );

    let eventSnapshot = events;
    try {
      eventSnapshot = await buildLatestEventSnapshotByCalId(targetCalId);
    } catch (error) {
      pushOperation('创建日程', 'error', '拉取最新日程失败，无法完成冲突校验，请稍后重试。');
      return;
    }

    const conflictingEvent = findConflictingEvent(eventSnapshot, {
      calId: targetCalId,
      startTime,
      endTime,
      participantUserIds: composerInternalAttendees.map((item) => String(item.userid || '')),
      fallbackOwnerUserId: resolvedCurrentUserId,
    });
    if (conflictingEvent) {
      pushOperation(
        '创建日程',
        'error',
        `与同一负责人现有日程“${conflictingEvent.summary}”时间重叠，请调整时间或改派负责人后再提交。`
      );
      return;
    }

    await withLoading(
      '创建日程',
      async () => {
        const schedulePayload: Record<string, unknown> = {
          cal_id: targetCalId,
          summary: scheduleComposer.summary.trim(),
          description: composerDescription,
          location: scheduleComposer.location.trim(),
          start_time: startTime,
          end_time: endTime,
        };
        if (composerInternalAttendees.length > 0) {
          schedulePayload.attendees = composerInternalAttendees;
        }

        const result = await createSchedule({
          schedule: schedulePayload,
        });

        const scheduleId = String((result as WecomApiResult).schedule_id || '').trim();
        if (scheduleId) {
          setEvents((prev) =>
            mergeBoardEvents(prev, [
              {
                id: scheduleId,
                calId: targetCalId,
                summary: scheduleComposer.summary.trim(),
                description: composerDescription,
                location: scheduleComposer.location.trim(),
                startTime,
                endTime,
                attendeesCount: composerInternalAttendees.length,
                attendeeUserIds: composerInternalAttendees.map((item) => String(item.userid || '').trim()).filter(Boolean),
                ownerUserId: resolvedCurrentUserId,
                source: 'local_create',
              },
            ])
          );
          setSelectedEventId(scheduleId);
          setSelectedDayKey(toDateKey(new Date(startTime * 1000)));
        }
        return result;
      },
      `日程已创建并加入月历。${
        composerInternalAttendees.length > 0 ? ` 已提醒 ${composerInternalAttendees.length} 位内部成员。` : ''
      }${composerMentionResult.externalNames.length > 0 ? ` 已记录 ${composerMentionResult.externalNames.length} 位外部提醒对象。` : ''}`
    );
    await refreshTaskLinkedViews();
  };

  // updateSelectedSchedule
  // 是什么：选中日程更新函数。
  // 做什么：更新当前选中的日程并同步到日历卡片。
  // 为什么：用户通过选中卡片编辑，不需要输入 schedule_id。
  const updateSelectedSchedule = async () => {
    if (!selectedEvent) {
      pushOperation('更新日程', 'error', '请先在月历中选择要编辑的日程。');
      return;
    }
    if (!canMutateSelectedEvent) {
      pushOperation('更新日程', 'error', '当前日程由其他人创建，你暂无编辑权限。');
      return;
    }
    if (!scheduleEditor.summary.trim()) {
      pushOperation('更新日程', 'error', '请填写日程标题。');
      return;
    }

    const startTime = toUnixSeconds(scheduleEditor.startAt);
    const endTime = toUnixSeconds(scheduleEditor.endAt);
    if (!startTime || !endTime || endTime <= startTime) {
      pushOperation('更新日程', 'error', '请检查开始/结束时间，结束时间需晚于开始时间。');
      return;
    }

    const hasEditorMentionInput = String(scheduleEditorMentions || '').trim().length > 0;
    if (
      hasEditorMentionInput &&
      editorMentionResult.rawMentionTokens.length === 0 &&
      editorMentionResult.rawTextEntries.length === 0
    ) {
      pushOperation('更新日程', 'error', '跟进对象请填写姓名、账号，或使用 @姓名(userid) 形式。');
      return;
    }

    const editorInternalAttendees = editorMentionResult.internalUsers.map((item) => ({
      userid: item.userid,
    }));
    const shouldUpdateAttendeesByMention =
      (editorMentionResult.rawMentionTokens.length > 0 || editorMentionResult.rawTextEntries.length > 0) &&
      editorInternalAttendees.length > 0;
    const comparisonParticipantUserIds = shouldUpdateAttendeesByMention
      ? editorInternalAttendees.map((item) => String(item.userid || ''))
      : selectedEvent.attendeeUserIds;
    const editorDescription = composeDescriptionWithExternalMentions(
      scheduleEditor.description,
      editorMentionResult.externalNames
    );

    let eventSnapshot = events;
    try {
      eventSnapshot = await buildLatestEventSnapshotByCalId(selectedEvent.calId);
    } catch (error) {
      pushOperation('更新日程', 'error', '拉取最新日程失败，无法完成冲突校验，请稍后重试。');
      return;
    }

    const conflictingEvent = findConflictingEvent(eventSnapshot, {
      calId: selectedEvent.calId,
      startTime,
      endTime,
      excludeEventId: selectedEvent.id,
      participantUserIds: comparisonParticipantUserIds,
      fallbackOwnerUserId: selectedEvent.ownerUserId || resolvedCurrentUserId,
    });
    if (conflictingEvent) {
      pushOperation(
        '更新日程',
        'error',
        `与同一负责人现有日程“${conflictingEvent.summary}”时间重叠，请调整时间或改派负责人后再提交。`
      );
      return;
    }

    await withLoading(
      '更新日程',
      async () => {
        const schedulePayload: Record<string, unknown> = {
          summary: scheduleEditor.summary.trim(),
          description: editorDescription,
          location: scheduleEditor.location.trim(),
          start_time: startTime,
          end_time: endTime,
        };
        if (shouldUpdateAttendeesByMention) {
          schedulePayload.attendees = editorInternalAttendees;
        }

        const result = await updateSchedule(selectedEvent.id, {
          schedule: schedulePayload,
          skip_attendees: shouldUpdateAttendeesByMention ? 0 : 1,
        });

        setEvents((prev) =>
          prev.map((item) =>
            item.id === selectedEvent.id
              ? {
                  ...item,
                  summary: scheduleEditor.summary.trim(),
                  description: editorDescription,
                  location: scheduleEditor.location.trim(),
                  startTime,
                  endTime,
                  attendeesCount: shouldUpdateAttendeesByMention
                    ? editorInternalAttendees.length
                    : item.attendeesCount,
                  attendeeUserIds: shouldUpdateAttendeesByMention
                    ? editorInternalAttendees.map((attendee) => String(attendee.userid || '').trim()).filter(Boolean)
                    : item.attendeeUserIds,
                  ownerUserId: item.ownerUserId || resolvedCurrentUserId,
                  source: 'local_update',
                }
              : item
          )
        );
        setSelectedDayKey(toDateKey(new Date(startTime * 1000)));
        return result;
      },
      `选中日程已更新。${
        shouldUpdateAttendeesByMention ? ` 已更新 ${editorInternalAttendees.length} 位内部提醒成员。` : ''
      }${editorMentionResult.externalNames.length > 0 ? ` 已记录 ${editorMentionResult.externalNames.length} 位外部提醒对象。` : ''}`
    );
    await refreshTaskLinkedViews();
  };

  // cancelSelectedSchedule
  // 是什么：选中日程取消函数。
  // 做什么：取消选中日程并从月历中移除。
  // 为什么：提供用户可见的完整闭环。
  const cancelSelectedSchedule = async () => {
    if (!selectedEvent) {
      pushOperation('取消日程', 'error', '请先在月历中选择要取消的日程。');
      return;
    }
    if (!canMutateSelectedEvent) {
      pushOperation('取消日程', 'error', '当前日程由其他人创建，你暂无删除权限。');
      return;
    }

    await withLoading(
      '取消日程',
      async () => {
        const result = await cancelSchedule(selectedEvent.id);
        setEvents((prev) => prev.filter((item) => item.id !== selectedEvent.id));
        setSelectedEventId('');
        return result;
      },
      '选中日程已取消。'
    );
    await refreshTaskLinkedViews();
  };

  // toggleAttendeeSelection
  // 是什么：参与人勾选切换函数。
  // 做什么：按 userid 在已选参与人列表中进行增删切换。
  // 为什么：支持组织成员多选后批量添加/移除参与人。
  const toggleAttendeeSelection = (userid: string) => {
    const normalizedUserId = String(userid || '').trim();
    if (!normalizedUserId) {
      return;
    }

    setSelectedAttendeeUserIds((prev) => {
      if (prev.includes(normalizedUserId)) {
        return prev.filter((item) => item !== normalizedUserId);
      }
      return [...prev, normalizedUserId];
    });
  };

  // addSelectedAttendeesToSchedule
  // 是什么：批量添加参与人函数。
  // 做什么：将当前勾选的组织成员追加到选中日程。
  // 为什么：满足“参与人可从组织成员中选择并添加”的业务需求。
  const addSelectedAttendeesToSchedule = async () => {
    if (!selectedEvent) {
      pushOperation('添加参与人', 'error', '请先在月历中选择一个日程。');
      return;
    }
    if (!canMutateSelectedEvent) {
      pushOperation('添加参与人', 'error', '当前日程由其他人创建，你暂无编辑权限。');
      return;
    }

    if (selectedAttendeeUserIds.length === 0) {
      pushOperation('添加参与人', 'error', '请先选择至少一位组织成员。');
      return;
    }

    const attendees = selectedAttendeeUserIds.map((userid) => ({ userid }));

    await withLoading(
      '添加参与人',
      async () => {
        const result = await addScheduleAttendees(selectedEvent.id, attendees);
        setEvents((prev) =>
          prev.map((item) =>
            item.id === selectedEvent.id
              ? {
                  ...item,
                  attendeesCount: item.attendeesCount + attendees.length,
                  attendeeUserIds: Array.from(
                    new Set([...item.attendeeUserIds, ...attendees.map((attendee) => String(attendee.userid || '').trim())])
                  ).filter(Boolean),
                }
              : item
          )
        );
        return result;
      },
      `已添加 ${attendees.length} 位参与人。`
    );
    await refreshTaskLinkedViews();
  };

  // removeSelectedAttendeesFromSchedule
  // 是什么：批量移除参与人函数。
  // 做什么：将当前勾选的组织成员从选中日程中移除。
  // 为什么：提供对称的参与人维护能力，便于快速纠偏。
  const removeSelectedAttendeesFromSchedule = async () => {
    if (!selectedEvent) {
      pushOperation('移除参与人', 'error', '请先在月历中选择一个日程。');
      return;
    }
    if (!canMutateSelectedEvent) {
      pushOperation('移除参与人', 'error', '当前日程由其他人创建，你暂无编辑权限。');
      return;
    }

    if (selectedAttendeeUserIds.length === 0) {
      pushOperation('移除参与人', 'error', '请先选择至少一位组织成员。');
      return;
    }

    const attendees = selectedAttendeeUserIds.map((userid) => ({ userid }));

    await withLoading(
      '移除参与人',
      async () => {
        const result = await removeScheduleAttendees(selectedEvent.id, attendees);
        setEvents((prev) =>
          prev.map((item) =>
            item.id === selectedEvent.id
              ? {
                  ...item,
                  attendeesCount: Math.max(0, item.attendeesCount - attendees.length),
                  attendeeUserIds: item.attendeeUserIds.filter(
                    (userId) => !attendees.some((attendee) => String(attendee.userid || '').trim() === userId)
                  ),
                }
              : item
          )
        );
        return result;
      },
      `已移除 ${attendees.length} 位参与人。`
    );
    await refreshTaskLinkedViews();
  };

  // jumpMonth
  // 是什么：月份跳转函数。
  // 做什么：按偏移量调整当前展示月份。
  // 为什么：支持用户快速浏览历史/未来日程。
  const jumpMonth = (offset: number) => {
    setViewMonth((prev) => new Date(prev.getFullYear(), prev.getMonth() + offset, 1));
  };

  // backToToday
  // 是什么：回到今天函数。
  // 做什么：将月视图和选中日期重置为当前日期。
  // 为什么：提升日常使用效率。
  const backToToday = () => {
    const today = new Date();
    setViewMonth(new Date(today.getFullYear(), today.getMonth(), 1));
    setSelectedDayKey(toDateKey(today));
    setSelectedEventId('');
  };

  return (
    <div
      className="space-y-6"
      style={{
        fontFamily: '"Manrope","Noto Sans SC","PingFang SC","Microsoft YaHei",sans-serif',
      }}
    >
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-r from-slate-900 via-slate-800 to-blue-900 px-6 py-6 text-white shadow-lg">
        <div className="absolute -right-10 -top-12 h-40 w-40 rounded-full bg-cyan-300/15 blur-2xl" />
        <div className="absolute bottom-0 left-1/3 h-28 w-28 rounded-full bg-blue-400/20 blur-2xl" />
        <div className="relative flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.24em] text-cyan-200/90">Calendar Command Center</p>
            <h1 className="mt-2 text-2xl font-semibold">{t.calendarManageTitle}</h1>
            <p className="mt-1 text-sm text-slate-200/90">你只需要关注日程本身，系统会自动处理账号与绑定细节。</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => withLoading('刷新日历映射', loadMappings, '已刷新当前日历状态。').catch(() => undefined)}
              className="inline-flex items-center gap-2 rounded-lg border border-white/25 bg-white/10 px-3 py-2 text-sm font-medium text-white transition hover:bg-white/20 disabled:opacity-60"
              disabled={loading}
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              刷新状态
            </button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-xs text-slate-500">我的日历状态</p>
          <p className="mt-2 text-2xl font-semibold text-slate-900">{activeCalId ? '已就绪' : '准备中'}</p>
          <p className="mt-1 text-xs text-slate-400">
            {activeCalId ? '可直接创建与管理日程' : '系统会自动检查并补齐你的个人日历'}
          </p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-xs text-slate-500">本月可见日程</p>
          <p className="mt-2 text-2xl font-semibold text-slate-900">{monthlyVisibleCount}</p>
          <p className="mt-1 text-xs text-slate-400">支持关键词筛选与按天查看</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-xs text-slate-500">登录身份</p>
          <p className="mt-2 text-2xl font-semibold text-slate-900">{currentUserName || '未识别'}</p>
          <p className="mt-1 text-xs text-slate-400">绑定与参与人操作将自动使用当前身份</p>
        </div>
      </div>

      <div
        data-testid="calendar-layout"
        className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_380px] 2xl:grid-cols-[minmax(0,1fr)_400px]"
      >
        <section data-testid="calendar-main-column" className="min-w-0">
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-[280px_minmax(0,1fr)]">
            <aside data-testid="calendar-left-column" className="space-y-5">
          <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-slate-900">迷你月历</h2>
                <span className="text-xs text-slate-500">{monthTitle}</span>
              </div>
              <button
                type="button"
                data-testid="mini-calendar-toggle"
                onClick={() => setMiniCalendarCollapsed((prev) => !prev)}
                className="rounded-full border border-slate-200 px-3 py-1 text-[11px] font-medium text-slate-600 transition hover:bg-slate-50"
                aria-expanded={!miniCalendarCollapsed}
              >
                {miniCalendarCollapsed ? '展开' : '收起'}
              </button>
            </div>
            {!miniCalendarCollapsed ? (
              <div data-testid="mini-calendar-body">
                <div className="grid grid-cols-7 gap-1 text-[10px] text-slate-400">
                  {WEEKDAY_LABELS.map((item) => (
                    <span key={`mini-week-${item}`} className="py-1 text-center">
                      {item.replace('周', '')}
                    </span>
                  ))}
                </div>
                <div className="mt-1 grid grid-cols-7 gap-1">
                  {monthCells.map((day) => {
                    const key = toDateKey(day);
                    const isCurrentMonth = day.getMonth() === viewMonth.getMonth();
                    const isToday = key === todayKey;
                    const isSelected = key === selectedDayKey;
                    const hasEvent = Boolean(eventMapByDay.get(key)?.length);

                    return (
                      <button
                        key={`mini-${key}`}
                        data-testid={`mini-calendar-day-${key}`}
                        onClick={() => {
                          setSelectedDayKey(key);
                          setSelectedEventId('');
                        }}
                        className={`relative rounded-md px-1 py-1 text-xs transition ${
                          isSelected
                            ? 'bg-blue-600 text-white'
                            : isCurrentMonth
                            ? 'text-slate-700 hover:bg-slate-100'
                            : 'text-slate-300 hover:bg-slate-50'
                        }`}
                      >
                        <span>{day.getDate()}</span>
                        {isToday && !isSelected ? (
                          <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-blue-500" />
                        ) : null}
                        {hasEvent && !isSelected ? (
                          <span className="absolute bottom-1 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-emerald-500" />
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </section>

          {canManageCalendar ? (
            <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-slate-900">我的日历映射</h2>
                <span className="text-xs text-slate-400">{currentUserMapping ? 1 : 0} 条</span>
              </div>
              <div className="max-h-[420px] space-y-2 overflow-auto pr-1">
                {!currentUserMapping ? (
                  <p className="rounded-lg border border-dashed border-slate-200 p-3 text-xs text-slate-400">
                    当前个人日历准备中，系统会自动补齐，不需要手工创建。
                  </p>
                ) : (
                  <div className="w-full rounded-lg border border-blue-300 bg-blue-50/60 p-3 text-left">
                    <p className="text-xs font-semibold text-slate-700">
                      {currentUserMapping.calendar_summary || '我的默认工作日历'}
                    </p>
                    <p className="mt-1 text-[11px] text-slate-500">当前登录账号绑定（只读）</p>
                    <p className="mt-1 text-[10px] text-slate-400">{currentUserMapping.updated_at || '-'}</p>
                  </div>
                )}
              </div>
            </section>
          ) : null}

          <section
            data-testid="calendar-operation-panel"
            className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-[0_18px_40px_-24px_rgba(15,23,42,0.75)]"
          >
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold text-slate-900">操作反馈</h2>
              <span className="text-[11px] text-slate-400">{operationHistory.length} 条记录</span>
            </div>
            {latestOperation ? (
              <div
                className={`rounded-xl border p-3 ${
                  latestOperation.status === 'success'
                    ? 'border-emerald-200 bg-emerald-50'
                    : latestOperation.status === 'error'
                    ? 'border-rose-200 bg-rose-50'
                    : 'border-blue-200 bg-blue-50'
                }`}
              >
                <div className="flex items-center gap-2">
                  <CheckCircle2
                    className={`h-4 w-4 ${
                      latestOperation.status === 'success'
                        ? 'text-emerald-600'
                        : latestOperation.status === 'error'
                        ? 'text-rose-600'
                        : 'text-blue-600'
                    }`}
                  />
                  <p className="text-sm font-semibold text-slate-800">{latestOperation.action}</p>
                </div>
                <p className="mt-1 text-xs text-slate-600">{latestOperation.message}</p>
                <p className="mt-1 text-[11px] text-slate-400">{latestOperation.createdAt}</p>
              </div>
            ) : (
              <p className="rounded-xl border border-dashed border-slate-200 p-3 text-xs text-slate-400">
                暂无操作记录。创建、更新或取消日程后，反馈会自动出现在这里。
              </p>
            )}

            <div className="max-h-[280px] space-y-2 overflow-auto pr-1">
              {operationHistory.map((record) => (
                <div key={record.id} className="rounded-xl border border-slate-200 p-3">
                  <p className="text-xs font-semibold text-slate-700">{record.action}</p>
                  <p className="mt-1 text-xs text-slate-600">{record.message}</p>
                  <p className="mt-1 text-[11px] text-slate-400">{record.createdAt}</p>
                </div>
              ))}
            </div>
          </section>
            </aside>

            <section className="space-y-5">
              <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div className="flex items-center gap-2">
                <CalendarDays className="h-5 w-5 text-blue-600" />
                <h2 className="text-xl font-semibold text-slate-900">{monthTitle}</h2>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() => jumpMonth(-1)}
                  className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-50"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <button
                  onClick={backToToday}
                  className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm font-medium text-blue-700 transition hover:bg-blue-100"
                >
                  今天
                </button>
                <button
                  onClick={() => jumpMonth(1)}
                  className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-50"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            </div>

            <div className="grid grid-cols-7 border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-500">
              {WEEKDAY_LABELS.map((label) => (
                <div key={`week-${label}`} className="px-2 py-2 text-center">
                  {label}
                </div>
              ))}
            </div>

            <div className="grid grid-cols-7">
              {monthCells.map((day) => {
                const key = toDateKey(day);
                const isCurrentMonth = day.getMonth() === viewMonth.getMonth();
                const isToday = key === todayKey;
                const isSelected = key === selectedDayKey;
                const dayEvents = eventMapByDay.get(key) || [];

                return (
                  <button
                    key={`cell-${key}`}
                    data-testid={`main-calendar-day-${key}`}
                    onClick={() => {
                      setSelectedDayKey(key);
                      setSelectedEventId('');
                    }}
                    className={`min-h-[124px] border-b border-r border-slate-100 px-2 py-2 text-left transition ${
                      isSelected ? 'bg-blue-50/80' : 'hover:bg-slate-50'
                    }`}
                  >
                    <div className="mb-2 flex items-center justify-between">
                      <span
                        className={`text-xs font-semibold ${
                          isToday
                            ? 'rounded-full bg-blue-600 px-2 py-0.5 text-white'
                            : isCurrentMonth
                            ? 'text-slate-700'
                            : 'text-slate-300'
                        }`}
                      >
                        {day.getDate()}
                      </span>
                      {dayEvents.length > 0 ? (
                        <span className="rounded-full bg-slate-900 px-1.5 py-0.5 text-[10px] text-white">
                          {dayEvents.length}
                        </span>
                      ) : null}
                    </div>
                    <div className="space-y-1">
                      {dayEvents.slice(0, 3).map((event) => (
                        <button
                          key={`${event.id}-${key}`}
                          onClick={(evt) => {
                            evt.stopPropagation();
                            setSelectedEventId(event.id);
                            setSelectedDayKey(key);
                          }}
                          className={`block w-full truncate rounded px-2 py-1 text-left text-[11px] text-white ${
                            selectedEventId === event.id
                              ? 'bg-gradient-to-r from-emerald-600 to-teal-600'
                              : 'bg-gradient-to-r from-blue-600 to-indigo-600'
                          }`}
                        >
                          {event.summary}
                        </button>
                      ))}
                      {dayEvents.length > 3 ? (
                        <p className="text-[10px] text-slate-500">+{dayEvents.length - 3} 条更多</p>
                      ) : null}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

              <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="mb-3 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div>
                <h3 className="text-base font-semibold text-slate-900">选中日期事件</h3>
                <p className="text-xs text-slate-500">{selectedDayKey}</p>
              </div>
              <label className="relative block w-full md:w-72">
                <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
                <input
                  value={eventKeyword}
                  onChange={(event) => setEventKeyword(event.target.value)}
                  placeholder="筛选事件标题/描述/地点"
                  className="w-full rounded-lg border border-slate-200 bg-slate-50 py-2 pl-9 pr-3 text-sm text-slate-700 focus:border-blue-400 focus:bg-white focus:outline-none"
                />
              </label>
            </div>

            {selectedDayEvents.length === 0 ? (
              <div className="rounded-lg border border-dashed border-slate-200 p-4 text-sm text-slate-400">
                当前日期暂无事件。点击月历空白格后，右侧会自动切换到新建模式。
              </div>
            ) : (
              <div className="space-y-3">
                {selectedDayEvents.map((event) => {
                  const isActive = selectedEventId === event.id;
                  return (
                    <button
                      key={`selected-${event.id}`}
                      onClick={() => setSelectedEventId(event.id)}
                      className={`w-full rounded-lg border p-3 text-left transition ${
                        isActive
                          ? 'border-blue-300 bg-blue-50/70'
                          : 'border-slate-200 bg-slate-50/70 hover:border-blue-200 hover:bg-blue-50/40'
                      }`}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="font-semibold text-slate-900">{event.summary}</p>
                        {isActive ? (
                          <span className="rounded-full bg-blue-600 px-2 py-0.5 text-[10px] text-white">已选中</span>
                        ) : null}
                      </div>
                      <p className="mt-1 text-xs text-slate-500">
                        {new Date(event.startTime * 1000).toLocaleString()} -{' '}
                        {new Date(event.endTime * 1000).toLocaleString()}
                      </p>
                      {event.location ? <p className="mt-1 text-xs text-slate-600">地点：{event.location}</p> : null}
                      {event.description ? <p className="mt-1 text-xs text-slate-600">{event.description}</p> : null}
                      <p className="mt-1 text-xs text-slate-500">参与人数：{event.attendeesCount}</p>
                    </button>
                  );
                })}
              </div>
            )}
              </div>
            </section>
          </div>
        </section>

        <aside data-testid="calendar-side-panel" className="space-y-5 xl:sticky xl:top-6 xl:self-start">
          <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_18px_40px_-24px_rgba(15,23,42,0.8)]">
            <div className="border-b border-slate-200 bg-gradient-to-r from-slate-950 via-slate-900 to-blue-950 px-4 py-4 text-white">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <CalendarClock className="h-4 w-4 text-cyan-300" />
                    <p className="text-xs uppercase tracking-[0.22em] text-cyan-200/90">
                      {selectedEvent ? 'Edit Schedule' : 'Create Schedule'}
                    </p>
                  </div>
                  <h2 className="mt-2 text-lg font-semibold">
                    {selectedEvent ? `编辑：${selectedEvent.summary}` : `新建：${selectedDayKey}`}
                  </h2>
                  <p className="mt-1 text-xs leading-5 text-slate-300">
                    {selectedEvent
                      ? '点击其他已有日程会直接切换到编辑，点击月历空白格会返回新建模式。'
                      : '点击月历空白格即可新增日程，点击已有日程则自动切换为编辑。'}
                  </p>
                  {selectedEventReadonlyHint ? (
                    <p className="mt-2 rounded-xl border border-amber-300/35 bg-amber-400/10 px-3 py-2 text-xs leading-5 text-amber-100">
                      {selectedEventReadonlyHint}
                    </p>
                  ) : null}
                </div>
                <button
                  onClick={refreshMySchedules}
                  className="rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-xs font-medium text-white transition hover:bg-white/20 disabled:opacity-60"
                  disabled={loading}
                >
                  刷新日程
                </button>
              </div>
            </div>

            <div className="space-y-4 p-4">
              {!selectedEvent ? (
                <>
                  <div className="space-y-2">
                    <label className="text-[11px] font-semibold text-slate-500">日程标题</label>
                    <input
                      value={scheduleComposer.summary}
                      onChange={(event) => setScheduleComposer((prev) => ({ ...prev, summary: event.target.value }))}
                      placeholder="例如：客户回访、周会、里程碑检查"
                      className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-700 transition focus:border-blue-400 focus:bg-white focus:outline-none"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-[11px] font-semibold text-slate-500">日程说明</label>
                    <textarea
                      value={scheduleComposer.description}
                      onChange={(event) =>
                        setScheduleComposer((prev) => ({ ...prev, description: event.target.value }))
                      }
                      placeholder="补充会议目标、准备事项或结果预期（可选）"
                      className="min-h-[92px] w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-700 transition focus:border-blue-400 focus:bg-white focus:outline-none"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-[11px] font-semibold text-slate-500">地点</label>
                    <input
                      value={scheduleComposer.location}
                      onChange={(event) => setScheduleComposer((prev) => ({ ...prev, location: event.target.value }))}
                      placeholder="线上会议室 / 客户现场 / 办公室"
                      className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-700 transition focus:border-blue-400 focus:bg-white focus:outline-none"
                    />
                  </div>
                  <ReminderInputPanel
                    title="跟进对象"
                    helperText="先点选需要跟进的同事；客户、供应商或其他联系人可直接在文本区填写。"
                    searchKeyword={scheduleComposerMentionKeyword}
                    onSearchKeywordChange={setScheduleComposerMentionKeyword}
                    rawValue={scheduleComposerMentions}
                    onRawValueChange={setScheduleComposerMentions}
                    chips={composerReminderChipItems}
                    mentionResult={composerMentionResult}
                    candidates={composerMentionCandidates}
                    onPickMember={appendComposerMentionUser}
                    onRemoveChip={removeComposerReminderChip}
                    loading={loading}
                    orgUsersLoading={orgUsersLoading}
                    orgUsersErrorHint={orgUsersErrorHint}
                  />
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <label className="text-[11px] font-semibold text-slate-500">开始时间</label>
                      <input
                        type="datetime-local"
                        value={scheduleComposer.startAt}
                        min={selectedDayKey ? `${selectedDayKey}T00:00` : undefined}
                        onChange={(event) =>
                          setScheduleComposer((prev) => ({ ...prev, startAt: event.target.value }))
                        }
                        className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-700 transition focus:border-blue-400 focus:bg-white focus:outline-none"
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-[11px] font-semibold text-slate-500">结束时间</label>
                      <input
                        type="datetime-local"
                        value={scheduleComposer.endAt}
                        min={scheduleComposer.startAt || undefined}
                        onChange={(event) =>
                          setScheduleComposer((prev) => ({ ...prev, endAt: event.target.value }))
                        }
                        className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-700 transition focus:border-blue-400 focus:bg-white focus:outline-none"
                      />
                    </div>
                  </div>
                  {composerHasInvalidTimeRange ? (
                    <p className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-600">
                      结束时间必须晚于开始时间，且不能与开始时间相同。
                    </p>
                  ) : null}
                  <button
                    onClick={createMySchedule}
                    className="w-full rounded-xl bg-blue-600 px-3 py-3 text-sm font-medium text-white transition hover:bg-blue-700 disabled:opacity-60"
                    disabled={loading || composerHasInvalidTimeRange}
                  >
                    为 {selectedDayKey} 创建日程
                  </button>
                </>
              ) : (
                <>
                  <div className="space-y-2">
                    <label className="text-[11px] font-semibold text-slate-500">日程标题</label>
                    <input
                      value={scheduleEditor.summary}
                      onChange={(event) => setScheduleEditor((prev) => ({ ...prev, summary: event.target.value }))}
                      placeholder="日程标题"
                      className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-700 transition focus:border-blue-400 focus:bg-white focus:outline-none"
                      disabled={loading || !canMutateSelectedEvent}
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-[11px] font-semibold text-slate-500">日程说明</label>
                    <textarea
                      value={scheduleEditor.description}
                      onChange={(event) => setScheduleEditor((prev) => ({ ...prev, description: event.target.value }))}
                      placeholder="补充会议目标、准备事项或结果预期"
                      className="min-h-[92px] w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-700 transition focus:border-blue-400 focus:bg-white focus:outline-none"
                      disabled={loading || !canMutateSelectedEvent}
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-[11px] font-semibold text-slate-500">地点</label>
                    <input
                      value={scheduleEditor.location}
                      onChange={(event) => setScheduleEditor((prev) => ({ ...prev, location: event.target.value }))}
                      placeholder="地点"
                      className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-700 transition focus:border-blue-400 focus:bg-white focus:outline-none"
                      disabled={loading || !canMutateSelectedEvent}
                    />
                  </div>
                  <ReminderInputPanel
                    title="跟进对象"
                    helperText="编辑当前日程的跟进同事和其他联系人；点击标签可直接移除单个对象。"
                    searchKeyword={scheduleEditorMentionKeyword}
                    onSearchKeywordChange={setScheduleEditorMentionKeyword}
                    rawValue={scheduleEditorMentions}
                    onRawValueChange={setScheduleEditorMentions}
                    chips={editorReminderChipItems}
                    mentionResult={editorMentionResult}
                    candidates={editorMentionCandidates}
                    onPickMember={appendEditorMentionUser}
                    onRemoveChip={removeEditorReminderChip}
                    loading={loading}
                    disabled={loading || !canMutateSelectedEvent}
                    orgUsersLoading={orgUsersLoading}
                    orgUsersErrorHint={orgUsersErrorHint}
                  />
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <label className="text-[11px] font-semibold text-slate-500">开始时间</label>
                      <input
                        type="datetime-local"
                        value={scheduleEditor.startAt}
                        min={selectedDayKey ? `${selectedDayKey}T00:00` : undefined}
                        onChange={(event) =>
                          setScheduleEditor((prev) => ({ ...prev, startAt: event.target.value }))
                        }
                        className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-700 transition focus:border-blue-400 focus:bg-white focus:outline-none"
                        disabled={loading || !canMutateSelectedEvent}
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-[11px] font-semibold text-slate-500">结束时间</label>
                      <input
                        type="datetime-local"
                        value={scheduleEditor.endAt}
                        min={scheduleEditor.startAt || undefined}
                        onChange={(event) =>
                          setScheduleEditor((prev) => ({ ...prev, endAt: event.target.value }))
                        }
                        className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-700 transition focus:border-blue-400 focus:bg-white focus:outline-none"
                        disabled={loading || !canMutateSelectedEvent}
                      />
                    </div>
                  </div>
                  {editorHasInvalidTimeRange ? (
                    <p className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-600">
                      结束时间必须晚于开始时间，且不能与开始时间相同。
                    </p>
                  ) : null}
                  <div className="grid grid-cols-2 gap-3">
                    <button
                      onClick={updateSelectedSchedule}
                      className="rounded-xl bg-amber-600 px-3 py-3 text-sm font-medium text-white transition hover:bg-amber-700 disabled:opacity-60"
                      disabled={loading || !selectedEvent || !canMutateSelectedEvent || editorHasInvalidTimeRange}
                    >
                      更新当前日程
                    </button>
                    <button
                      onClick={cancelSelectedSchedule}
                      className="inline-flex items-center justify-center gap-2 rounded-xl bg-rose-600 px-3 py-3 text-sm font-medium text-white transition hover:bg-rose-700 disabled:opacity-60"
                      disabled={loading || !selectedEvent || !canMutateSelectedEvent}
                    >
                      <Trash2 className="h-4 w-4" />
                      取消日程
                    </button>
                  </div>
                </>
              )}
            </div>
          </section>

          {selectedEvent ? (
            <section className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-[0_18px_40px_-24px_rgba(15,23,42,0.75)]">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold text-slate-900">参与人管理</h2>
                  <p className="mt-1 text-xs leading-5 text-slate-500">
                    当前选中：{selectedEvent.summary}。如需额外补充或移除参与人，可直接在这里批量处理。
                  </p>
                </div>
                <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-medium text-slate-500">
                  已选 {selectedAttendeeUserIds.length}
                </span>
              </div>
              <label className="relative block">
                <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
                <input
                  value={attendeeKeyword}
                  onChange={(event) => setAttendeeKeyword(event.target.value)}
                  placeholder="搜索组织成员（姓名/账号/岗位）"
                  className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2.5 pl-9 pr-3 text-sm text-slate-700 transition focus:border-blue-400 focus:bg-white focus:outline-none"
                  disabled={loading || !canMutateSelectedEvent}
                />
              </label>
              {!canMutateSelectedEvent ? (
                <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-5 text-amber-700">
                  当前日程由其他人创建，参与人列表仅供查看，不能直接增删。
                </div>
              ) : null}
              <div className="max-h-56 space-y-2 overflow-auto rounded-xl border border-slate-200 bg-slate-50 p-2">
                {orgUsersLoading ? (
                  <p className="p-2 text-xs text-slate-500">正在加载组织成员...</p>
                ) : filteredOrgUsers.length === 0 ? (
                  <div className="space-y-2 p-2">
                    <p className="text-xs text-slate-500">{orgUsersErrorHint || '没有匹配到可选成员。'}</p>
                    {orgUsersErrorHint ? (
                      <button
                        onClick={() => loadOrgUsers().catch(() => undefined)}
                        className="rounded-xl border border-slate-300 px-2 py-1 text-xs text-slate-600 transition hover:bg-slate-100"
                        disabled={orgUsersLoading || loading}
                      >
                        重新加载组织成员
                      </button>
                    ) : null}
                  </div>
                ) : (
                  filteredOrgUsers.map((member) => {
                    const userId = String(member.userid || '').trim();
                    const checked = selectedAttendeeUserIds.includes(userId);
                    return (
                      <label
                        key={`attendee-${userId}`}
                        className="flex cursor-pointer items-start gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 transition hover:border-blue-300"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleAttendeeSelection(userId)}
                          className="mt-0.5 h-3.5 w-3.5 rounded border-slate-300"
                          disabled={loading || !canMutateSelectedEvent}
                        />
                        <span className="min-w-0">
                          <span className="block truncate font-medium text-slate-800">
                            {member.name || userId}
                          </span>
                          <span className="block truncate text-slate-500">
                            {userId}
                            {member.position ? ` · ${member.position}` : ''}
                          </span>
                        </span>
                      </label>
                    );
                  })
                )}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <button
                  onClick={addSelectedAttendeesToSchedule}
                  className="inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-600 px-3 py-2.5 text-sm font-medium text-white transition hover:bg-emerald-700 disabled:opacity-60"
                  disabled={loading || !selectedEvent || !canMutateSelectedEvent}
                >
                  <UserRoundPlus className="h-4 w-4" />
                  添加所选参与人
                </button>
                <button
                  onClick={removeSelectedAttendeesFromSchedule}
                  className="rounded-xl bg-orange-600 px-3 py-2.5 text-sm font-medium text-white transition hover:bg-orange-700 disabled:opacity-60"
                  disabled={loading || !selectedEvent || !canMutateSelectedEvent}
                >
                  移除所选参与人
                </button>
              </div>
            </section>
          ) : (
            <section className="rounded-2xl border border-dashed border-slate-200 bg-white p-4 text-sm text-slate-400 shadow-[0_18px_40px_-24px_rgba(15,23,42,0.45)]">
              点击已有日程后，这里会自动展开对应的参与人管理。
            </section>
          )}

        </aside>
      </div>
    </div>
  );
};

export default CalendarManager;
