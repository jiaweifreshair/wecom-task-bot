import path from 'node:path';
import { createRequire } from 'node:module';
import { test, expect, type Page } from '@playwright/test';

const require = createRequire(import.meta.url);
const dotenv = require('../../backend/node_modules/dotenv');
const jwt = require('../../backend/node_modules/jsonwebtoken');
const sqlite3 = require('../../backend/node_modules/sqlite3');

// frontendDir / backendDir / backendEnvPath / e2eDbPath
// 是什么：前后端目录、后端环境文件与 E2E 隔离数据库路径。
// 做什么：为浏览器回归统一定位后端 `.env` 与 `tasks.e2e.db`，避免依赖当前 shell 工作目录。
// 为什么：Playwright 会在独立进程启动服务，路径不稳定时最容易出现“本地能跑、CI 失败”的问题。
const frontendDir = process.cwd();
const backendDir = path.resolve(frontendDir, '../backend');
const backendEnvPath = path.resolve(backendDir, '.env');
const e2eDbPath = path.resolve(backendDir, 'database/tasks.e2e.db');
// E2E_USER_ID / E2E_USER_NAME
// 是什么：烟雾回归固定使用的测试账号标识。
// 做什么：为造数、发 token 和界面断言提供稳定的用户主键与展示名。
// 为什么：无头回归不能依赖真实扫码登录，必须使用可重复的固定身份。
const E2E_USER_ID = 'pw-e2e-user';
const E2E_USER_NAME = 'Playwright回归用户';

dotenv.config({ path: backendEnvPath });

// AuthTokenOptions
// 是什么：E2E 登录令牌构建参数。
// 做什么：允许回归脚本按需覆盖测试账号的姓名、角色和头像。
// 为什么：管理者入口、执行人入口需要在同一套无人值守脚本中复用登录流程。
interface AuthTokenOptions {
  userid?: string;
  name?: string;
  avatar?: string;
  role?: 'MANAGER' | 'EXECUTOR';
}

// createDatabaseClient
// 是什么：E2E 测试数据库连接工厂。
// 做什么：连接隔离的 `tasks.e2e.db` 并提供给用例做断言与清理。
// 为什么：浏览器回归需要可重复、可清理的数据基座，不能写入正式联调库。
const createDatabaseClient = () => {
  return new sqlite3.Database(e2eDbPath);
};

// runSql
// 是什么：E2E 测试写库辅助函数。
// 做什么：执行 SQLite 写操作并返回变更结果。
// 为什么：烟雾回归需要在测试前后稳定造数和清理数据。
const runSql = async (sql: string, params: unknown[] = []) => {
  const db = createDatabaseClient();

  return new Promise<{ changes: number; lastID?: number }>((resolve, reject) => {
    db.run(sql, params, function onRun(error: Error | null) {
      db.close();
      if (error) {
        reject(error);
        return;
      }

      resolve({
        changes: this.changes || 0,
        lastID: this.lastID,
      });
    });
  });
};

// getSql
// 是什么：E2E 测试单行查询辅助函数。
// 做什么：执行 SQLite 单行查询，未命中时返回 `null`。
// 为什么：任务状态流转需要直查数据库确认最终结果，而不是只看页面文案。
const getSql = async <TRow extends Record<string, unknown>>(sql: string, params: unknown[] = []) => {
  const db = createDatabaseClient();

  return new Promise<TRow | null>((resolve, reject) => {
    db.get(sql, params, (error: Error | null, row: TRow | undefined) => {
      db.close();
      if (error) {
        reject(error);
        return;
      }

      resolve(row || null);
    });
  });
};

// resetE2eDatabase
// 是什么：E2E 测试数据库重置函数。
// 做什么：清空测试过程中会写入的任务、映射和通讯录快照表。
// 为什么：确保每条用例独立运行，不受上一次回归残留数据影响。
const resetE2eDatabase = async () => {
  await runSql('DELETE FROM tasks');
  await runSql('DELETE FROM user_calendar_map');
  await runSql('DELETE FROM platform_user_access');
  await runSql('DELETE FROM wecom_contact_users');
  await runSql('DELETE FROM wecom_contact_departments');
  await runSql('DELETE FROM wecom_contact_tags');
  await runSql('DELETE FROM wecom_contact_event_log');
};

// upsertPlatformAccess
// 是什么：E2E 平台角色写入函数。
// 做什么：为测试账号写入平台权限表，确保后端 `/user/me` 与 JWT 角色保持一致。
// 为什么：新版本权限以数据库为准，仅写 token 已不足以驱动管理员/执行对象菜单分支。
const upsertPlatformAccess = async (userId: string, role: 'ADMIN' | 'EXECUTOR') => {
  await runSql(
    `INSERT INTO platform_user_access (user_id, platform_role, updated_by_userid, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET
       platform_role = excluded.platform_role,
       updated_by_userid = excluded.updated_by_userid,
       updated_at = datetime('now')`,
    [userId, role, 'playwright']
  );
};

// upsertCalendarMapping
// 是什么：E2E 日历映射写入函数。
// 做什么：为测试账号写入隔离环境下的日历映射记录。
// 为什么：日历页需要“当前账号已绑定日历”的状态，才能覆盖核心界面分支。
const upsertCalendarMapping = async () => {
  await runSql(
    `INSERT INTO user_calendar_map (user_id, cal_id, calendar_summary, source, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET
       cal_id = excluded.cal_id,
       calendar_summary = excluded.calendar_summary,
       source = excluded.source,
       updated_at = datetime('now')`,
    [E2E_USER_ID, 'cal-e2e', 'Playwright E2E Calendar', 'e2e_seed']
  );
};

