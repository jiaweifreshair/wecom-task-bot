const wecom = require('./wecom');
const cron = require('node-cron');
const { taskService } = require('./task');
const { buildSyncCalendarTargets } = require('./calendar-mapping');
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
  resolveSyncCalendarTargets() {
    return buildSyncCalendarTargets({
      defaultCalId: process.env.DEFAULT_CAL_ID || this.defaultCalId,
      userCalendarMapRaw: process.env.USER_CALENDAR_MAP || this.userCalendarMapRaw,
    });
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
    const calendarTargets = this.resolveSyncCalendarTargets();

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

        const scheduleListResult = await wecom.getScheduleList(calId);
        if (scheduleListResult.errcode !== 0) {
          summary.calendar_failed_count += 1;
          summary.calendar_errors.push({
            user_id: ownerUserId || '',
            cal_id: calId,
            reason: 'wecom_schedule_list_failed',
            errcode: scheduleListResult.errcode,
            errmsg: scheduleListResult.errmsg,
          });
          continue;
        }

        summary.calendar_success_count += 1;

        const schedules = Array.isArray(scheduleListResult.schedule_list)
          ? scheduleListResult.schedule_list
          : [];
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
      if (details.errcode !== 0 || !details.schedule) {
        logWithTrace(traceId, 'sync-service', 'schedule.process.reject', {
          scheduleId,
          errcode: details.errcode,
          errmsg: details.errmsg,
        });

        return {
          inserted: false,
          updated: false,
          skipped: true,
          reason: 'schedule_detail_invalid',
        };
      }

      const result = await taskService.syncScheduleTask(details.schedule, calendarContext);
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
