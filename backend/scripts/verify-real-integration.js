#!/usr/bin/env node
require('dotenv').config();

const db = require('../src/models/db');
const wecom = require('../src/services/wecom');
const syncService = require('../src/services/sync');
const userCalendarStore = require('../src/services/user-calendar-store');
const { userCalendarService } = require('../src/services/user-calendar');
const { normalizeText } = require('../src/services/task-lifecycle');

// REQUIRED_ENV_KEYS
// 是什么：联调脚本必需环境变量列表。
// 做什么：声明真实接口验收必须具备的配置项，用于启动前快速失败。
// 为什么：缺少关键配置会导致后续请求全部失败，提前拦截可减少排障成本。
const REQUIRED_ENV_KEYS = ['CORP_ID', 'CORP_SECRET', 'AGENT_ID'];

// runSql
// 是什么：SQLite 写操作 Promise 封装函数。
// 做什么：将 `db.run` 回调接口转换为 Promise，便于脚本串行执行。
// 为什么：联调脚本需要统一异步风格，避免回调嵌套影响可读性。
const runSql = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) {
        reject(err);
        return;
      }

      resolve({
        changes: this.changes || 0,
        lastID: this.lastID,
      });
    });
  });
};

// allSql
// 是什么：SQLite 多行查询 Promise 封装函数。
// 做什么：将 `db.all` 结果转为 Promise 并兜底空数组。
// 为什么：验收脚本需要稳定读取任务与映射样本，避免空值判空分散。
const allSql = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }

      resolve(rows || []);
    });
  });
};

// getSql
// 是什么：SQLite 单行查询 Promise 封装函数。
// 做什么：将 `db.get` 结果转为 Promise 并兜底 `null`。
// 为什么：脚本需要按用户读取单条映射，单行封装可复用查询逻辑。
const getSql = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
        return;
      }

      resolve(row || null);
    });
  });
};

// parseCliArgs
// 是什么：命令行参数解析函数。
// 做什么：支持 `--key value` 与布尔开关参数，并返回扁平对象。
// 为什么：脚本需支持按账号验收与输出模式切换，解析逻辑必须可测试复用。
const parseCliArgs = (argv = []) => {
  const result = {};
  const normalizedArgv = Array.isArray(argv) ? argv : [];

  for (let index = 0; index < normalizedArgv.length; index += 1) {
    const token = normalizeText(normalizedArgv[index]);
    if (!token.startsWith('--')) {
      continue;
    }

    const key = normalizeText(token.slice(2));
    if (!key) {
      continue;
    }

    const nextToken = normalizedArgv[index + 1];
    if (typeof nextToken === 'string' && !nextToken.trim().startsWith('--')) {
      result[key] = nextToken.trim();
      index += 1;
      continue;
    }

    result[key] = true;
  }

  return result;
};

// parseBooleanFlag
// 是什么：布尔参数解析函数。
// 做什么：将 `true/1/yes/on` 等文本与布尔值解析成统一布尔结果。
// 为什么：命令行参数和环境变量均可能以字符串传入，需要稳定解释。
const parseBooleanFlag = (value, fallbackValue = false) => {
  if (typeof value === 'boolean') {
    return value;
  }

  const normalizedValue = normalizeText(value).toLowerCase();
  if (!normalizedValue) {
    return Boolean(fallbackValue);
  }

  return ['1', 'true', 'yes', 'on'].includes(normalizedValue);
};

