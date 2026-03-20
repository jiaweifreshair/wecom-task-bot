const fs = require('fs');
const path = require('path');

// testDbPath
// 是什么：后端自动化测试专用数据库路径。
// 做什么：统一指定 `database/tasks.test.db` 作为测试库，并在每次测试启动前删除旧库。
// 为什么：项目单测会写入 SQLite，若复用正式库会污染本地联调与真实映射数据。
const testDbPath = path.resolve(__dirname, '../database/tasks.test.db');

process.env.NODE_ENV = 'test';
process.env.TASK_BOT_DB_PATH = testDbPath;
fs.mkdirSync(path.dirname(testDbPath), { recursive: true });

try {
  fs.unlinkSync(testDbPath);
} catch (error) {
  if (error && error.code !== 'ENOENT') {
    throw error;
  }
}