// seedTaskRows
// 是什么：统计页测试数据种子函数。
// 做什么：向隔离库写入一条已完成任务和一条待执行任务。
// 为什么：仪表盘和团队统计页需要稳定的统计样本，不能依赖 UI 前置操作串联。
const seedTaskRows = async () => {
  await runSql(
    `INSERT INTO tasks (
      wecom_schedule_id, title, description, creator_userid, executor_userid, owner_userid, owner_cal_id,
      start_time, end_time, status, completion_time, verify_time, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', '-3 hour'), datetime('now', '+1 hour'), ?, datetime('now', '-2 hour'), datetime('now', '-90 minute'), datetime('now'))`,
    ['seed-completed', 'SEED_COMPLETED_TASK', 'seed', E2E_USER_ID, E2E_USER_ID, E2E_USER_ID, '', 'COMPLETED']
  );

  await runSql(
    `INSERT INTO tasks (
      wecom_schedule_id, title, description, creator_userid, executor_userid, owner_userid, owner_cal_id,
      start_time, end_time, status, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', '-2 hour'), datetime('now', '+30 minute'), ?, datetime('now'))`,
    ['seed-pending', 'SEED_PENDING_TASK', 'seed', E2E_USER_ID, E2E_USER_ID, E2E_USER_ID, '', 'PENDING']
  );
};

// buildAuthToken
// 是什么：E2E 测试登录令牌生成函数。
// 做什么：按后端 JWT 密钥生成测试账号 token，用于绕过人工扫码登录。
// 为什么：回归脚本必须可无人值守执行，不能依赖企业微信扫码。
const buildAuthToken = (options: AuthTokenOptions = {}) => {
  return jwt.sign(
    {
      userid: options.userid || E2E_USER_ID,
      name: options.name || E2E_USER_NAME,
      avatar: options.avatar || '',
      role: options.role || 'MANAGER',
    },
    process.env.JWT_SECRET || 'wecom-task-bot-secret',
    { expiresIn: '24h' }
  );
};

// buildTaskListPayload
// 是什么：前端联动回归任务列表响应构建函数。
// 做什么：把“日历页已创建的工作日程”转换为 `/api/tasks` 所需返回结构。
// 为什么：该用例要验证 App 在日历操作后是否会立即刷新任务 / 仪表盘状态。
const buildTaskListPayload = (
  taskRows: Array<{
    scheduleId: string;
    title: string;
    executorUserId: string;
    startTime: number;
    endTime: number;
  }>
) => {
  return {
    tasks: taskRows.map((item, index) => ({
      id: index + 1,
      wecom_schedule_id: item.scheduleId,
      title: item.title,
      description: '来自日历日程的工作内容',
      creator_userid: E2E_USER_ID,
      executor_userid: item.executorUserId,
      start_time: new Date(item.startTime * 1000).toISOString(),
      end_time: new Date(item.endTime * 1000).toISOString(),
      status: 'PENDING',
      redo_count: 0,
      can_complete: true,
      can_verify: false,
      is_due_soon: false,
      is_overdue: false,
    })),
    kpi: {
      total_tasks: taskRows.length,
      completed_tasks: 0,
      waiting_verify_tasks: 0,
      overdue_tasks: 0,
      due_soon_tasks: 0,
      completion_rate: 0,
      on_time_rate: 0,
    },
  };
};

// buildTeamStatsPayload
// 是什么：前端联动回归团队统计响应构建函数。
// 做什么：把日历页创建出的工作项汇总成 `/api/tasks/team-stats` 响应。
// 为什么：需要验证团队统计页读取的是同一套工作项数据，而不是独立的假数据源。
const buildTeamStatsPayload = (
  taskRows: Array<{
    executorUserId: string;
    executorName: string;
  }>
) => {
  const executorCounts = new Map<string, { userId: string; userName: string; taskCount: number }>();
  taskRows.forEach((item) => {
    const existed = executorCounts.get(item.executorUserId);
    if (existed) {
      existed.taskCount += 1;
      return;
    }
    executorCounts.set(item.executorUserId, {
      userId: item.executorUserId,
      userName: item.executorName,
      taskCount: 1,
    });
  });

  const executorMembers = Array.from(executorCounts.values()).map((item) => ({
    role: 'EXECUTOR',
    user_id: item.userId,
    user_name: item.userName,
    position: '执行岗',
    member_count: 1,
    task_count: item.taskCount,
    completed_count: 0,
    pending_count: item.taskCount,
    waiting_verify_count: 0,
    overdue_count: 0,
    due_soon_count: 0,
    completion_rate: 0,
    on_time_rate: 0,
  }));

  return {
    team_stats: {
      summaries: {
        manager: {
          role: 'MANAGER',
          user_id: E2E_USER_ID,
          user_name: E2E_USER_NAME,
          position: '管理岗',
          member_count: 1,
          task_count: taskRows.length,
          completed_count: 0,
          pending_count: taskRows.length,
          waiting_verify_count: 0,
          overdue_count: 0,
          due_soon_count: 0,
          completion_rate: 0,
          on_time_rate: 0,
        },
        executor: {
          role: 'EXECUTOR',
          member_count: executorMembers.length,
          task_count: taskRows.length,
          completed_count: 0,
          pending_count: taskRows.length,
          waiting_verify_count: 0,
          overdue_count: 0,
          due_soon_count: 0,
          completion_rate: 0,
          on_time_rate: 0,
        },
      },
      members: {
        manager: [
          {
            role: 'MANAGER',
            user_id: E2E_USER_ID,
            user_name: E2E_USER_NAME,
            position: '管理岗',
            member_count: 1,
            task_count: taskRows.length,
            completed_count: 0,
            pending_count: taskRows.length,
            waiting_verify_count: 0,
            overdue_count: 0,
            due_soon_count: 0,
            completion_rate: 0,
            on_time_rate: 0,
          },
        ],
        executor: executorMembers,
      },
      positions: {
        manager: [
          {
            role: 'MANAGER',
            position: '管理岗',
            member_count: 1,
            task_count: taskRows.length,
            completed_count: 0,
            pending_count: taskRows.length,
            waiting_verify_count: 0,
            overdue_count: 0,
            due_soon_count: 0,
            completion_rate: 0,
            on_time_rate: 0,
          },
        ],
        executor: [
          {
            role: 'EXECUTOR',
            position: '执行岗',
            member_count: executorMembers.length,
            task_count: taskRows.length,
            completed_count: 0,
            pending_count: taskRows.length,
            waiting_verify_count: 0,
            overdue_count: 0,
            due_soon_count: 0,
            completion_rate: 0,
            on_time_rate: 0,
          },
        ],
      },
    },
  };
};

