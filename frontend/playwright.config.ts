import path from 'node:path';
import { defineConfig } from '@playwright/test';

// frontendDir / backendDir
// 是什么：Playwright 烟雾回归所需的前后端目录路径。
// 做什么：统一生成构建前端与启动后端服务时使用的绝对目录。
// 为什么：CI 与本地执行目录可能不同，路径写死会让 smoke test 在干净环境直接失效。
const frontendDir = process.cwd();
const backendDir = path.resolve(frontendDir, '../backend');
const shellPath = process.env.SHELL || '/bin/zsh';
// webServerCommand
// 是什么：Playwright 内置 Web Server 启动命令。
// 做什么：先构建前端，再加载后端环境变量并以隔离的 E2E 数据库启动服务。
// 为什么：烟雾回归必须验证真实打包产物，同时避免污染开发或联调数据库。
const webServerCommand = `cd "${frontendDir}" && npm run build && cd "${backendDir}" && set -a && source .env && set +a && PORT=8081 DEFAULT_CAL_ID= USER_CALENDAR_MAP= AUTO_CREATE_USER_CALENDAR_ON_LOGIN=false TASK_BOT_DB_PATH=database/tasks.e2e.db npm start`;

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  retries: 0,
  reporter: [
    ['list'],
    ['html', { outputFolder: '../output/playwright/report', open: 'never' }],
  ],
  outputDir: '../output/playwright/test-results',
  use: {
    baseURL: 'http://127.0.0.1:8081',
    browserName: 'chromium',
    headless: true,
    viewport: {
      width: 1440,
      height: 900,
    },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  webServer: {
    command: `${shellPath} -lc '${webServerCommand.replace(/'/g, `'\\''`)}'`,
    url: 'http://127.0.0.1:8081',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
