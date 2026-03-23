const path = require('path');
const fs = require('fs');
const { logWithTrace, createTraceId } = require('../utils/logger');
const {
  buildMysqlConnectionConfig,
  buildSchemaStatements,
  escapeMysqlIdentifier,
  resolveDbClientName,
  resolveSqliteDbPath,
  transformSqlForClient,
} = require('./db-dialect');

const dbClientName = resolveDbClientName(process.env);
const sqliteDbPath = dbClientName === 'sqlite' ? resolveSqliteDbPath(process.env) : '';
const mysqlConfig = dbClientName === 'mysql' ? buildMysqlConnectionConfig(process.env) : null;
const dbPath = dbClientName === 'sqlite' ? sqliteDbPath : `${mysqlConfig.host}:${mysqlConfig.port}/${mysqlConfig.database}`;

let sqliteDriver = null;
let sqliteDb = null;
let mysqlLibrary = null;
let mysqlPool = null;

// TASKS_TABLE_COLUMN_MIGRATIONS
// 是什么：tasks 表字段迁移配置。
// 做什么：声明需补齐的字段与对应 ALTER SQL，用于旧库平滑升级。
// 为什么：项目已上线后直接改建表语句不会影响存量数据库，必须通过迁移补字段。
const TASKS_TABLE_COLUMN_MIGRATIONS = [
  {
    columnName: 'redo_count',
    alterSqlByClient: {
      sqlite: `ALTER TABLE tasks ADD COLUMN redo_count INTEGER DEFAULT 0`,
      mysql: `ALTER TABLE tasks ADD COLUMN redo_count INT DEFAULT 0`,
    },
  },
  {
    columnName: 'last_reminder_at',
    alterSqlByClient: {
      sqlite: `ALTER TABLE tasks ADD COLUMN last_reminder_at DATETIME`,
      mysql: `ALTER TABLE tasks ADD COLUMN last_reminder_at DATETIME`,
    },
  },
  {
    columnName: 'last_reminder_kind',
    alterSqlByClient: {
      sqlite: `ALTER TABLE tasks ADD COLUMN last_reminder_kind TEXT`,
      mysql: `ALTER TABLE tasks ADD COLUMN last_reminder_kind VARCHAR(64)`,
    },
  },
  {
    columnName: 'completed_by_userid',
    alterSqlByClient: {
      sqlite: `ALTER TABLE tasks ADD COLUMN completed_by_userid TEXT`,
      mysql: `ALTER TABLE tasks ADD COLUMN completed_by_userid VARCHAR(191)`,
    },
  },
  {
    columnName: 'verified_by_userid',
    alterSqlByClient: {
      sqlite: `ALTER TABLE tasks ADD COLUMN verified_by_userid TEXT`,
      mysql: `ALTER TABLE tasks ADD COLUMN verified_by_userid VARCHAR(191)`,
    },
  },
  {
    columnName: 'updated_at',
    alterSqlByClient: {
      sqlite: `ALTER TABLE tasks ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP`,
      mysql: `ALTER TABLE tasks ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP`,
    },
  },
  {
    columnName: 'owner_cal_id',
    alterSqlByClient: {
      sqlite: `ALTER TABLE tasks ADD COLUMN owner_cal_id TEXT`,
      mysql: `ALTER TABLE tasks ADD COLUMN owner_cal_id VARCHAR(191)`,
    },
  },
  {
    columnName: 'owner_userid',
    alterSqlByClient: {
      sqlite: `ALTER TABLE tasks ADD COLUMN owner_userid TEXT`,
      mysql: `ALTER TABLE tasks ADD COLUMN owner_userid VARCHAR(191)`,
    },
  },
];

// PLATFORM_USER_ACCESS_COLUMN_MIGRATIONS
// 是什么：平台权限表字段迁移配置。
// 做什么：声明平台权限表在历史数据库中需要补齐的列及对应 ALTER SQL。
// 为什么：平台菜单权限已从固定角色映射升级为可配置存储，旧库必须平滑补字段。
const PLATFORM_USER_ACCESS_COLUMN_MIGRATIONS = [
  {
    columnName: 'menu_permissions_json',
    alterSqlByClient: {
      sqlite: `ALTER TABLE platform_user_access ADD COLUMN menu_permissions_json TEXT DEFAULT '[]'`,
      mysql: `ALTER TABLE platform_user_access ADD COLUMN menu_permissions_json VARCHAR(2048) DEFAULT '[]'`,
    },
  },
];

