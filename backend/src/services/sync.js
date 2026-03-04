const wecom = require('./wecom');
const cron = require('node-cron');
const { taskService } = require('./task');
const { buildSyncCalendarTargets } = require('./calendar-mapping');
const userCalendarStore = require('./user-calendar-store');
const { logWithTrace, createTraceId } = require('../utils/logger');

class SyncService {
  constructor() {
    this.defaultCalId = process.env.DEFAULT_CAL_ID || '';
    this.userCalendarMapRaw = process.env.USER_CALENDAR_MAP || '';
  }

  // resolveSyncCalendarTargets
  // 是什么：同步目标日历解析函数。
  // 做什么：融合员工映射与默认日历配置，生成最终同步目标列表。
  // 为什么：支持“每员工一个 cal_id”方案，同时兼容历史默认日历模式。
  async resolveSyncCalendarTargets() {
    const userCalendarRows = await userCalendarStore.listUserCalendarRows();
    return buildSyncCalendarTargets({
      defaultCalId: process.env.DEFAULT_CAL_ID || this.defaultCalId,
      userCalendarMapRaw: process.env.USER_CALENDAR_MAP || this.userCalendarMapRaw,
      userCalendarRows,
    });
  }

  // resolveWeComErrorReason
  // 是什么：企业微信错误码语义映射函数。
  // 做什么：将关键错误码映射为稳定 reason，便于前端与日志做精确提示。
  // 为什么：仅返回原始 errmsg 可读性差，且无法在界面层进行结构化处理。
  resolveWeComErrorReason(errcode, fallbackReason) {
    if (Number(errcode) === 60020) {
      return 'wecom_ip_not_allowed';
    }

    return fallbackReason;
  }

  // resolveSyncPageLimit
  // 是什么：同步分页大小解析函数。
  // 做什么：读取并约束 `WECOM_SYNC_PAGE_LIMIT` 到 `1~1000`，缺省回退为 `500`。
  // 为什么：企业微信 `get_by_calendar` 分页上限是 1000，统一收口避免配置越界。
  resolveSyncPageLimit() {
    const rawLimit = Number(process.env.WECOM_SYNC_PAGE_LIMIT || 500);
    if (!Number.isFinite(rawLimit)) {
      return 500;
    }

    const normalizedLimit = Math.floor(rawLimit);
    return Math.min(1000, Math.max(1, normalizedLimit));
  }

  // resolveSyncMaxPages
  // 是什么：同步分页最大页数解析函数。
  // 做什么：读取 `WECOM_SYNC_MAX_PAGES`，缺省 200 页，防止异常数据导致死循环。
  // 为什么：分页接口在极端情况下可能持续返回满页数据，需要硬性保险阈值。
  resolveSyncMaxPages() {
    const rawMaxPages = Number(process.env.WECOM_SYNC_MAX_PAGES || 200);
    if (!Number.isFinite(rawMaxPages)) {
      return 200;
    }

    return Math.max(1, Math.floor(rawMaxPages));
  }

  // fetchCalendarSchedules
  // 是什么：日历全量分页拉取函数。
  // 做什么：通过 `offset + limit` 循环调用 `get_by_calendar`，直到返回量小于分页大小为止。
  // 为什么：官方接口需要分页读取，单次请求会导致大日历数据被截断。
  async fetchCalendarSchedules(calId) {
    const traceId = createTraceId();
    const pageLimit = this.resolveSyncPageLimit();
    const maxPages = this.resolveSyncMaxPages();
    const scheduleList = [];
    let offset = 0;
    let pageCount = 0;

    while (true) {
      if (pageCount >= maxPages) {
        return {
          success: false,
          reason: 'wecom_schedule_list_page_limit_exceeded',
          errcode: -1,
          errmsg: `分页拉取超限: max_pages=${maxPages}`,
        };
      }

      pageCount += 1;
      const scheduleListResult = await wecom.getScheduleList(calId, offset, pageLimit);

      if (!scheduleListResult || scheduleListResult.errcode !== 0) {
        return {
          success: false,
          errcode: scheduleListResult && scheduleListResult.errcode,
          errmsg: scheduleListResult && scheduleListResult.errmsg,
          reason: this.resolveWeComErrorReason(
            scheduleListResult && scheduleListResult.errcode,
            'wecom_schedule_list_failed'
          ),
        };
      }

      const pageRows = Array.isArray(scheduleListResult.schedule_list) ? scheduleListResult.schedule_list : [];
      scheduleList.push(...pageRows);

      logWithTrace(traceId, 'sync-service', 'calendar.page.fetched', {
        calId,
        offset,
        pageLimit,
        pageCount,
        pageScheduleCount: pageRows.length,
        totalScheduleCount: scheduleList.length,
      });

      if (pageRows.length < pageLimit) {
        return {
          success: true,
          schedules: scheduleList,
          page_count: pageCount,
        };
      }

      offset += pageRows.length;
    }
  }

  start() {
    cron.schedule('*/10 * * * *', () => {
      const traceId = createTraceId();
      logWithTrace(traceId, 'sync-service', 'cron.tick', {
        schedule: '*/10 * * * *',
      });
      this.syncSchedules();
    });

    logWithTrace(createTraceId(), 'sync-service', 'startup.trigger', {
      reason: 'service_start',
    });
    this.syncSchedules();
  }