// resolveScriptOptions
// 是什么：脚本执行配置构建函数。
// 做什么：从命令行参数与环境变量汇总出用户、开关、输出格式等配置。
// 为什么：减少主流程中的条件判断，保证验收逻辑专注在业务步骤。
const resolveScriptOptions = (argv = process.argv.slice(2)) => {
  const rawArgs = parseCliArgs(argv);
  return {
    userId: normalizeText(rawArgs['user-id'] || process.env.REAL_VERIFY_USER_ID),
    userName: normalizeText(rawArgs['user-name'] || process.env.REAL_VERIFY_USER_NAME),
    skipEnsureCalendar: parseBooleanFlag(rawArgs['skip-ensure-calendar'], false),
    skipCalendarCrud: parseBooleanFlag(rawArgs['skip-calendar-crud'], false),
    skipSync: parseBooleanFlag(rawArgs['skip-sync'], false),
    resetTasksBeforeSync: parseBooleanFlag(rawArgs['reset-tasks-before-sync'], false),
    outputJson: parseBooleanFlag(rawArgs.json, true),
  };
};

// collectMissingEnvKeys
// 是什么：环境变量缺失项收集函数。
// 做什么：遍历必需配置并返回缺失键列表。
// 为什么：脚本在外部环境运行时，先给出明确缺失项可提高排障效率。
const collectMissingEnvKeys = (env = process.env) => {
  return REQUIRED_ENV_KEYS.filter((key) => !normalizeText(env && env[key]));
};

// buildStepResult
// 是什么：联调步骤结果构建函数。
// 做什么：统一返回结构化步骤对象，包含状态、名称、耗时与详情。
// 为什么：验收输出需同时支持人读与机器读，结构统一便于后续扩展。
const buildStepResult = (input = {}) => {
  return {
    name: normalizeText(input.name),
    status: normalizeText(input.status) || 'UNKNOWN',
    duration_ms: Number(input.durationMs || 0),
    detail: input.detail || {},
  };
};

// evaluateAcceptanceSummary
// 是什么：联调结果总评函数。
// 做什么：根据步骤结果与同步统计判定 `PASS/FAIL` 并输出失败原因。
// 为什么：真实接口联调应具备可自动化判定能力，避免人工解读偏差。
const evaluateAcceptanceSummary = (steps = [], context = {}) => {
  const failedSteps = (Array.isArray(steps) ? steps : []).filter((item) => item.status === 'FAIL');
  if (failedSteps.length > 0) {
    return {
      overall: 'FAIL',
      reason: `步骤失败: ${failedSteps.map((item) => item.name).join(', ')}`,
    };
  }

  const syncResult = context.syncResult || null;
  if (context.skipSync) {
    return {
      overall: 'PASS',
      reason: '跳过同步，仅完成建历与环境核验',
    };
  }

  if (!syncResult || syncResult.success !== true) {
    return {
      overall: 'FAIL',
      reason: `同步失败: ${(syncResult && syncResult.reason) || 'unknown'}`,
    };
  }

  if (Number(syncResult.calendar_success_count || 0) <= 0) {
    return {
      overall: 'FAIL',
      reason: '同步未命中任何可用日历',
    };
  }

  return {
    overall: 'PASS',
    reason: '真实接口联调通过',
  };
};

// runStep
// 是什么：联调步骤执行包装函数。
// 做什么：统一捕获异常并记录耗时，产出标准化步骤结果。
// 为什么：主流程包含多个外部依赖步骤，统一包装可减少重复错误处理。
const runStep = async (name, runner) => {
  const startTime = Date.now();

  try {
    const detail = await runner();
    return buildStepResult({
      name,
      status: 'PASS',
      durationMs: Date.now() - startTime,
      detail,
    });
  } catch (error) {
    return buildStepResult({
      name,
      status: 'FAIL',
      durationMs: Date.now() - startTime,
      detail: {
        message: error.message,
      },
    });
  }
};

// ensureWecomSuccess
// 是什么：企业微信接口返回校验函数。
// 做什么：统一校验 `errcode===0`，否则抛出包含上下文的错误信息。
// 为什么：闭环脚本包含多次 API 调用，需要稳定且一致的失败判定口径。
const ensureWecomSuccess = (stepName, result) => {
  const errcode = Number(result && result.errcode);
  if (!result || errcode !== 0) {
    const errmsg = normalizeText(result && result.errmsg) || 'unknown';
    throw new Error(`${stepName}失败: errcode=${Number.isFinite(errcode) ? errcode : 'unknown'} errmsg=${errmsg}`);
  }
  return result;
};