// buildCalendarSchedulesPayload
// 是什么：E2E 日历日程列表响应构建函数。
// 做什么：把前端创建出的工作项转换为 `/api/calendar/:calId/schedules` 所需结构。
// 为什么：本用例要验证“切页重挂载后自动回拉”，因此服务端 mock 必须能返回当前已创建的真实日程快照。
const buildCalendarSchedulesPayload = (
  scheduleRows: Array<{
    scheduleId: string;
    title: string;
    executorUserId: string;
    startTime: number;
    endTime: number;
  }>,
  calId: string
) => {
  return {
    errcode: 0,
    schedule_list: scheduleRows.map((item) => ({
      schedule_id: item.scheduleId,
      cal_id: calId,
      summary: item.title,
      description: '来自日历日程的工作内容',
      location: '',
      start_time: item.startTime,
      end_time: item.endTime,
      attendees: [{ userid: item.executorUserId }],
      organizer: { userid: item.executorUserId },
    })),
  };
};

// gotoAuthedApp
// 是什么：带认证态进入应用的导航函数。
// 做什么：通过 `?token=` 注入 JWT，并等待页面读取当前用户成功。
// 为什么：应用会在首屏消费 query token 并写入 localStorage，这是最贴近真实逻辑的登录方式。
const gotoAuthedApp = async (page: Page, tokenOptions: AuthTokenOptions = {}) => {
  const token = buildAuthToken(tokenOptions);
  const expectedUserName = tokenOptions.name || E2E_USER_NAME;
  const targetUserId = tokenOptions.userid || E2E_USER_ID;
  const targetPlatformRole = (tokenOptions.role || 'MANAGER') === 'MANAGER' ? 'ADMIN' : 'EXECUTOR';

  await upsertPlatformAccess(targetUserId, targetPlatformRole);

  await page.goto(`/?token=${token}`);
  await expect(page.getByText(expectedUserName)).toBeVisible();
};

test.beforeEach(async () => {
  await resetE2eDatabase();
});

test.afterAll(async () => {
  await resetE2eDatabase();
});

test('登录页应展示二维码登录入口', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: '欢迎使用任务管家' })).toBeVisible();
  await expect(page.getByRole('button', { name: '刷新二维码' })).toBeVisible();
  await expect(page.getByRole('button', { name: '企业微信扫码登录' })).toBeVisible();
});