  async syncSchedules() {
    const traceId = createTraceId();
    const calendarTargets = await this.resolveSyncCalendarTargets();

    if (calendarTargets.length === 0) {
      logWithTrace(traceId, 'sync-service', 'sync.skip', {
        reason: 'missing_calendar_targets',
      });
      return {
        success: false,
        reason: 'missing_calendar_targets',
      };
    }

    try {
      logWithTrace(traceId, 'sync-service', 'sync.start', {
        calendarTargets,
      });
      const summary = {
        success: true,
        calendar_count: calendarTargets.length,
        calendar_success_count: 0,
        calendar_failed_count: 0,
        calendar_errors: [],
        schedule_count: 0,
        unique_schedule_count: 0,
        inserted_count: 0,
        updated_count: 0,
        skipped_count: 0,
        reminder_sent_count: 0,
      };
      const processedScheduleIds = new Set();

      for (const calendarTarget of calendarTargets) {
        const calId = calendarTarget && calendarTarget.cal_id;
        const ownerUserId = calendarTarget && calendarTarget.user_id;

        if (!calId) {
          summary.calendar_failed_count += 1;
          summary.calendar_errors.push({
            user_id: ownerUserId || '',
            cal_id: '',
            reason: 'invalid_cal_id',
          });
          continue;
        }

        const scheduleFetchResult = await this.fetchCalendarSchedules(calId);
        if (!scheduleFetchResult.success) {
          summary.calendar_failed_count += 1;
          summary.calendar_errors.push({
            user_id: ownerUserId || '',
            cal_id: calId,
            reason: scheduleFetchResult.reason || 'wecom_schedule_list_failed',
            errcode: scheduleFetchResult.errcode,
            errmsg: scheduleFetchResult.errmsg,
          });
          continue;
        }

        summary.calendar_success_count += 1;

        const schedules = Array.isArray(scheduleFetchResult.schedules) ? scheduleFetchResult.schedules : [];
        summary.schedule_count += schedules.length;

        for (const item of schedules) {
          const scheduleId = item && item.schedule_id;
          if (!scheduleId || processedScheduleIds.has(scheduleId)) {
            summary.skipped_count += 1;
            continue;
          }

          processedScheduleIds.add(scheduleId);

          const processResult = await this.processSchedule(scheduleId, calendarTarget);
          if (processResult.inserted) {
            summary.inserted_count += 1;
          } else if (processResult.updated) {
            summary.updated_count += 1;
          } else {
            summary.skipped_count += 1;
          }
        }
      }

      summary.unique_schedule_count = processedScheduleIds.size;

      const reminderResult = await this.dispatchDateReminders();
      summary.reminder_sent_count = reminderResult.sent_count;

      logWithTrace(traceId, 'sync-service', 'sync.success', summary);
      return summary;
    } catch (error) {
      logWithTrace(traceId, 'sync-service', 'sync.error', {
        message: error.message,
        stack: error.stack,
      });

      return {
        success: false,
        reason: 'sync_exception',
        message: error.message,
      };
    }
  }

  async processSchedule(scheduleId, calendarContext = {}) {
    const traceId = createTraceId();

    try {
      logWithTrace(traceId, 'sync-service', 'schedule.process.start', {
        scheduleId,
        calendarContext,
      });

      const details = await wecom.getSchedule(scheduleId);
      const detailScheduleList = Array.isArray(details && details.schedule_list) ? details.schedule_list : [];
      const detailSchedule = (details && details.schedule) || detailScheduleList[0] || null;

      if (!details || details.errcode !== 0 || !detailSchedule) {
        logWithTrace(traceId, 'sync-service', 'schedule.process.reject', {
          scheduleId,
          errcode: details && details.errcode,
          errmsg: details && details.errmsg,
        });

        return {
          inserted: false,
          updated: false,
          skipped: true,
          reason: 'schedule_detail_invalid',
        };
      }

      const result = await taskService.syncScheduleTask(detailSchedule, calendarContext);
      logWithTrace(traceId, 'sync-service', 'schedule.process.success', {
        scheduleId,
        calendarContext,
        result,
      });
      return result;
    } catch (error) {
      logWithTrace(traceId, 'sync-service', 'schedule.process.error', {
        scheduleId,
        message: error.message,
        stack: error.stack,
      });

      return {
        inserted: false,
        updated: false,
        skipped: true,
        reason: 'schedule_process_exception',
      };
    }
  }

  async dispatchDateReminders() {
    const traceId = createTraceId();

    try {
      const pendingTasks = await taskService.listPendingTasks();
      let sentCount = 0;
      let checkedCount = 0;

      for (const task of pendingTasks) {
        const result = await taskService.dispatchTaskReminder(task, 'sync_cron');
        checkedCount += 1;
        if (result.sent) {
          sentCount += 1;
        }
      }

      const summary = {
        sent_count: sentCount,
        checked_count: checkedCount,
      };

      logWithTrace(traceId, 'sync-service', 'reminder.dispatch.success', summary);
      return summary;
    } catch (error) {
      logWithTrace(traceId, 'sync-service', 'reminder.dispatch.error', {
        message: error.message,
        stack: error.stack,
      });

      return {
        sent_count: 0,
        checked_count: 0,
      };
    }
  }
}

module.exports = new SyncService();
