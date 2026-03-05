import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CalendarClock,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  PencilLine,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  UserRoundPlus,
} from 'lucide-react';
import {
  addScheduleAttendees,
  cancelSchedule,
  createCalendar,
  createSchedule,
  getCalendarMappings,
  getCalendarSchedules,
  getOrgUsers,
  removeScheduleAttendees,
  updateCalendar,
  updateSchedule,
  type CalendarMappingRow,
  type OrgUserProfile,
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

// resolveMentionKeyword
// 是什么：当前输入提及关键字解析函数。
// 做什么：解析输入末尾尚未完成的 `@关键词` 片段。
// 为什么：用于动态过滤内部成员候选，实现“输入 @ 即可选择”的交互。
const resolveMentionKeyword = (value: string) => {
  const normalizedText = String(value || '');
  const matched = normalizedText.match(/(?:^|[\s，,])@([^\s@，,。；;()]*)$/);
  return String((matched && matched[1]) || '').trim();
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

  tokens.forEach((token) => {
    const normalizedToken = String(token || '').trim();
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
  });

  return {
    internalUsers: Array.from(internalMap.values()),
    externalNames: Array.from(externalSet),
    rawMentionTokens: tokens,
  };
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

  const code = responseData && typeof responseData.code === 'string' ? responseData.code.trim() : '';
  if (code && (code.startsWith('CALENDAR_') || code.startsWith('SCHEDULE_'))) {
    return `${message}（${code}）`;
  }
  return String(message);
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

// PersonalCalendarForm
// 是什么：个人日历维护表单模型。
// 做什么：承载“我的日历”更新字段。
// 为什么：避免页面直接暴露接口字段名称与系统 ID。
interface PersonalCalendarForm {
  summary: string;
  color: string;
  description: string;
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

// ActionPanelTab
// 是什么：右侧操作面板标签类型。
// 做什么：约束可切换分区范围。
// 为什么：避免魔法字符串散落，提高可维护性。
type ActionPanelTab = 'CALENDAR' | 'SCHEDULE' | 'ATTENDEE' | 'RESULT';

// mapResultToBoardEvents
// 是什么：接口结果到月视图事件的映射函数。
// 做什么：将企微日程结构转换为统一事件模型。
// 为什么：查询结果需要直接可视化，减少页面层重复解析。
const mapResultToBoardEvents = (
  result: unknown,
  fallbackCalId = '',
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

// findConflictingEvent
// 是什么：时间冲突检测函数。
// 做什么：在同一日历事件集合内检测与目标时间段重叠的首个事件。
// 为什么：创建/编辑日程前需阻止时间冲突，避免同一用户日历重复占用时段。
const findConflictingEvent = (
  events: CalendarBoardEvent[],
  options: { calId: string; startTime: number; endTime: number; excludeEventId?: string }
) => {
  const targetCalId = String(options.calId || '').trim();
  const targetStartTime = Number(options.startTime || 0);
  const targetEndTime = Number(options.endTime || 0);
  const excludeEventId = String(options.excludeEventId || '').trim();

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
      return overlap;
    }) || null
  );
};

const CalendarManager: React.FC = () => {
  const { t } = useTranslation();
  const { user } = useAuth();

  const [loading, setLoading] = useState(false);
  const [mappings, setMappings] = useState<CalendarMappingRow[]>([]);
  const [events, setEvents] = useState<CalendarBoardEvent[]>([]);
  const [eventKeyword, setEventKeyword] = useState('');
  const [activeCalId, setActiveCalId] = useState('');
  const [actionTab, setActionTab] = useState<ActionPanelTab>('CALENDAR');
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
  const [attendeeKeyword, setAttendeeKeyword] = useState('');
  const [selectedAttendeeUserIds, setSelectedAttendeeUserIds] = useState<string[]>([]);
  // scheduleComposerMentions
  // 是什么：创建日程提及输入状态。
  // 做什么：保存用户在创建区输入的 `@姓名` / `@姓名(userid)` 文本。
  // 为什么：创建时需直接带出参与人提醒，避免再切到“参与人”菜单补操作。
  const [scheduleComposerMentions, setScheduleComposerMentions] = useState('');
  // scheduleEditorMentions
  // 是什么：编辑日程提及输入状态。
  // 做什么：保存用户在编辑区输入的提及对象文本。
  // 为什么：支持更新日程时同步维护提醒对象，减少重复录入。
  const [scheduleEditorMentions, setScheduleEditorMentions] = useState('');

  const initialMonth = useMemo(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  }, []);
  const [viewMonth, setViewMonth] = useState(initialMonth);
  const [selectedDayKey, setSelectedDayKey] = useState(() => toDateKey(new Date()));

  const [calendarForm, setCalendarForm] = useState<PersonalCalendarForm>({
    summary: '',
    color: '#1D4ED8',
    description: '由任务管家页面创建',
  });

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
  // canManageCalendar
  // 是什么：日历维护能力开关。
  // 做什么：仅当角色为 `MANAGER` 时显示“日历维护/映射”模块。
  // 为什么：普通执行人只需关注日程执行，不应暴露日历绑定与维护细节。
  const canManageCalendar = String(user?.role || '')
    .trim()
    .toUpperCase() === 'MANAGER';

  const currentUserMapping = useMemo(() => {
    if (!resolvedCurrentUserId) {
      return null;
    }
    return mappings.find((row) => String(row.user_id || '').trim() === resolvedCurrentUserId) || null;
  }, [mappings, resolvedCurrentUserId]);

  const filteredEvents = useMemo(() => {
    const keyword = eventKeyword.trim().toLowerCase();
    if (!keyword) {
      return events;
    }
    return events.filter((event) => {
      const target = `${event.summary} ${event.description} ${event.location}`.toLowerCase();
      return target.includes(keyword);
    });
  }, [events, eventKeyword]);

  const eventMapByDay = useMemo(() => {
    const grouped = new Map<string, CalendarBoardEvent[]>();
    filteredEvents.forEach((event) => {
      const key = toDateKey(new Date(event.startTime * 1000));
      const list = grouped.get(key) || [];
      list.push(event);
      grouped.set(key, list);
    });
    grouped.forEach((list) => list.sort((a, b) => a.startTime - b.startTime));
    return grouped;
  }, [filteredEvents]);

  const selectedDayEvents = useMemo(() => {
    return eventMapByDay.get(selectedDayKey) || [];
  }, [eventMapByDay, selectedDayKey]);

  const selectedEvent = useMemo(() => {
    return events.find((item) => item.id === selectedEventId) || null;
  }, [events, selectedEventId]);

  const scheduleTabs = useMemo(() => {
    const baseTabs: Array<{ key: ActionPanelTab; label: string; icon: React.ComponentType<{ className?: string }> }> = [
      { key: 'SCHEDULE', label: '日程', icon: CalendarClock },
      { key: 'ATTENDEE', label: '参与人', icon: UserRoundPlus },
      { key: 'RESULT', label: '结果', icon: Sparkles },
    ];

    if (canManageCalendar) {
      return [{ key: 'CALENDAR', label: '日历', icon: CalendarDays }, ...baseTabs];
    }

    return baseTabs;
  }, [canManageCalendar]);

  const monthlyVisibleCount = useMemo(() => {
    const currentYear = viewMonth.getFullYear();
    const currentMonth = viewMonth.getMonth();
    return filteredEvents.filter((event) => {
      const date = new Date(event.startTime * 1000);
      return date.getFullYear() === currentYear && date.getMonth() === currentMonth;
    }).length;
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

  // composerMentionCandidates
  // 是什么：创建区提及候选成员列表。
  // 做什么：基于输入末尾 `@关键词` 过滤组织成员候选。
  // 为什么：提供“输入 @ 即可点选内部成员”的快速交互。
  const composerMentionCandidates = useMemo(() => {
    const keyword = resolveMentionKeyword(scheduleComposerMentions);
    return keyword || String(scheduleComposerMentions || '').includes('@')
      ? buildMentionCandidates(orgUsers, keyword)
      : [];
  }, [orgUsers, scheduleComposerMentions]);

  // editorMentionCandidates
  // 是什么：编辑区提及候选成员列表。
  // 做什么：基于输入末尾 `@关键词` 过滤组织成员候选。
  // 为什么：保证编辑流程和创建流程的提及体验一致。
  const editorMentionCandidates = useMemo(() => {
    const keyword = resolveMentionKeyword(scheduleEditorMentions);
    return keyword || String(scheduleEditorMentions || '').includes('@')
      ? buildMentionCandidates(orgUsers, keyword)
      : [];
  }, [orgUsers, scheduleEditorMentions]);

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

  // loadMappings
  // 是什么：映射列表加载函数。
  // 做什么：拉取当前日历绑定信息并写入状态。
  // 为什么：后续操作全部依赖“当前用户对应日历”的可用性。
  const loadMappings = useCallback(async () => {
    const result = await getCalendarMappings();
    setMappings(Array.isArray(result.mappings) ? result.mappings : []);
    return result;
  }, []);

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
      const rows = Array.isArray(result.userlist) ? result.userlist : [];
      const deduped = new Map<string, OrgUserProfile>();

      rows.forEach((item) => {
        const userId = String(item.userid || '').trim();
        if (!userId) {
          return;
        }
        deduped.set(userId, item);
      });

      const normalizedRows = Array.from(deduped.values()).sort((a, b) => {
        const nameA = String(a.name || a.userid || '').localeCompare(String(b.name || b.userid || ''));
        return nameA;
      });
      setOrgUsers(normalizedRows);
      setOrgUsersErrorHint('');
      return result;
    } catch (error) {
      const message = resolveErrorMessage(error);
      setOrgUsersErrorHint(message);
      pushOperation('加载组织成员', 'error', message);
      throw error;
    } finally {
      setOrgUsersLoading(false);
    }
  }, [pushOperation]);

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
    loadOrgUsers().catch(() => undefined);
  }, [loadOrgUsers]);

  useEffect(() => {
    const nextSummary = currentUserName ? `任务管家-${currentUserName}` : '任务管家-个人日历';
    setCalendarForm((prev) => ({
      ...prev,
      summary: prev.summary || nextSummary,
    }));
  }, [currentUserName]);

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
  }, [selectedEvent]);

  useEffect(() => {
    if (!canManageCalendar && actionTab === 'CALENDAR') {
      setActionTab('SCHEDULE');
    }
  }, [actionTab, canManageCalendar]);

  // createMyCalendar
  // 是什么：个人日历创建并绑定函数。
  // 做什么：按当前登录用户自动绑定创建结果。
  // 为什么：为用户提供“一键创建新日历”的可控入口。
  const createMyCalendar = async () => {
    if (!resolvedCurrentUserId) {
      pushOperation('创建新日历', 'error', '未获取到登录身份，请重新登录后重试。');
      return;
    }

    await withLoading(
      '创建新日历',
      async () => {
        const payloadSummary = calendarForm.summary.trim() || `任务管家-${currentUserName || '成员'}`;
        const result = await createCalendar({
          calendar: {
            summary: payloadSummary,
            color: calendarForm.color.trim() || '#1D4ED8',
            description: calendarForm.description.trim(),
            admins: [resolvedCurrentUserId],
            shares: [{ userid: resolvedCurrentUserId, permission: 1 }],
          },
          bind_user_id: resolvedCurrentUserId,
          bind_user_name: currentUserName,
          source: 'calendar_manage_page',
        });

        const calId = String((result as WecomApiResult).cal_id || '').trim();
        if (calId) {
          setActiveCalId(calId);
        }
        await loadMappings();
        return result;
      },
      '已创建并绑定你的新日历。'
    );
  };

  // refreshMySchedules
  // 是什么：个人日程刷新函数。
  // 做什么：拉取当前日历下日程并同步到月视图。
  // 为什么：让页面以“可视化日历”为主，不暴露查询参数细节。
  const refreshMySchedules = async () => {
    if (!activeCalId) {
      pushOperation('刷新我的日程', 'error', '请先点击“创建新日历”完成日历绑定。');
      return;
    }

    setLoading(true);
    try {
      const result = await getCalendarSchedules(activeCalId, {
        offset: 0,
        limit: 500,
      });
      const incomingEvents = mapResultToBoardEvents(result, activeCalId, 'api_fetch');
      setEvents((prev) => mergeBoardEvents(prev, incomingEvents));
      pushOperation(
        '刷新我的日程',
        'success',
        incomingEvents.length > 0 ? `已同步 ${incomingEvents.length} 条日程。` : '当前没有可展示的日程。'
      );
    } catch (error) {
      pushOperation('刷新我的日程', 'error', resolveErrorMessage(error));
    } finally {
      setLoading(false);
    }
  };

  // updateMyCalendar
  // 是什么：个人日历更新函数。
  // 做什么：更新当前绑定日历的标题、颜色和描述。
  // 为什么：用业务化文案替代原始接口字段操作体验。
  const updateMyCalendar = async () => {
    if (!activeCalId) {
      pushOperation('更新我的日历', 'error', '请先完成日历绑定后再更新。');
      return;
    }

    await withLoading(
      '更新我的日历',
      async () => {
        return updateCalendar(activeCalId, {
          calendar: {
            cal_id: activeCalId,
            summary: calendarForm.summary.trim(),
            color: calendarForm.color.trim() || '#1D4ED8',
            description: calendarForm.description.trim(),
          },
        });
      },
      '你的日历设置已更新。'
    );
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

      const result = await getCalendarSchedules(normalizedCalId, {
        offset: 0,
        limit: 500,
      });
      const incomingEvents = mapResultToBoardEvents(result, normalizedCalId, 'api_prefetch');
      const merged = mergeBoardEvents(events, incomingEvents);
      setEvents(merged);
      return merged;
    },
    [events]
  );

  // createMySchedule
  // 是什么：创建日程函数。
  // 做什么：在当前绑定日历创建日程并回写到月视图。
  // 为什么：用户只关注“标题/时间/地点”，不感知 schedule_id。
  const createMySchedule = async () => {
    if (!activeCalId) {
      pushOperation('创建日程', 'error', '请先完成日历绑定后再创建日程。');
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
    if (hasComposerMentionInput && composerMentionResult.rawMentionTokens.length === 0) {
      pushOperation('创建日程', 'error', '提醒对象请输入 @姓名 或 @姓名(userid) 格式。');
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
      eventSnapshot = await buildLatestEventSnapshotByCalId(activeCalId);
    } catch (error) {
      pushOperation('创建日程', 'error', '拉取最新日程失败，无法完成冲突校验，请稍后重试。');
      return;
    }

    const conflictingEvent = findConflictingEvent(eventSnapshot, {
      calId: activeCalId,
      startTime,
      endTime,
    });
    if (conflictingEvent) {
      pushOperation(
        '创建日程',
        'error',
        `与现有日程“${conflictingEvent.summary}”时间冲突，请调整时间后再提交。`
      );
      return;
    }

    await withLoading(
      '创建日程',
      async () => {
        const schedulePayload: Record<string, unknown> = {
          cal_id: activeCalId,
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
                calId: activeCalId,
                summary: scheduleComposer.summary.trim(),
                description: composerDescription,
                location: scheduleComposer.location.trim(),
                startTime,
                endTime,
                attendeesCount: composerInternalAttendees.length,
                source: 'local_create',
              },
            ])
          );
          setSelectedEventId(scheduleId);
          setSelectedDayKey(toDateKey(new Date(startTime * 1000)));
          setActionTab('SCHEDULE');
        }
        return result;
      },
      `日程已创建并加入月历。${
        composerInternalAttendees.length > 0 ? ` 已提醒 ${composerInternalAttendees.length} 位内部成员。` : ''
      }${composerMentionResult.externalNames.length > 0 ? ` 已记录 ${composerMentionResult.externalNames.length} 位外部提醒对象。` : ''}`
    );
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
    if (hasEditorMentionInput && editorMentionResult.rawMentionTokens.length === 0) {
      pushOperation('更新日程', 'error', '提醒对象请输入 @姓名 或 @姓名(userid) 格式。');
      return;
    }

    const editorInternalAttendees = editorMentionResult.internalUsers.map((item) => ({
      userid: item.userid,
    }));
    const shouldUpdateAttendeesByMention =
      editorMentionResult.rawMentionTokens.length > 0 && editorInternalAttendees.length > 0;
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
    });
    if (conflictingEvent) {
      pushOperation(
        '更新日程',
        'error',
        `与现有日程“${conflictingEvent.summary}”时间冲突，请调整时间后再提交。`
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
            item.id === selectedEvent.id ? { ...item, attendeesCount: item.attendeesCount + attendees.length } : item
          )
        );
        return result;
      },
      `已添加 ${attendees.length} 位参与人。`
    );
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
              ? { ...item, attendeesCount: Math.max(0, item.attendeesCount - attendees.length) }
              : item
          )
        );
        return result;
      },
      `已移除 ${attendees.length} 位参与人。`
    );
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
          <p className="mt-2 text-2xl font-semibold text-slate-900">{activeCalId ? '已就绪' : '待准备'}</p>
          <p className="mt-1 text-xs text-slate-400">{activeCalId ? '可直接创建与管理日程' : '点击右侧“创建新日历”'}</p>
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

      <div className="grid grid-cols-1 gap-5 2xl:grid-cols-[280px_minmax(0,1fr)_360px]">
        <aside className="space-y-5">
          <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-900">迷你月历</h2>
              <span className="text-xs text-slate-500">{monthTitle}</span>
            </div>
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
                    onClick={() => setSelectedDayKey(key)}
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
                    还没有可用日历，请在右侧“日历”模块先创建新日历。
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
                    onClick={() => setSelectedDayKey(key)}
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
                            setActionTab('SCHEDULE');
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
                当前日期暂无事件。你可以在右侧“日程”中创建，或点击“刷新状态”同步最新日程。
              </div>
            ) : (
              <div className="space-y-3">
                {selectedDayEvents.map((event) => {
                  const isActive = selectedEventId === event.id;
                  return (
                    <button
                      key={`selected-${event.id}`}
                      onClick={() => {
                        setSelectedEventId(event.id);
                        setActionTab('SCHEDULE');
                      }}
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

        <aside className="space-y-5">
          <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
            <div className={`grid gap-2 ${canManageCalendar ? 'grid-cols-4' : 'grid-cols-3'}`}>
              {scheduleTabs.map((tab) => {
                const Icon = tab.icon;
                const isActive = actionTab === tab.key;
                return (
                  <button
                    key={tab.key}
                    onClick={() => setActionTab(tab.key)}
                    className={`flex flex-col items-center gap-1 rounded-lg px-2 py-2 text-xs transition ${
                      isActive ? 'bg-blue-600 text-white shadow' : 'text-slate-500 hover:bg-slate-100'
                    }`}
                  >
                    <Icon className="h-4 w-4" />
                    {tab.label}
                  </button>
                );
              })}
            </div>
          </div>

          {canManageCalendar && actionTab === 'CALENDAR' ? (
            <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <h2 className="text-sm font-semibold text-slate-900">我的日历维护</h2>
              <p className="text-xs text-slate-500">
                当前状态：{activeCalId ? '已选中可用日历' : '尚未绑定日历，请先创建新日历'}
              </p>
              <div className="space-y-1 rounded-md border border-slate-200 bg-slate-50 p-3">
                <p className="text-[11px] text-slate-500">日历ID（系统自动绑定，只读不可更改）</p>
                <p className="break-all text-xs font-medium text-slate-700">{activeCalId || '-'}</p>
              </div>
              <button
                onClick={createMyCalendar}
                className="w-full rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-emerald-700 disabled:opacity-60"
                disabled={loading}
              >
                创建新日历
              </button>
              <button
                onClick={refreshMySchedules}
                className="w-full rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-indigo-700 disabled:opacity-60"
                disabled={loading}
              >
                刷新我的日程
              </button>
              <input
                value={calendarForm.summary}
                onChange={(event) => setCalendarForm((prev) => ({ ...prev, summary: event.target.value }))}
                placeholder="日历名称"
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
              <input
                value={calendarForm.color}
                onChange={(event) => setCalendarForm((prev) => ({ ...prev, color: event.target.value }))}
                placeholder="主色（例如 #1D4ED8）"
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
              <textarea
                value={calendarForm.description}
                onChange={(event) => setCalendarForm((prev) => ({ ...prev, description: event.target.value }))}
                placeholder="日历描述"
                className="min-h-20 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
              <button
                onClick={updateMyCalendar}
                className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-amber-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-amber-700 disabled:opacity-60"
                disabled={loading}
              >
                <PencilLine className="h-4 w-4" />
                更新我的日历
              </button>
            </section>
          ) : null}

          {actionTab === 'SCHEDULE' ? (
            <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <h2 className="text-sm font-semibold text-slate-900">日程创建与编辑</h2>
              <button
                onClick={refreshMySchedules}
                className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-60"
                disabled={loading}
              >
                刷新我的日程
              </button>

              <div className="space-y-2 rounded-lg border border-slate-100 bg-slate-50 p-3">
                <p className="text-xs font-semibold text-slate-700">创建新日程</p>
                <input
                  value={scheduleComposer.summary}
                  onChange={(event) => setScheduleComposer((prev) => ({ ...prev, summary: event.target.value }))}
                  placeholder="日程标题"
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                />
                <textarea
                  value={scheduleComposer.description}
                  onChange={(event) =>
                    setScheduleComposer((prev) => ({ ...prev, description: event.target.value }))
                  }
                  placeholder="日程说明（可选）"
                  className="min-h-16 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                />
                <input
                  value={scheduleComposer.location}
                  onChange={(event) => setScheduleComposer((prev) => ({ ...prev, location: event.target.value }))}
                  placeholder="地点（可选）"
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                />
                <div className="space-y-2 rounded-md border border-slate-200 bg-white p-2">
                  <p className="text-[11px] font-semibold text-slate-700">提醒对象（@提及）</p>
                  <input
                    value={scheduleComposerMentions}
                    onChange={(event) => setScheduleComposerMentions(event.target.value)}
                    placeholder="@张三(zhangsan) @客户王总"
                    className="w-full rounded-md border border-slate-300 px-2 py-2 text-xs"
                  />
                  <p className="text-[11px] text-slate-500">
                    内部提醒 {composerMentionResult.internalUsers.length} 人，外部提醒{' '}
                    {composerMentionResult.externalNames.length} 人
                  </p>
                  {composerMentionCandidates.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      {composerMentionCandidates.map((member) => {
                        const userId = String(member.userid || '').trim();
                        if (!userId) {
                          return null;
                        }
                        const name = String(member.name || userId).trim() || userId;
                        return (
                          <button
                            key={`composer-mention-${userId}`}
                            onClick={() => appendComposerMentionUser(member)}
                            className="rounded-full border border-blue-200 bg-blue-50 px-2 py-1 text-[11px] text-blue-700 transition hover:bg-blue-100"
                            type="button"
                            disabled={loading}
                          >
                            @{name}({userId})
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                  <p className="text-[10px] text-slate-400">
                    输入 @ 后可点选内部成员；无通讯录权限时可手输 @姓名(userid) 指定内部提醒；未匹配内部账号的 @姓名 将按外部提醒写入日程说明。
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="datetime-local"
                    value={scheduleComposer.startAt}
                    onChange={(event) => setScheduleComposer((prev) => ({ ...prev, startAt: event.target.value }))}
                    className="w-full rounded-md border border-slate-300 px-2 py-2 text-xs"
                  />
                  <input
                    type="datetime-local"
                    value={scheduleComposer.endAt}
                    onChange={(event) => setScheduleComposer((prev) => ({ ...prev, endAt: event.target.value }))}
                    className="w-full rounded-md border border-slate-300 px-2 py-2 text-xs"
                  />
                </div>
                <button
                  onClick={createMySchedule}
                  className="w-full rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-blue-700 disabled:opacity-60"
                  disabled={loading}
                >
                  创建日程
                </button>
              </div>

              <div className="space-y-2 rounded-lg border border-slate-100 bg-slate-50 p-3">
                <p className="text-xs font-semibold text-slate-700">
                  编辑已选日程{selectedEvent ? `：${selectedEvent.summary}` : '（请先在月历中选择）'}
                </p>
                <input
                  value={scheduleEditor.summary}
                  onChange={(event) => setScheduleEditor((prev) => ({ ...prev, summary: event.target.value }))}
                  placeholder="日程标题"
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                  disabled={!selectedEvent}
                />
                <textarea
                  value={scheduleEditor.description}
                  onChange={(event) => setScheduleEditor((prev) => ({ ...prev, description: event.target.value }))}
                  placeholder="日程说明"
                  className="min-h-16 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                  disabled={!selectedEvent}
                />
                <input
                  value={scheduleEditor.location}
                  onChange={(event) => setScheduleEditor((prev) => ({ ...prev, location: event.target.value }))}
                  placeholder="地点"
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                  disabled={!selectedEvent}
                />
                <div className="space-y-2 rounded-md border border-slate-200 bg-white p-2">
                  <p className="text-[11px] font-semibold text-slate-700">提醒对象（@提及）</p>
                  <input
                    value={scheduleEditorMentions}
                    onChange={(event) => setScheduleEditorMentions(event.target.value)}
                    placeholder="@张三(zhangsan) @客户王总"
                    className="w-full rounded-md border border-slate-300 px-2 py-2 text-xs"
                    disabled={!selectedEvent}
                  />
                  <p className="text-[11px] text-slate-500">
                    内部提醒 {editorMentionResult.internalUsers.length} 人，外部提醒{' '}
                    {editorMentionResult.externalNames.length} 人
                  </p>
                  {editorMentionCandidates.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      {editorMentionCandidates.map((member) => {
                        const userId = String(member.userid || '').trim();
                        if (!userId) {
                          return null;
                        }
                        const name = String(member.name || userId).trim() || userId;
                        return (
                          <button
                            key={`editor-mention-${userId}`}
                            onClick={() => appendEditorMentionUser(member)}
                            className="rounded-full border border-blue-200 bg-blue-50 px-2 py-1 text-[11px] text-blue-700 transition hover:bg-blue-100 disabled:opacity-60"
                            type="button"
                            disabled={loading || !selectedEvent}
                          >
                            @{name}({userId})
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                  <p className="text-[10px] text-slate-400">
                    编辑时填写 @成员 可同步更新内部提醒；无通讯录权限时可手输 @姓名(userid)；@外部姓名 会记录到日程说明中。
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="datetime-local"
                    value={scheduleEditor.startAt}
                    onChange={(event) => setScheduleEditor((prev) => ({ ...prev, startAt: event.target.value }))}
                    className="w-full rounded-md border border-slate-300 px-2 py-2 text-xs"
                    disabled={!selectedEvent}
                  />
                  <input
                    type="datetime-local"
                    value={scheduleEditor.endAt}
                    onChange={(event) => setScheduleEditor((prev) => ({ ...prev, endAt: event.target.value }))}
                    className="w-full rounded-md border border-slate-300 px-2 py-2 text-xs"
                    disabled={!selectedEvent}
                  />
                </div>
                <button
                  onClick={updateSelectedSchedule}
                  className="w-full rounded-md bg-amber-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-amber-700 disabled:opacity-60"
                  disabled={loading || !selectedEvent}
                >
                  更新选中日程
                </button>
                <button
                  onClick={cancelSelectedSchedule}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-rose-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-rose-700 disabled:opacity-60"
                  disabled={loading || !selectedEvent}
                >
                  <Trash2 className="h-4 w-4" />
                  取消选中日程
                </button>
              </div>
            </section>
          ) : null}

          {actionTab === 'ATTENDEE' ? (
            <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <h2 className="text-sm font-semibold text-slate-900">参与人管理</h2>
              <p className="text-xs text-slate-500">
                {selectedEvent
                  ? `当前选中：${selectedEvent.summary}`
                  : '请先在月历里选择一个日程，然后从组织成员中选择参与人。'}
              </p>
              <label className="relative block">
                <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
                <input
                  value={attendeeKeyword}
                  onChange={(event) => setAttendeeKeyword(event.target.value)}
                  placeholder="搜索组织成员（姓名/账号/岗位）"
                  className="w-full rounded-md border border-slate-300 py-2 pl-9 pr-3 text-sm"
                />
              </label>
              <div className="max-h-56 space-y-2 overflow-auto rounded-md border border-slate-200 bg-slate-50 p-2">
                {orgUsersLoading ? (
                  <p className="p-2 text-xs text-slate-500">正在加载组织成员...</p>
                ) : filteredOrgUsers.length === 0 ? (
                  <div className="space-y-2 p-2">
                    <p className="text-xs text-slate-500">{orgUsersErrorHint || '没有匹配到可选成员。'}</p>
                    {orgUsersErrorHint ? (
                      <button
                        onClick={() => loadOrgUsers().catch(() => undefined)}
                        className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-600 transition hover:bg-slate-100"
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
                        className="flex cursor-pointer items-start gap-2 rounded-md border border-slate-200 bg-white px-2 py-2 text-xs text-slate-700 hover:border-blue-300"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleAttendeeSelection(userId)}
                          className="mt-0.5 h-3.5 w-3.5 rounded border-slate-300"
                        />
                        <span className="min-w-0">
                          <span className="block truncate font-medium text-slate-800">
                            {member.name || userId}
                          </span>
                          <span className="block truncate text-slate-500">{userId}</span>
                        </span>
                      </label>
                    );
                  })
                )}
              </div>
              <p className="text-xs text-slate-500">已选择 {selectedAttendeeUserIds.length} 位成员</p>
              <button
                onClick={addSelectedAttendeesToSchedule}
                className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-emerald-700 disabled:opacity-60"
                disabled={loading || !selectedEvent}
              >
                <UserRoundPlus className="h-4 w-4" />
                添加所选参与人
              </button>
              <button
                onClick={removeSelectedAttendeesFromSchedule}
                className="w-full rounded-md bg-orange-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-orange-700 disabled:opacity-60"
                disabled={loading || !selectedEvent}
              >
                移除所选参与人
              </button>
            </section>
          ) : null}

          {actionTab === 'RESULT' ? (
            <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <h2 className="text-sm font-semibold text-slate-900">操作结果</h2>
              {latestOperation ? (
                <div
                  className={`rounded-lg border p-3 ${
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
                <p className="rounded-lg border border-dashed border-slate-200 p-3 text-xs text-slate-400">
                  暂无操作记录，你执行动作后会在这里看到结果反馈。
                </p>
              )}

              <div className="max-h-[420px] space-y-2 overflow-auto pr-1">
                {operationHistory.map((record) => (
                  <div key={record.id} className="rounded-lg border border-slate-200 p-3">
                    <p className="text-xs font-semibold text-slate-700">{record.action}</p>
                    <p className="mt-1 text-xs text-slate-600">{record.message}</p>
                    <p className="mt-1 text-[11px] text-slate-400">{record.createdAt}</p>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </aside>
      </div>
    </div>
  );
};

export default CalendarManager;