test('任务列表应支持创建、通过与驳回闭环', async ({ page }) => {
  const approveTitle = `PW_E2E_APPROVE_${Date.now()}`;
  const rejectTitle = `PW_E2E_REJECT_${Date.now()}`;
  const rejectReason = 'PW E2E 驳回原因';

  await gotoAuthedApp(page);
  await page.locator('aside').getByRole('button', { name: '任务列表' }).click({ force: true });
  await expect(page.getByText('任务管理')).toBeVisible();

  await page.getByRole('button', { name: '新建任务' }).click({ force: true });
  await page.getByPlaceholder('请输入任务标题').fill(approveTitle);
  await page.getByPlaceholder('请输入任务描述（可选）').fill('Playwright 回归测试通过流');
  await page.getByPlaceholder('或手动输入执行人用户ID（如 zhangsan）').fill(E2E_USER_ID);
  await page.getByRole('button', { name: '确认创建' }).click({ force: true });
  await expect(page.getByText(approveTitle)).toBeVisible();

  const approveCard = page.locator('div').filter({ hasText: approveTitle }).first();
  await approveCard.getByRole('button', { name: '查看详情' }).click({ force: true });
  await expect(page.getByRole('button', { name: '关闭' })).toBeVisible();
  await page.getByRole('button', { name: '关闭' }).click({ force: true });
  await approveCard.getByRole('button', { name: '标记完成' }).click({ force: true });
  await page.locator('div').filter({ hasText: approveTitle }).first().getByRole('button', { name: '通过' }).click({ force: true });

  await page.getByRole('button', { name: '新建任务' }).click({ force: true });
  await page.getByPlaceholder('请输入任务标题').fill(rejectTitle);
  await page.getByPlaceholder('请输入任务描述（可选）').fill('Playwright 回归测试驳回流');
  await page.getByPlaceholder('或手动输入执行人用户ID（如 zhangsan）').fill(E2E_USER_ID);
  await page.getByRole('button', { name: '确认创建' }).click({ force: true });
  await expect(page.getByText(rejectTitle)).toBeVisible();

  const rejectCard = page.locator('div').filter({ hasText: rejectTitle }).first();
  await rejectCard.getByRole('button', { name: '标记完成' }).click({ force: true });
  await page.locator('div').filter({ hasText: rejectTitle }).first().getByRole('button', { name: '驳回' }).click({ force: true });
  await page.getByPlaceholder('输入驳回理由...').fill(rejectReason);
  await page.getByRole('button', { name: '确认驳回' }).click({ force: true });

  await expect(page.getByText(rejectReason)).toBeVisible();

  const approvedTask = await getSql<{ status: string }>(
    `SELECT status FROM tasks WHERE title = ? LIMIT 1`,
    [approveTitle]
  );
  const rejectedTask = await getSql<{ status: string; redo_count: number; reject_reason: string }>(
    `SELECT status, redo_count, reject_reason FROM tasks WHERE title = ? LIMIT 1`,
    [rejectTitle]
  );

  expect(approvedTask?.status).toBe('COMPLETED');
  expect(rejectedTask?.status).toBe('PENDING');
  expect(Number(rejectedTask?.redo_count || 0)).toBe(1);
  expect(rejectedTask?.reject_reason).toBe(rejectReason);
});

test('仪表盘与团队统计应反映任务统计数据', async ({ page }) => {
  await seedTaskRows();
  await gotoAuthedApp(page);

  await expect(page.getByText('任务总数')).toBeVisible();
  await expect(page.locator('body')).toContainText('2');
  await expect(page.locator('body')).toContainText('50.00%');

  await page.locator('aside').getByRole('button', { name: '团队统计' }).click({ force: true });
  await expect(page.getByText('团队统计看板')).toBeVisible();
  await expect(page.locator('body')).toContainText('管理员看板');
  await expect(page.locator('body')).toContainText('成员看板');
  await expect(page.locator('body')).toContainText(E2E_USER_ID);
  await expect(page.locator('body')).toContainText('未设置岗位');
});

test('日历页应支持降级提示、迷你月历收起、桌面分屏及设置页与移动端导航', async ({ page }) => {
  let ensureCalendarCallCount = 0;

  await upsertCalendarMapping();

  await page.route('**/api/users**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        errcode: 0,
        degraded: true,
        source: 'local_cache',
        degrade_reason: 'wecom_user_list_unavailable',
        userlist: [
          { userid: E2E_USER_ID, name: E2E_USER_NAME },
          { userid: 'lisi', name: '李四' },
        ],
      }),
    });
  });

  await page.route('**/api/calendar/*/schedules**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        errcode: 0,
        schedule_list: [],
      }),
    });
  });

  await page.route('**/api/calendar/ensure', async (route) => {
    ensureCalendarCallCount += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ensured: true,
        created: false,
        reason: 'db_map_reused',
        cal_id: 'cal-e2e',
      }),
    });
  });

  await gotoAuthedApp(page);
  await page.locator('aside').getByRole('button', { name: '日历日程' }).click({ force: true });
  await expect(page.getByText('日历与日程管理')).toBeVisible();
  await expect(page.locator('body')).toContainText('我的日历状态');
  await expect(page.locator('body')).toContainText('已就绪');
  await expect(page.locator('body')).toContainText(E2E_USER_NAME);
  await expect(page.locator('body')).toContainText('当前企业微信通讯录暂不可用，已回退到本地通讯录快照');
  await expect(page.locator('body')).not.toContainText('Network Error');
  await expect(page.locator('[data-testid="mini-calendar-body"]')).toBeVisible();
  await expect(page.locator('[data-testid="calendar-left-column"]')).toContainText('操作反馈');
  await expect(page.locator('[data-testid="calendar-operation-panel"]')).toBeVisible();
  await expect(page.locator('[data-testid="calendar-side-panel"]').getByRole('heading', { name: '操作反馈' })).toHaveCount(0);
  await expect.poll(() => ensureCalendarCallCount).toBe(0);

  const calendarMainColumn = page.locator('[data-testid="calendar-main-column"]');
  const calendarSidePanel = page.locator('[data-testid="calendar-side-panel"]');
  const calendarMainBox = await calendarMainColumn.boundingBox();
  const calendarSideBox = await calendarSidePanel.boundingBox();

  expect(calendarMainBox).not.toBeNull();
  expect(calendarSideBox).not.toBeNull();
  expect(Math.abs((calendarMainBox?.y || 0) - (calendarSideBox?.y || 0))).toBeLessThan(120);
  expect((calendarSideBox?.x || 0) - (calendarMainBox?.x || 0)).toBeGreaterThan(400);

  await page.locator('[data-testid="mini-calendar-toggle"]').click();
  await expect(page.locator('[data-testid="mini-calendar-body"]')).toHaveCount(0);
  await page.locator('[data-testid="mini-calendar-toggle"]').click();
  await expect(page.locator('[data-testid="mini-calendar-body"]')).toBeVisible();

  await page.locator('aside').getByRole('button', { name: '系统设置' }).click({ force: true });
  await expect(page.getByRole('heading', { name: '系统设置' })).toBeVisible();
  await page.getByRole('button', { name: 'EN' }).click({ force: true });
  await expect(page.getByRole('heading', { name: 'System Settings' })).toBeVisible();
  await page.getByRole('button', { name: '中文' }).click({ force: true });
  await expect(page.getByRole('heading', { name: '系统设置' })).toBeVisible();
  await page.locator('select').first().selectOption('en');
  await page.getByRole('button', { name: '保存设置' }).click({ force: true });
  await expect(page.getByRole('heading', { name: 'System Settings' })).toBeVisible();
  await expect(page.locator('body')).toContainText('Task List');

  await page.locator('select').first().selectOption('zh');
  await page.getByRole('button', { name: 'Save Settings' }).click({ force: true });
  await expect(page.getByRole('heading', { name: '系统设置' })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByText(E2E_USER_NAME)).toBeVisible();
  await page.locator('header button').first().evaluate((element) => {
    (element as HTMLButtonElement).click();
  });
  await page.waitForTimeout(300);
  await page.locator('aside').getByRole('button', { name: '任务列表' }).evaluate((element) => {
    (element as HTMLButtonElement).click();
  });
  await expect(page.getByText('任务管理')).toBeVisible();
});