// runCalendarScheduleClosureFlow
// 是什么：日历与日程真实接口闭环执行函数。
// 做什么：按“创建日历→获取→更新→创建日程→查询→更新→参与人增删→取消日程→删除日历”顺序执行。
// 为什么：将核心业务链路脚本化，确保功能不是“单点可用”而是“全流程可用”。
const runCalendarScheduleClosureFlow = async (options = {}) => {
  const targetUserId = normalizeText(options.userId);
  const timestamp = Date.now();
  const created = {
    calId: '',
    scheduleId: '',
  };
  const detail = {
    target_user_id: targetUserId,
    steps: [],
  };

  const appendStep = (name, result) => {
    detail.steps.push({
      name,
      errcode: Number(result && result.errcode),
      errmsg: normalizeText(result && result.errmsg),
    });
  };

  try {
    const createCalendarPayload = {
      calendar: {
        summary: `任务管家联调日历-${timestamp}`,
        color: '#1D4ED8',
        description: '由 verify-real-integration.js 创建',
      },
    };

    if (targetUserId) {
      createCalendarPayload.calendar.admins = [targetUserId];
      createCalendarPayload.calendar.shares = [{ userid: targetUserId, permission: 1 }];
    }

    const createCalendarResult = ensureWecomSuccess('create_calendar', await wecom.createCalendar(createCalendarPayload));
    appendStep('create_calendar', createCalendarResult);
    created.calId = normalizeText(createCalendarResult.cal_id);
    if (!created.calId) {
      throw new Error('create_calendar 成功但 cal_id 为空');
    }

    const getCalendarResult = ensureWecomSuccess('get_calendar', await wecom.getCalendarByIds([created.calId]));
    appendStep('get_calendar', getCalendarResult);

    const updateCalendarResult = ensureWecomSuccess(
      'update_calendar',
      await wecom.updateCalendar({
        cal_id: created.calId,
        summary: `任务管家联调日历-${timestamp}-updated`,
        color: '#2563EB',
        description: '由 verify-real-integration.js 更新',
      })
    );
    appendStep('update_calendar', updateCalendarResult);

    const nowSeconds = Math.floor(Date.now() / 1000);
    const createScheduleResult = ensureWecomSuccess(
      'create_schedule',
      await wecom.createSchedule({
        cal_id: created.calId,
        summary: `任务管家联调日程-${timestamp}`,
        description: '由 verify-real-integration.js 创建',
        start_time: nowSeconds + 300,
        end_time: nowSeconds + 1800,
      })
    );
    appendStep('create_schedule', createScheduleResult);
    created.scheduleId = normalizeText(createScheduleResult.schedule_id);
    if (!created.scheduleId) {
      throw new Error('create_schedule 成功但 schedule_id 为空');
    }

    const getScheduleResult = ensureWecomSuccess(
      'get_schedule',
      await wecom.getSchedules([created.scheduleId])
    );
    appendStep('get_schedule', getScheduleResult);

    const scheduleListResult = ensureWecomSuccess(
      'get_by_calendar',
      await wecom.getScheduleList(created.calId, 0, 100)
    );
    appendStep('get_by_calendar', scheduleListResult);

    const updateScheduleResult = ensureWecomSuccess(
      'update_schedule',
      await wecom.updateSchedule({
        schedule_id: created.scheduleId,
        summary: `任务管家联调日程-${timestamp}-updated`,
        description: '由 verify-real-integration.js 更新',
        start_time: nowSeconds + 600,
        end_time: nowSeconds + 2400,
      })
    );
    appendStep('update_schedule', updateScheduleResult);

    if (targetUserId) {
      const addAttendeesResult = ensureWecomSuccess(
        'add_attendees',
        await wecom.addScheduleAttendees(created.scheduleId, [{ userid: targetUserId }])
      );
      appendStep('add_attendees', addAttendeesResult);

      const removeAttendeesResult = ensureWecomSuccess(
        'remove_attendees',
        await wecom.removeScheduleAttendees(created.scheduleId, [{ userid: targetUserId }])
      );
      appendStep('remove_attendees', removeAttendeesResult);
    } else {
      detail.steps.push({
        name: 'attendees_step_skipped',
        reason: 'missing_target_user_id',
      });
    }

    const cancelScheduleResult = ensureWecomSuccess(
      'cancel_schedule',
      await wecom.cancelSchedule(created.scheduleId)
    );
    appendStep('cancel_schedule', cancelScheduleResult);
    created.scheduleId = '';

    const deleteCalendarResult = ensureWecomSuccess(
      'delete_calendar',
      await wecom.deleteCalendar(created.calId)
    );
    appendStep('delete_calendar', deleteCalendarResult);
    created.calId = '';

    return {
      ...detail,
      cal_id: normalizeText(createCalendarResult.cal_id),
      schedule_id: normalizeText(createScheduleResult.schedule_id),
      completed: true,
    };
  } finally {
    // cleanup
    // 是什么：联调异常兜底清理逻辑。
    // 做什么：当主流程中途失败时尽量取消残留日程并删除测试日历。
    // 为什么：避免污染生产日历数据，确保脚本可重复执行。
    if (created.scheduleId) {
      try {
        await wecom.cancelSchedule(created.scheduleId);
      } catch (cleanupError) {
        detail.cleanup_schedule_error = normalizeText(cleanupError && cleanupError.message);
      }
    }

    if (created.calId) {
      try {
        await wecom.deleteCalendar(created.calId);
      } catch (cleanupError) {
        detail.cleanup_calendar_error = normalizeText(cleanupError && cleanupError.message);
      }
    }
  }
};

