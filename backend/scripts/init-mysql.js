#!/usr/bin/env node
// 是什么：MySQL 初始化脚本。
// 做什么：按编号顺序读取 backend/sql/*.sql 并逐条执行，完成建库、建表与迁移初始化。
// 为什么：数据库切换后需要一个显式入口，便于在部署前或本地直接完成表结构准备。
//         改为读取 .sql 文件而非调用 db.js，使 DBA 可直接审阅和手动执行 SQL 文件。
const fs = require('fs');
const path = require('path');

// sortSqlFiles
// 是什么：SQL 文件名排序函数。
// 做什么：按文件名数字前缀升序排列。
// 为什么：确保建库 → 建表 → 迁移的执行顺序正确。
function sortSqlFiles(fileNames) {
  return [...fileNames].sort((a, b) => {
    const numA = parseInt(a.match(/^(\d+)/)?.[1] || '0', 10);
    const numB = parseInt(b.match(/^(\d+)/)?.[1] || '0', 10);
    return numA - numB;
  });
}

// splitBySemicolon
// 是什么：按分号拆分 SQL 语句的辅助函数。
// 做什么：将多条 SQL 语句按分号分割，过滤空语句和纯注释行。
// 为什么：mysql2 的 query 方法默认一次只执行一条语句，需要逐条执行。
function splitBySemicolon(sql) {
  return sql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => {
      if (!s) return false;
      return !s.split('\n').every((line) => {
        const l = line.trim();
        return l === '' || l.startsWith('--');
      });
    });
}

// preprocessDelimiterSyntax
// 是什么：DELIMITER 语法预处理函数。
// 做什么：将 MySQL 客户端专用的 DELIMITER 语法转换为 mysql2 驱动可执行的语句块。
// 为什么：mysql2 驱动不支持 DELIMITER 命令，需要手动拆分存储过程定义中的语句。
function preprocessDelimiterSyntax(sqlContent) {
  const statements = [];
  let currentDelimiter = ';';
  let buffer = '';

  const lines = sqlContent.split('\n');

  for (const line of lines) {
    const trimmedLine = line.trim();

    // Check for DELIMITER directive
    const delimiterMatch = trimmedLine.match(/^DELIMITER\s+(.+)$/i);
    if (delimiterMatch) {
      // Flush any buffered content before switching delimiter
      const flushed = buffer.trim();
      if (flushed) {
        if (currentDelimiter === ';') {
          statements.push(...splitBySemicolon(flushed));
        } else {
          statements.push(flushed);
        }
      }
      buffer = '';
      currentDelimiter = delimiterMatch[1].trim();
      continue;
    }

    buffer += line + '\n';

    // For custom delimiters, check if buffer ends with the delimiter
    if (currentDelimiter !== ';') {
      const trimmedBuffer = buffer.trimEnd();
      if (trimmedBuffer.endsWith(currentDelimiter)) {
        const stmt = trimmedBuffer.slice(0, -currentDelimiter.length).trim();
        if (stmt) {
          statements.push(stmt);
        }
        buffer = '';
      }
    }
  }

  // Flush remaining buffer
  const remaining = buffer.trim();
  if (remaining) {
    if (currentDelimiter === ';') {
      statements.push(...splitBySemicolon(remaining));
    } else {
      statements.push(remaining);
    }
  }

  return statements.filter((s) => {
    const trimmed = s.trim();
    if (!trimmed) return false;
    // Filter out pure comment blocks
    return !trimmed.split('\n').every((line) => {
      const l = line.trim();
      return l === '' || l.startsWith('--');
    });
  });
}


// executeSqlFiles
// 是什么：SQL 文件批量执行函数。
// 做什么：按文件名编号顺序读取指定目录下的 .sql 文件，预处理 DELIMITER 语法后逐条执行。
// 为什么：提供自动化入口，同时保留 .sql 文件可被 DBA 手动执行的能力。
async function executeSqlFiles(pool, sqlDir) {
  const allFiles = fs.readdirSync(sqlDir);
  const sqlFiles = sortSqlFiles(allFiles.filter((f) => f.endsWith('.sql')));

  for (const file of sqlFiles) {
    const filePath = path.join(sqlDir, file);
    const content = fs.readFileSync(filePath, 'utf8');
    const statements = preprocessDelimiterSyntax(content);

    for (const stmt of statements) {
      await pool.query(stmt);
    }
  }
}

// main
// 是什么：脚本主入口。
// 做什么：创建 MySQL 连接池，执行全部 SQL 文件，输出结果并退出。
// 为什么：作为 npm run db:init:mysql 的执行入口。
async function main() {
  require('dotenv').config();
  const mysql = require('mysql2/promise');
  const { buildMysqlConnectionConfig } = require('../src/models/db-dialect');

  const config = buildMysqlConnectionConfig();
  // Connect without database first so CREATE DATABASE in 001 can succeed
  const poolConfig = { ...config, multipleStatements: true };
  delete poolConfig.database;

  const pool = mysql.createPool(poolConfig);

  try {
    const sqlDir = path.resolve(__dirname, '../sql');
    await executeSqlFiles(pool, sqlDir);

    const { host, port, database } = config;
    process.stdout.write(`MySQL 初始化完成: ${host}:${port}/${database}\n`);
    await pool.end();
    process.exit(0);
  } catch (error) {
    process.stderr.write(`MySQL 初始化失败: ${error.message}\n`);
    try { await pool.end(); } catch (_) { /* ignore cleanup error */ }
    process.exit(1);
  }
}

// Only run main when executed directly (not when required for testing)
if (require.main === module) {
  main();
}

module.exports = { executeSqlFiles, sortSqlFiles, preprocessDelimiterSyntax };