test('管理者应自动确保个人日历并隐藏原日历管理面板', async ({ page }) => {
  const managerName = 'Playwright管理者';
  const managerCalendarId = 'cal-manager-e2e';
  let ensureCalendarPayload: Record<string, unknown> | null = null;
  const calendarMappings: Array<{
    user_id: string;
    cal_id: string;
    calendar_summary: string;
    source: string;
    updated_at?: string;
  }> = [];

  await page.route(/\/api\/tasks(?:\?.*)?$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(buildTaskListPayload([])),
    });
  });

  await page.route('**/api/calendar/mappings**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        mappings: calendarMappings,
      }),
    });
  });

  await page.route('**/api/users**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        errcode: 0,
        errmsg: 'ok',
        userlist: [
          { userid: E2E_USER_ID, name: managerName },
          { userid: 'lisi', name: '李四' },
        ],
      }),
    });
  });

  await page.route('**/api/calendar/ensure', async (route) => {
    ensureCalendarPayload = route.request().postDataJSON() as Record<string, unknown>;
    calendarMappings.splice(0, calendarMappings.length, {
      user_id: E2E_USER_ID,
      cal_id: managerCalendarId,
      calendar_summary: `任务管家-${managerName}`,
      source: 'auto_created_login',
      updated_at: '2026-03-11 12:00:00',
    });

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ensured: true,
        created: true,
        reason: 'calendar_created',
        cal_id: managerCalendarId,
      }),
    });
  });

  await page.route('**/api/user/me', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        userid: E2E_USER_ID,
        name: managerName,
        avatar: '',
        role: 'MANAGER',
      }),
    });
  });

  await gotoAuthedApp(page, {
    name: managerName,
    role: 'MANAGER',
  });
  await page.locator('aside').getByRole('button', { name: '日历日程' }).click({ force: true });
  await expect(page.getByText('日历与日程管理')).toBeVisible();

  const sidePanel = page.locator('[data-testid="calendar-side-panel"]');
  const leftColumn = page.locator('[data-testid="calendar-left-column"]');
  const operationPanel = page.locator('[data-testid="calendar-operation-panel"]');

  await expect.poll(() => calendarMappings.length).toBe(1);
  await expect(page.locator('body')).toContainText('未发现个人日历，已自动创建并完成绑定。');
  await expect(page.locator('body')).toContainText(`任务管家-${managerName}`);

  expect(ensureCalendarPayload).not.toBeNull();
  expect((ensureCalendarPayload as { user_id?: string }).user_id).toBe(E2E_USER_ID);
  await expect(page.locator('[data-testid="calendar-maintenance-panel"]')).toHaveCount(0);
  await expect(sidePanel.getByRole('heading', { name: '我的日历维护' })).toHaveCount(0);
  await expect(operationPanel).toBeVisible();
  await expect(leftColumn).toContainText('操作反馈');
  await expect(leftColumn).toContainText('我的日历映射');

  const leftColumnBox = await leftColumn.boundingBox();
  const mainCalendarDayBox = await page.locator('[data-testid="main-calendar-day-2026-03-11"]').boundingBox();
  expect(leftColumnBox).not.toBeNull();
  expect(mainCalendarDayBox).not.toBeNull();
  expect((mainCalendarDayBox?.x || 0) - (leftColumnBox?.x || 0)).toBeGreaterThan(180);
});