// createAcceptanceReport
// 是什么：真实接口验收主流程函数。
// 做什么：执行环境检查、token 拉取、建历复用、同步与落库核验并返回报告。
// 为什么：将原本手工排查步骤脚本化，保证每次联调都可重复执行与对比结果。
const createAcceptanceReport = async (options = {}) => {
  const normalizedOptions = {
    userId: normalizeText(options.userId),
    userName: normalizeText(options.userName),
    skipEnsureCalendar: Boolean(options.skipEnsureCalendar),
    skipCalendarCrud: Boolean(options.skipCalendarCrud),
    skipSync: Boolean(options.skipSync),
    resetTasksBeforeSync: Boolean(options.resetTasksBeforeSync),
  };

  const steps = [];
  let syncResult = null;
  let tasksBeforeSync = null;
  let tasksAfterSync = null;

  const envCheckStep = await runStep('env_check', async () => {
    const missingKeys = collectMissingEnvKeys(process.env);
    if (missingKeys.length > 0) {
      throw new Error(`缺少环境变量: ${missingKeys.join(', ')}`);
    }

    return {
      required_env_ready: true,
      has_default_cal_id: Boolean(normalizeText(process.env.DEFAULT_CAL_ID)),
      has_user_calendar_map: Boolean(normalizeText(process.env.USER_CALENDAR_MAP)),
    };
  });
  steps.push(envCheckStep);
  if (envCheckStep.status !== 'PASS') {
    return {
      generated_at: new Date().toISOString(),
      options: normalizedOptions,
      steps,
      summary: evaluateAcceptanceSummary(steps, {
        syncResult,
        skipSync: normalizedOptions.skipSync,
      }),
    };
  }

  const tokenStep = await runStep('wecom_token', async () => {
    const token = await wecom.getAccessToken();
    if (!normalizeText(token)) {
      throw new Error('access_token 为空');
    }

    return {
      token_ready: true,
      token_length: String(token).length,
    };
  });
  steps.push(tokenStep);

  const beforeMapStep = await runStep('calendar_map_before', async () => {
    const allRows = await userCalendarStore.listUserCalendarRows();
    const targetUserId = normalizedOptions.userId;
    const userRow = targetUserId
      ? await userCalendarStore.getUserCalendarRowByUserId(targetUserId)
      : allRows[0] || null;

    return {
      total_map_rows: allRows.length,
      target_user_id: normalizeText(targetUserId || (userRow && userRow.user_id)),
      target_cal_id: normalizeText(userRow && userRow.cal_id),
      target_source: normalizeText(userRow && userRow.source),
    };
  });
  steps.push(beforeMapStep);

  if (!normalizedOptions.skipEnsureCalendar) {
    const ensureCalendarStep = await runStep('ensure_user_calendar', async () => {
      const targetUserId = normalizedOptions.userId;
      if (!targetUserId) {
        throw new Error('未提供 --user-id，无法执行账号级自动建历校验');
      }

      const result = await userCalendarService.ensureUserCalendarForUser({
        userId: targetUserId,
        userName: normalizedOptions.userName,
        source: 'real_integration_script',
      });
      if (!result || result.ensured !== true) {
        throw new Error(
          `账号建历失败: reason=${normalizeText(result && result.reason) || 'unknown'}`
        );
      }

      return {
        user_id: targetUserId,
        ensured: Boolean(result && result.ensured),
        created: Boolean(result && result.created),
        reason: normalizeText(result && result.reason),
        cal_id: normalizeText(result && result.cal_id),
        errcode: result && result.errcode,
        errmsg: normalizeText(result && result.errmsg),
      };
    });
    steps.push(ensureCalendarStep);
  } else {
    steps.push(
      buildStepResult({
        name: 'ensure_user_calendar',
        status: 'SKIP',
        durationMs: 0,
        detail: {
          reason: 'skip_ensure_calendar',
        },
      })
    );
  }

  const afterMapStep = await runStep('calendar_map_after', async () => {
    const allRows = await userCalendarStore.listUserCalendarRows();
    const targetUserId = normalizedOptions.userId;
    const userRow = targetUserId
      ? await userCalendarStore.getUserCalendarRowByUserId(targetUserId)
      : allRows[0] || null;

    return {
      total_map_rows: allRows.length,
      target_user_id: normalizeText(targetUserId || (userRow && userRow.user_id)),
      target_cal_id: normalizeText(userRow && userRow.cal_id),
      target_source: normalizeText(userRow && userRow.source),
    };
  });
  steps.push(afterMapStep);

  if (!normalizedOptions.skipCalendarCrud) {
    const calendarCrudStep = await runStep('calendar_schedule_closure', async () => {
      const resolvedUserId =
        normalizeText(normalizedOptions.userId) ||
        normalizeText(afterMapStep && afterMapStep.detail && afterMapStep.detail.target_user_id);
      return runCalendarScheduleClosureFlow({
        userId: resolvedUserId,
      });
    });
    steps.push(calendarCrudStep);
  } else {
    steps.push(
      buildStepResult({
        name: 'calendar_schedule_closure',
        status: 'SKIP',
        durationMs: 0,
        detail: {
          reason: 'skip_calendar_crud',
        },
      })
    );
  }

  const beforeSyncStep = await runStep('tasks_before_sync', async () => {
    if (normalizedOptions.resetTasksBeforeSync) {
      await runSql('DELETE FROM tasks');
    }

    const row = await getSql('SELECT COUNT(1) AS count FROM tasks');
    tasksBeforeSync = Number((row && row.count) || 0);

    const latestRows = await allSql(
      `SELECT id, wecom_schedule_id, title, creator_userid, executor_userid, owner_userid, owner_cal_id, status
       FROM tasks ORDER BY datetime(created_at) DESC, id DESC LIMIT 5`
    );

    return {
      task_count: tasksBeforeSync,
      latest_tasks: latestRows,
    };
  });
  steps.push(beforeSyncStep);

  if (!normalizedOptions.skipSync) {
    const syncStep = await runStep('sync_schedules', async () => {
      syncResult = await syncService.syncSchedules();
      if (!syncResult || syncResult.success !== true) {
        throw new Error(
          `同步失败: reason=${normalizeText(syncResult && syncResult.reason) || 'unknown'}`
        );
      }
      return syncResult || {};
    });
    steps.push(syncStep);
  } else {
    steps.push(
      buildStepResult({
        name: 'sync_schedules',
        status: 'SKIP',
        durationMs: 0,
        detail: {
          reason: 'skip_sync',
        },
      })
    );
  }

  const afterSyncStep = await runStep('tasks_after_sync', async () => {
    const row = await getSql('SELECT COUNT(1) AS count FROM tasks');
    tasksAfterSync = Number((row && row.count) || 0);

    const latestRows = await allSql(
      `SELECT id, wecom_schedule_id, title, creator_userid, executor_userid, owner_userid, owner_cal_id, status
       FROM tasks ORDER BY datetime(updated_at) DESC, id DESC LIMIT 10`
    );

    return {
      task_count: tasksAfterSync,
      task_delta: Number(tasksAfterSync || 0) - Number(tasksBeforeSync || 0),
      latest_tasks: latestRows,
    };
  });
  steps.push(afterSyncStep);

  return {
    generated_at: new Date().toISOString(),
    options: normalizedOptions,
    steps,
    summary: evaluateAcceptanceSummary(steps, {
      syncResult,
      skipSync: normalizedOptions.skipSync,
    }),
  };
};