// normalizeDbError
// 是什么：数据库错误标准化函数。
// 做什么：把各种驱动抛出的异常统一转成 Error 实例，缺失时补上可读消息。
// 为什么：适配层同时承接 sqlite3 与 mysql2，错误对象结构不同，统一后更便于日志和回调透传。
const normalizeDbError = (error) => {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error || 'unknown database error'));
};

// toStatementContext
// 是什么：数据库写操作结果上下文构建函数。
// 做什么：统一输出与 sqlite3 `this.changes/this.lastID` 兼容的结果结构。
// 为什么：大量历史业务代码都依赖这个回调上下文，适配层必须保持同一调用契约。
const toStatementContext = (result = {}) => {
  return {
    changes: Number(result && result.changes) || 0,
    lastID: Number(result && result.lastID) || 0,
  };
};

// invokeCallback
// 是什么：数据库回调安全调用函数。
// 做什么：在存在回调时按 sqlite3 习惯传入错误、结果并绑定上下文。
// 为什么：业务层和测试已大量使用 sqlite3 风格 API，兼容回调语义可以避免上层重写。
const invokeCallback = (callback, context, error, payload) => {
  if (typeof callback !== 'function') {
    return;
  }

  callback.call(context || {}, error || null, payload);
};

// ensureSqliteDriver
// 是什么：SQLite 驱动延迟加载函数。
// 做什么：仅在客户端选择 sqlite 时才 require 原生模块。
// 为什么：切到 MySQL 后不应让运行时再强依赖 sqlite3 原生二进制。
const ensureSqliteDriver = () => {
  if (!sqliteDriver) {
    sqliteDriver = require('sqlite3').verbose();
  }

  return sqliteDriver;
};

// ensureMysqlLibrary
// 是什么：MySQL 驱动延迟加载函数。
// 做什么：仅在客户端选择 mysql 时才加载 `mysql2/promise`。
// 为什么：测试链路仍使用 sqlite，不应因为未安装 mysql2 就影响现有自动化。
const ensureMysqlLibrary = () => {
  if (!mysqlLibrary) {
    mysqlLibrary = require('mysql2/promise');
  }

  return mysqlLibrary;
};

// rawRunSqlite
// 是什么：SQLite 原始写操作执行函数。
// 做什么：直接对 sqlite3 实例执行 SQL，并以 Promise 返回 `changes/lastID`。
// 为什么：建表与迁移初始化需要一个不依赖外层回调包装的底层执行能力。
const rawRunSqlite = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    sqliteDb.run(sql, params, function onRun(error) {
      if (error) {
        reject(normalizeDbError(error));
        return;
      }

      resolve({
        changes: this.changes || 0,
        lastID: this.lastID || 0,
      });
    });
  });
};

// rawAllSqlite
// 是什么：SQLite 原始多行查询执行函数。
// 做什么：直接执行查询并返回完整行数组。
// 为什么：表结构探测和业务查询都需要底层 Promise 风格接口。
const rawAllSqlite = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    sqliteDb.all(sql, params, (error, rows) => {
      if (error) {
        reject(normalizeDbError(error));
        return;
      }

      resolve(rows || []);
    });
  });
};

// rawGetSqlite
// 是什么：SQLite 原始单行查询执行函数。
// 做什么：直接执行查询并返回首行或 `null`。
// 为什么：兼容 `db.get` 需要稳定的一行读取原语。
const rawGetSqlite = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    sqliteDb.get(sql, params, (error, row) => {
      if (error) {
        reject(normalizeDbError(error));
        return;
      }

      resolve(row || null);
    });
  });
};

// rawRunMysql
// 是什么：MySQL 原始写操作执行函数。
// 做什么：执行兼容转换后的 SQL，并返回受影响行数与插入 ID。
// 为什么：需要向上兼容 sqlite3 的 `run` 结果结构。
const rawRunMysql = async (sql, params = []) => {
  const transformedSql = transformSqlForClient(sql, 'mysql');
  const [result] = await mysqlPool.execute(transformedSql, params);

  return {
    changes: Number(result && result.affectedRows) || 0,
    lastID: Number(result && result.insertId) || 0,
  };
};

// rawAllMysql
// 是什么：MySQL 原始多行查询执行函数。
// 做什么：执行兼容转换后的 SQL 并返回行数组。
// 为什么：适配层要对外维持 `all` 语义，不暴露 mysql2 的底层返回结构。
const rawAllMysql = async (sql, params = []) => {
  const transformedSql = transformSqlForClient(sql, 'mysql');
  const [rows] = await mysqlPool.execute(transformedSql, params);
  return Array.isArray(rows) ? rows : [];
};