test('执行对象在日历页只应看到自己相关的日程，并且只能编辑自己创建的日程', async ({ page }) => {
  await page.route(/\/api\/tasks(?:\?.*)?$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(buildTaskListPayload([])),
    });
  });

  await page.route('**/api/calendar/mappings**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        mappings: [
          {
            user_id: E2E_USER_ID,
            cal_id: 'cal-executor-e2e',
            calendar_summary: '执行对象个人日历',
            source: 'e2e_seed',
          },
        ],
      }),
    });
  });

  await page.route('**/api/users**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        errcode: 0,
        errmsg: 'ok',
        userlist: [
          { userid: E2E_USER_ID, name: E2E_USER_NAME },
          { userid: 'manager-user', name: '管理员甲' },
          { userid: 'wangwu', name: '王五' },
        ],
      }),
    });
  });

  await page.route('**/api/calendar/*/schedules**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        errcode: 0,
        schedule_list: [
          {
            schedule_id: 'sch-owned',
            cal_id: 'cal-executor-e2e',
            summary: '我自己创建的日程',
            description: '执行对象自建',
            start_time: 1773190800,
            end_time: 1773194400,
            organizer: { userid: E2E_USER_ID },
            attendees: [{ userid: E2E_USER_ID }],
          },
          {
            schedule_id: 'sch-assigned',
            cal_id: 'cal-executor-e2e',
            summary: '别人创建但分配给我的日程',
            description: '管理员安排我执行',
            start_time: 1773198000,
            end_time: 1773201600,
            organizer: { userid: 'manager-user' },
            attendees: [{ userid: E2E_USER_ID }],
          },
          {
            schedule_id: 'sch-irrelevant',
            cal_id: 'cal-executor-e2e',
            summary: '与我无关的日程',
            description: '不应展示给执行对象',
            start_time: 1773205200,
            end_time: 1773208800,
            organizer: { userid: 'manager-user' },
            attendees: [{ userid: 'wangwu' }],
          },
        ],
      }),
    });
  });

  await gotoAuthedApp(page, {
    role: 'EXECUTOR',
    name: '执行对象回归用户',
  });
  await expect(page.locator('aside')).not.toContainText('EXECUTOR');
  await expect(page.locator('aside')).not.toContainText('MANAGER');

  await page.locator('aside').getByRole('button', { name: '日历日程' }).click({ force: true });
  await expect(page.getByText('日历与日程管理')).toBeVisible();

  const calendarMainColumn = page.locator('[data-testid="calendar-main-column"]');
  const sidePanel = page.locator('[data-testid="calendar-side-panel"]');

  await expect(calendarMainColumn.getByRole('button', { name: '我自己创建的日程', exact: true })).toBeVisible();
  await expect(
    calendarMainColumn.getByRole('button', { name: '别人创建但分配给我的日程', exact: true })
  ).toBeVisible();
  await expect(page.locator('body')).not.toContainText('与我无关的日程');

  await calendarMainColumn.getByRole('button', { name: '别人创建但分配给我的日程', exact: true }).click({ force: true });
  await expect(sidePanel.getByRole('heading', { name: '编辑：别人创建但分配给我的日程' })).toBeVisible();
  await expect(sidePanel.getByText('当前日程由其他人创建，你可以查看执行安排，但不能编辑或删除。')).toBeVisible();
  await expect(sidePanel.getByRole('button', { name: '更新当前日程' })).toBeDisabled();
  await expect(sidePanel.getByRole('button', { name: '取消日程' })).toBeDisabled();
  await expect(sidePanel.getByRole('button', { name: '添加所选参与人' })).toBeDisabled();
  await expect(sidePanel.getByRole('button', { name: '移除所选参与人' })).toBeDisabled();

  await calendarMainColumn.getByRole('button', { name: '我自己创建的日程', exact: true }).click({ force: true });
  await expect(sidePanel.getByRole('heading', { name: '编辑：我自己创建的日程' })).toBeVisible();
  await expect(sidePanel.getByRole('button', { name: '更新当前日程' })).toBeEnabled();
  await expect(sidePanel.getByRole('button', { name: '取消日程' })).toBeEnabled();
});

test('创建日程时结束时间必须严格晚于开始时间', async ({ page }) => {
  let createScheduleCallCount = 0;

  await page.route(/\/api\/tasks(?:\?.*)?$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(buildTaskListPayload([])),
    });
  });

  await page.route('**/api/calendar/mappings**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        mappings: [
          {
            user_id: E2E_USER_ID,
            cal_id: 'cal-time-check',
            calendar_summary: '时间校验日历',
            source: 'e2e_seed',
          },
        ],
      }),
    });
  });

  await page.route('**/api/users**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        errcode: 0,
        errmsg: 'ok',
        userlist: [{ userid: E2E_USER_ID, name: E2E_USER_NAME }],
      }),
    });
  });

  await page.route('**/api/calendar/*/schedules**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        errcode: 0,
        schedule_list: [],
      }),
    });
  });

  await page.route('**/api/schedule/create', async (route) => {
    createScheduleCallCount += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        errcode: 0,
        errmsg: 'ok',
        schedule_id: 'sch-time-check',
      }),
    });
  });

  await gotoAuthedApp(page);
  await page.locator('aside').getByRole('button', { name: '日历日程' }).click({ force: true });
  await expect(page.getByText('日历与日程管理')).toBeVisible();

  const sidePanel = page.locator('[data-testid="calendar-side-panel"]');
  const timeInputs = sidePanel.locator('input[type="datetime-local"]');
  const createButton = sidePanel.getByRole('button', { name: /为 .* 创建日程/ });

  await timeInputs.nth(0).fill('2026-03-23T10:00');
  await timeInputs.nth(1).fill('2026-03-23T09:00');

  await expect(sidePanel.getByText('结束时间必须晚于开始时间，且不能与开始时间相同。')).toBeVisible();
  await expect(createButton).toBeDisabled();
  await expect.poll(() => createScheduleCallCount).toBe(0);
});