// printHumanReadableReport
// 是什么：终端可读报告输出函数。
// 做什么：将结构化报告转为分段文本，便于开发者快速查看关键结论。
// 为什么：联调场景常在终端查看，纯 JSON 对人眼不够友好。
const printHumanReadableReport = (report) => {
  const summary = report && report.summary ? report.summary : {};
  const steps = Array.isArray(report && report.steps) ? report.steps : [];

  console.log('=== 真实接口联调验收报告 ===');
  console.log(`生成时间: ${normalizeText(report && report.generated_at)}`);
  console.log(`总评: ${normalizeText(summary.overall)} (${normalizeText(summary.reason)})`);
  console.log('');
  console.log('步骤明细:');
  steps.forEach((step) => {
    const status = normalizeText(step && step.status);
    const name = normalizeText(step && step.name);
    const durationMs = Number(step && step.duration_ms);
    console.log(`- [${status}] ${name} (${durationMs}ms)`);
  });
  console.log('');
  console.log('JSON 报告:');
  console.log(JSON.stringify(report, null, 2));
};

// main
// 是什么：脚本入口函数。
// 做什么：解析参数、执行联调并根据结果设置退出码。
// 为什么：提供一键运行能力，方便 CI 与本地联调复用。
const main = async () => {
  const options = resolveScriptOptions(process.argv.slice(2));
  const report = await createAcceptanceReport(options);

  if (options.outputJson) {
    printHumanReadableReport(report);
  } else {
    console.log(JSON.stringify(report));
  }

  if (normalizeText(report && report.summary && report.summary.overall) !== 'PASS') {
    process.exitCode = 1;
  }
};

if (require.main === module) {
  main().catch((error) => {
    console.error(
      JSON.stringify(
        {
          generated_at: new Date().toISOString(),
          summary: {
            overall: 'FAIL',
            reason: `脚本异常: ${error.message}`,
          },
        },
        null,
        2
      )
    );
    process.exitCode = 1;
  });
}

module.exports = {
  REQUIRED_ENV_KEYS,
  parseCliArgs,
  parseBooleanFlag,
  resolveScriptOptions,
  collectMissingEnvKeys,
  evaluateAcceptanceSummary,
  ensureWecomSuccess,
  runCalendarScheduleClosureFlow,
  createAcceptanceReport,
};