// rawGetMysql
// 是什么：MySQL 原始单行查询执行函数。
// 做什么：执行兼容转换后的 SQL 并返回首行或 `null`。
// 为什么：业务层大量用 `get` 读取单行，适配层应提供统一结果形态。
const rawGetMysql = async (sql, params = []) => {
  const rows = await rawAllMysql(sql, params);
  return rows[0] || null;
};

// rawRun / rawAll / rawGet
// 是什么：按客户端分发的底层数据库执行函数。
// 做什么：根据当前客户端将请求转发给 SQLite 或 MySQL 实现。
// 为什么：把方言分发收敛在一处，避免上层每次判断数据库类型。
const rawRun = (sql, params = []) => {
  return dbClientName === 'mysql' ? rawRunMysql(sql, params) : rawRunSqlite(sql, params);
};

const rawAll = (sql, params = []) => {
  return dbClientName === 'mysql' ? rawAllMysql(sql, params) : rawAllSqlite(sql, params);
};

const rawGet = (sql, params = []) => {
  return dbClientName === 'mysql' ? rawGetMysql(sql, params) : rawGetSqlite(sql, params);
};

// listTableColumns
// 是什么：表字段元数据查询函数。
// 做什么：根据数据库类型读取指定表的列名列表。
// 为什么：历史库平滑升级仍依赖“缺列则补”的自愈迁移机制。
const listTableColumns = async (tableName) => {
  if (dbClientName === 'mysql') {
    const rows = await mysqlPool.execute(
      `SELECT COLUMN_NAME AS name
         FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = ?
          AND TABLE_NAME = ?`,
      [mysqlConfig.database, tableName]
    );

    return Array.isArray(rows[0]) ? rows[0] : [];
  }

  return rawAllSqlite(`PRAGMA table_info(${tableName})`);
};

// ensureTableColumns
// 是什么：表字段自愈迁移函数。
// 做什么：检查缺失字段并按当前数据库类型执行对应 `ALTER TABLE`。
// 为什么：无论旧 SQLite 还是新 MySQL，都要保证新增字段在历史表结构中可用。
const ensureTableColumns = async (tableName, migrations = []) => {
  const traceId = createTraceId();

  try {
    const columns = await listTableColumns(tableName);
    const existingColumns = new Set(columns.map((item) => item && item.name).filter(Boolean));

    for (const migration of migrations) {
      if (existingColumns.has(migration.columnName)) {
        continue;
      }

      const alterSql = migration.alterSqlByClient[dbClientName];
      await rawRun(alterSql);

      logWithTrace(traceId, 'db', 'schema.migration.apply_success', {
        table: tableName,
        columnName: migration.columnName,
        clientName: dbClientName,
      });
    }
  } catch (error) {
    logWithTrace(traceId, 'db', 'schema.migration.inspect_error', {
      table: tableName,
      clientName: dbClientName,
      message: error.message,
    });
  }
};

// initializeSqliteConnection
// 是什么：SQLite 连接初始化函数。
// 做什么：创建数据库文件目录并打开 sqlite3 连接。
// 为什么：测试和本地回归仍依赖 SQLite，初始化阶段需要保留原有能力。
const initializeSqliteConnection = async () => {
  const traceId = createTraceId();
  fs.mkdirSync(path.dirname(sqliteDbPath), { recursive: true });
  const driver = ensureSqliteDriver();

  sqliteDb = await new Promise((resolve, reject) => {
    const instance = new driver.Database(sqliteDbPath, (error) => {
      if (error) {
        reject(normalizeDbError(error));
        return;
      }

      resolve(instance);
    });
  });

  logWithTrace(traceId, 'db', 'connect.success', {
    clientName: 'sqlite',
    dbPath: sqliteDbPath,
  });
};