test('日历工作项应允许不同负责人同时间重叠，并立即联动任务、仪表盘与团队统计', async ({ page }) => {
  const testCalendarId = 'cal-e2e';
  const userNameMap: Record<string, string> = {
    [E2E_USER_ID]: E2E_USER_NAME,
    lisi: '李四',
    wangwu: '王五',
  };
  const createdScheduleTasks: Array<{
    scheduleId: string;
    title: string;
    executorUserId: string;
    executorName: string;
    startTime: number;
    endTime: number;
  }> = [];

  await page.route(/\/api\/tasks(?:\/team-stats)?(?:\?.*)?$/, async (route) => {
    const requestUrl = route.request().url();
    if (requestUrl.includes('/team-stats')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(buildTeamStatsPayload(createdScheduleTasks)),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(buildTaskListPayload(createdScheduleTasks)),
    });
  });

  await page.route('**/api/calendar/mappings**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        mappings: [
          {
            user_id: E2E_USER_ID,
            cal_id: testCalendarId,
            calendar_summary: 'Playwright E2E Calendar',
            source: 'e2e_seed',
          },
        ],
      }),
    });
  });

  await page.route('**/api/users**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        errcode: 0,
        errmsg: 'ok',
        userlist: [
          { userid: E2E_USER_ID, name: E2E_USER_NAME },
          { userid: 'lisi', name: '李四' },
          { userid: 'wangwu', name: '王五' },
        ],
      }),
    });
  });

  await page.route('**/api/calendar/*/schedules**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(buildCalendarSchedulesPayload(createdScheduleTasks, testCalendarId)),
    });
  });

  await page.route('**/api/schedule/create', async (route) => {
    const payload = route.request().postDataJSON() as {
      schedule?: {
        summary?: string;
        attendees?: Array<{ userid?: string }>;
        start_time?: number;
        end_time?: number;
      };
    };
    const scheduleId = `sch-e2e-${createdScheduleTasks.length + 1}`;
    const attendees = Array.isArray(payload.schedule?.attendees) ? payload.schedule?.attendees : [];
    const executorUserId = String(attendees[0]?.userid || E2E_USER_ID);

    createdScheduleTasks.push({
      scheduleId,
      title: String(payload.schedule?.summary || scheduleId),
      executorUserId,
      executorName: userNameMap[executorUserId] || executorUserId,
      startTime: Number(payload.schedule?.start_time || 0),
      endTime: Number(payload.schedule?.end_time || 0),
    });

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        errcode: 0,
        errmsg: 'ok',
        schedule_id: scheduleId,
      }),
    });
  });

  await gotoAuthedApp(page);
  await page.locator('aside').getByRole('button', { name: '日历日程' }).click({ force: true });
  await expect(page.getByText('日历与日程管理')).toBeVisible();

  const calendarMainColumn = page.locator('[data-testid="calendar-main-column"]');
  const sidePanel = page.locator('[data-testid="calendar-side-panel"]');
  const summaryInput = sidePanel.getByPlaceholder('例如：客户回访、周会、里程碑检查');
  const reminderTextarea = sidePanel.locator('textarea').nth(1);
  const createButton = sidePanel.getByRole('button', { name: /为 .* 创建日程/ });
  // getCalendarDayEventChip
  // 是什么：月历主面板事件胶囊定位器。
  // 做什么：精确匹配月历格子里展示的事件标题按钮，避免与编辑区或详情区重复文案混淆。
  // 为什么：同一标题会同时出现在月历、当天事件卡片和侧栏编辑标题里，宽泛文本断言会触发 Playwright 严格模式冲突。
  const getCalendarDayEventChip = (summary: string) =>
    calendarMainColumn.getByRole('button', { name: summary, exact: true });
  // getSelectedDayEventCard
  // 是什么：选中日期事件卡片定位器。
  // 做什么：匹配“选中日期事件”区域内包含参与人数文案的详情卡片。
  // 为什么：需要明确验证当天事件列表已经展示，而不是误命中其他同名文本节点。
  const getSelectedDayEventCard = (summary: string) =>
    calendarMainColumn.getByRole('button', { name: new RegExp(`${summary}.*参与人数：`, 's') });

  await summaryInput.fill('重叠工作项-A');
  await reminderTextarea.scrollIntoViewIfNeeded();
  await reminderTextarea.fill('@李四(lisi)');
  await expect(summaryInput).toHaveValue('重叠工作项-A');
  await expect(reminderTextarea).toHaveValue('@李四(lisi)');
  await Promise.all([
    page.waitForResponse((response) => response.url().includes('/api/schedule/create') && response.status() === 200),
    createButton.click({ force: true }),
  ]);
  await expect.poll(() => createdScheduleTasks.length).toBe(1);
  await expect(getCalendarDayEventChip('重叠工作项-A')).toBeVisible();
  await expect(getSelectedDayEventCard('重叠工作项-A')).toBeVisible();
  await expect(sidePanel.getByRole('heading', { name: '编辑：重叠工作项-A' })).toBeVisible();

  await page.getByRole('button', { name: '今天' }).click();
  await summaryInput.fill('重叠工作项-B');
  await reminderTextarea.scrollIntoViewIfNeeded();
  await reminderTextarea.fill('@王五(wangwu)');
  await Promise.all([
    page.waitForResponse((response) => response.url().includes('/api/schedule/create') && response.status() === 200),
    createButton.click({ force: true }),
  ]);
  await expect.poll(() => createdScheduleTasks.length).toBe(2);
  await expect(getCalendarDayEventChip('重叠工作项-A')).toBeVisible();
  await expect(getCalendarDayEventChip('重叠工作项-B')).toBeVisible();
  await expect(getSelectedDayEventCard('重叠工作项-A')).toBeVisible();
  await expect(getSelectedDayEventCard('重叠工作项-B')).toBeVisible();
  await expect(sidePanel.getByRole('heading', { name: '编辑：重叠工作项-B' })).toBeVisible();
  await expect(page.locator('body')).not.toContainText('时间冲突');

  await page.locator('aside').getByRole('button', { name: '任务列表' }).click({ force: true });
  await expect(page.locator('main').getByText('重叠工作项-A', { exact: true })).toBeVisible();
  await expect(page.locator('main').getByText('重叠工作项-B', { exact: true })).toBeVisible();

  await page.locator('aside').getByRole('button', { name: '仪表盘' }).click({ force: true });
  await expect(page.getByText('任务总数')).toBeVisible();
  await expect(page.locator('body')).toContainText('重叠工作项-A');
  await expect(page.locator('body')).toContainText('重叠工作项-B');

  await page.locator('aside').getByRole('button', { name: '团队统计' }).click({ force: true });
  await expect(page.getByText('团队统计看板')).toBeVisible();
  await expect(page.locator('body')).toContainText('李四');
  await expect(page.locator('body')).toContainText('王五');

  await page.locator('aside').getByRole('button', { name: '日历日程' }).click({ force: true });
  await expect(page.getByText('日历与日程管理')).toBeVisible();
  await expect(getCalendarDayEventChip('重叠工作项-A')).toBeVisible();
  await expect(getCalendarDayEventChip('重叠工作项-B')).toBeVisible();
  await expect(getSelectedDayEventCard('重叠工作项-A')).toBeVisible();
  await expect(getSelectedDayEventCard('重叠工作项-B')).toBeVisible();
});

