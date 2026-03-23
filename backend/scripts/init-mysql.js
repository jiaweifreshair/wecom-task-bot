#!/usr/bin/env node
// 是什么：MySQL 初始化脚本。
// 做什么：强制使用 MySQL 客户端触发建库、建表与迁移初始化，并输出目标连接信息。
// 为什么：数据库切换后需要一个显式入口，便于在部署前或本地直接完成表结构准备。
require('dotenv').config();

process.env.TASK_BOT_DB_CLIENT = 'mysql';

const db = require('../src/models/db');

db.readyPromise
  .then(() => {
    const { host, port, database } = db.mysqlConfig;
    process.stdout.write(`MySQL 初始化完成: ${host}:${port}/${database}\n`);
    process.exit(0);
  })
  .catch((error) => {
    process.stderr.write(`MySQL 初始化失败: ${error.message}\n`);
    process.exit(1);
  });