// initializeMysqlConnection
// 是什么：MySQL 连接初始化函数。
// 做什么：先确保目标数据库存在，再建立连接池并验证联通性。
// 为什么：用户要求切到 MySQL，初始化阶段就应该完成“建库 + 建表”的闭环，而不是依赖外部手工准备。
const initializeMysqlConnection = async () => {
  const traceId = createTraceId();
  const mysql = ensureMysqlLibrary();
  const bootstrapConnection = await mysql.createConnection({
    host: mysqlConfig.host,
    port: mysqlConfig.port,
    user: mysqlConfig.user,
    password: mysqlConfig.password,
    charset: mysqlConfig.charset,
    timezone: mysqlConfig.timezone,
    dateStrings: mysqlConfig.dateStrings,
  });

  await bootstrapConnection.query(
    `CREATE DATABASE IF NOT EXISTS ${escapeMysqlIdentifier(mysqlConfig.database)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  );
  await bootstrapConnection.end();

  mysqlPool = mysql.createPool(mysqlConfig);
  await mysqlPool.query('SELECT 1');

  logWithTrace(traceId, 'db', 'connect.success', {
    clientName: 'mysql',
    host: mysqlConfig.host,
    port: mysqlConfig.port,
    database: mysqlConfig.database,
  });
};

// initializeSchema
// 是什么：数据库表结构初始化函数。
// 做什么：顺序执行所有 `CREATE TABLE` 并补齐历史迁移列。
// 为什么：切库后需要在应用启动时自动具备完整表结构，避免首次请求才因缺表/缺列失败。
const initializeSchema = async () => {
  const traceId = createTraceId();
  const schemaStatements = buildSchemaStatements(dbClientName);

  for (const statement of schemaStatements) {
    await rawRun(statement.sql);
    logWithTrace(traceId, 'db', 'schema.init.success', {
      table: statement.tableName,
      clientName: dbClientName,
    });
  }

  await ensureTableColumns('tasks', TASKS_TABLE_COLUMN_MIGRATIONS);
  await ensureTableColumns('platform_user_access', PLATFORM_USER_ACCESS_COLUMN_MIGRATIONS);
};

// initializeDatabase
// 是什么：数据库整体初始化函数。
// 做什么：按客户端类型建立连接并执行建表与迁移。
// 为什么：把连接、建库、建表和迁移串成统一启动流程，便于应用和脚本复用。
const initializeDatabase = async () => {
  try {
    if (dbClientName === 'mysql') {
      await initializeMysqlConnection();
    } else {
      await initializeSqliteConnection();
    }

    await initializeSchema();
  } catch (error) {
    const traceId = createTraceId();
    logWithTrace(traceId, 'db', 'connect.error', {
      clientName: dbClientName,
      dbPath,
      message: error.message,
    });
    throw error;
  }
};

const db = {
  clientName: dbClientName,
  dbPath,
  mysqlConfig,
  resolveDbPath: resolveSqliteDbPath,
  transformSql: (sql) => transformSqlForClient(sql, dbClientName),

  // serialize
  // 是什么：兼容 sqlite3 的串行执行入口。
  // 做什么：在当前适配层中直接调度回调执行，不再额外维护显式串行队列。
  // 为什么：历史代码只在初始化阶段使用该接口，改为统一 Promise 初始化后仍需保留兼容方法。
  serialize(callback) {
    if (typeof callback === 'function') {
      callback();
    }
    return this;
  },

  run(sql, params, callback) {
    const normalizedParams = Array.isArray(params) ? params : [];
    const normalizedCallback = Array.isArray(params) ? callback : params;

    this.readyPromise
      .then(() => rawRun(sql, normalizedParams))
      .then((result) => {
        invokeCallback(normalizedCallback, toStatementContext(result), null);
      })
      .catch((error) => {
        invokeCallback(normalizedCallback, toStatementContext(), normalizeDbError(error));
      });

    return this;
  },

  get(sql, params, callback) {
    const normalizedParams = Array.isArray(params) ? params : [];
    const normalizedCallback = Array.isArray(params) ? callback : params;

    this.readyPromise
      .then(() => rawGet(sql, normalizedParams))
      .then((row) => {
        invokeCallback(normalizedCallback, {}, null, row || null);
      })
      .catch((error) => {
        invokeCallback(normalizedCallback, {}, normalizeDbError(error));
      });

    return this;
  },

  all(sql, params, callback) {
    const normalizedParams = Array.isArray(params) ? params : [];
    const normalizedCallback = Array.isArray(params) ? callback : params;

    this.readyPromise
      .then(() => rawAll(sql, normalizedParams))
      .then((rows) => {
        invokeCallback(normalizedCallback, {}, null, rows || []);
      })
      .catch((error) => {
        invokeCallback(normalizedCallback, {}, normalizeDbError(error));
      });

    return this;
  },
};

db.readyPromise = initializeDatabase();

module.exports = db;