test('跨天日程应在开始日与结束日都展示，并继续以结束时间作为任务截止时间', async ({ page }) => {
  const createdScheduleTasks: Array<{
    scheduleId: string;
    title: string;
    executorUserId: string;
    executorName: string;
    startTime: number;
    endTime: number;
  }> = [];

  await page.route(/\/api\/tasks(?:\?.*)?$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(buildTaskListPayload(createdScheduleTasks)),
    });
  });

  await page.route('**/api/calendar/mappings**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        mappings: [
          {
            user_id: E2E_USER_ID,
            cal_id: 'cal-cross-day',
            calendar_summary: 'Playwright Cross Day Calendar',
            source: 'e2e_seed',
          },
        ],
      }),
    });
  });

  await page.route('**/api/users**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        errcode: 0,
        errmsg: 'ok',
        userlist: [{ userid: E2E_USER_ID, name: E2E_USER_NAME }],
      }),
    });
  });

  await page.route('**/api/calendar/*/schedules**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        errcode: 0,
        schedule_list: [],
      }),
    });
  });

  await page.route('**/api/schedule/create', async (route) => {
    const payload = route.request().postDataJSON() as {
      schedule?: {
        summary?: string;
        start_time?: number;
        end_time?: number;
      };
    };

    createdScheduleTasks.push({
      scheduleId: 'sch-cross-day-1',
      title: String(payload.schedule?.summary || 'sch-cross-day-1'),
      executorUserId: E2E_USER_ID,
      executorName: E2E_USER_NAME,
      startTime: Number(payload.schedule?.start_time || 0),
      endTime: Number(payload.schedule?.end_time || 0),
    });

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        errcode: 0,
        errmsg: 'ok',
        schedule_id: 'sch-cross-day-1',
      }),
    });
  });

  await gotoAuthedApp(page);
  await page.locator('aside').getByRole('button', { name: '日历日程' }).click({ force: true });
  await expect(page.getByText('日历与日程管理')).toBeVisible();

  const calendarMainColumn = page.locator('[data-testid="calendar-main-column"]');
  const sidePanel = page.locator('[data-testid="calendar-side-panel"]');
  const summaryInput = sidePanel.getByPlaceholder('例如：客户回访、周会、里程碑检查');
  const timeInputs = sidePanel.locator('input[type="datetime-local"]');

  await summaryInput.fill('跨天工作项');
  await timeInputs.nth(0).fill('2026-03-11T23:00');
  await timeInputs.nth(1).fill('2026-03-12T09:00');
  await sidePanel.getByRole('button', { name: /为 .* 创建日程/ }).click({ force: true });

  await expect.poll(() => createdScheduleTasks.length).toBe(1);
  await expect(createdScheduleTasks[0].endTime).toBeGreaterThan(createdScheduleTasks[0].startTime);
  await expect(
    calendarMainColumn.getByRole('button', { name: /跨天工作项.*参与人数：/s })
  ).toBeVisible();

  await expect(calendarMainColumn.locator('[data-testid="main-calendar-day-2026-03-12"]')).toBeVisible();
  await calendarMainColumn.locator('[data-testid="main-calendar-day-2026-03-12"]').click({ force: true });
  await expect(page.locator('body')).toContainText('2026-03-12');
  await expect(
    calendarMainColumn.getByRole('button', { name: /跨天工作项.*参与人数：/s })
  ).toBeVisible();

  await page.locator('aside').getByRole('button', { name: '任务列表' }).click({ force: true });
  await expect(page.locator('main').getByText('跨天工作项', { exact: true })).toBeVisible();
});
