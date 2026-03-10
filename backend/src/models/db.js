const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { logWithTrace, createTraceId } = require('../utils/logger');

// Initialize Database
const dbPath = path.resolve(__dirname, '../../database/tasks.db');
const db = new sqlite3.Database(dbPath, (err) => {
  const traceId = createTraceId();
  if (err) {
    logWithTrace(traceId, 'db', 'connect.error', {
      dbPath,
      message: err.message
    });
  } else {
    logWithTrace(traceId, 'db', 'connect.success', {
      dbPath
    });
  }
});

// TASKS_TABLE_COLUMN_MIGRATIONS
// 是什么：tasks 表字段迁移配置。
// 做什么：声明需补齐的字段与对应 ALTER SQL，用于旧库平滑升级。
// 为什么：项目已上线后直接改建表语句不会影响存量数据库，必须通过迁移补字段。
const TASKS_TABLE_COLUMN_MIGRATIONS = [
  {
    columnName: 'redo_count',
    alterSql: `ALTER TABLE tasks ADD COLUMN redo_count INTEGER DEFAULT 0`,
  },
  {
    columnName: 'last_reminder_at',
    alterSql: `ALTER TABLE tasks ADD COLUMN last_reminder_at DATETIME`,
  },
  {
    columnName: 'last_reminder_kind',
    alterSql: `ALTER TABLE tasks ADD COLUMN last_reminder_kind TEXT`,
  },
  {
    columnName: 'completed_by_userid',
    alterSql: `ALTER TABLE tasks ADD COLUMN completed_by_userid TEXT`,
  },
  {
    columnName: 'verified_by_userid',
    alterSql: `ALTER TABLE tasks ADD COLUMN verified_by_userid TEXT`,
  },
  {
    columnName: 'updated_at',
    alterSql: `ALTER TABLE tasks ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP`,
  },
  {
    columnName: 'owner_cal_id',
    alterSql: `ALTER TABLE tasks ADD COLUMN owner_cal_id TEXT`,
  },
  {
    columnName: 'owner_userid',
    alterSql: `ALTER TABLE tasks ADD COLUMN owner_userid TEXT`,
  },
];

// ensureTasksTableColumns
// 是什么：tasks 表字段自愈迁移函数。
// 做什么：检查缺失字段并按配置执行 `ALTER TABLE`。
// 为什么：保证新功能依赖字段在历史数据库中可用，避免运行期 SQL 报错。
const ensureTasksTableColumns = () => {
  const traceId = createTraceId();

  db.all(`PRAGMA table_info(tasks)`, [], (tableInfoError, columns = []) => {
    if (tableInfoError) {
      logWithTrace(traceId, 'db', 'schema.migration.inspect_error', {
        table: 'tasks',
        message: tableInfoError.message,
      });
      return;
    }

    const existingColumns = new Set(columns.map((item) => item && item.name).filter(Boolean));

    TASKS_TABLE_COLUMN_MIGRATIONS.forEach((migration) => {
      if (existingColumns.has(migration.columnName)) {
        return;
      }

      db.run(migration.alterSql, (migrationError) => {
        if (migrationError) {
          logWithTrace(traceId, 'db', 'schema.migration.apply_error', {
            table: 'tasks',
            columnName: migration.columnName,
            message: migrationError.message,
          });
          return;
        }

        logWithTrace(traceId, 'db', 'schema.migration.apply_success', {
          table: 'tasks',
          columnName: migration.columnName,
        });
      });
    });
  });
};

// Initialize Schema
db.serialize(() => {
  const traceId = createTraceId();
  db.run(`CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wecom_schedule_id TEXT UNIQUE,
    title TEXT,
    description TEXT,
    creator_userid TEXT,
    executor_userid TEXT,
    owner_userid TEXT,
    owner_cal_id TEXT,
    start_time DATETIME,
    end_time DATETIME,
    status TEXT DEFAULT 'PENDING',
    completion_time DATETIME,
    verify_time DATETIME,
    reject_reason TEXT,
    redo_count INTEGER DEFAULT 0,
    last_reminder_at DATETIME,
    last_reminder_kind TEXT,
    completed_by_userid TEXT,
    verified_by_userid TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`, (err) => {
    if (err) {
      logWithTrace(traceId, 'db', 'schema.init.error', {
        table: 'tasks',
        message: err.message
      });
    } else {
      logWithTrace(traceId, 'db', 'schema.init.success', {
        table: 'tasks'
      });
      ensureTasksTableColumns();
    }
  });

  db.run(
    `CREATE TABLE IF NOT EXISTS user_calendar_map (
      user_id TEXT PRIMARY KEY,
      cal_id TEXT NOT NULL,
      calendar_summary TEXT,
      source TEXT DEFAULT 'auto_created',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    (err) => {
      if (err) {
        logWithTrace(traceId, 'db', 'schema.init.error', {
          table: 'user_calendar_map',
          message: err.message,
        });
        return;
      }

      logWithTrace(traceId, 'db', 'schema.init.success', {
        table: 'user_calendar_map',
      });
    }
  );

  db.run(
    `CREATE TABLE IF NOT EXISTS wecom_contact_users (
      user_id TEXT PRIMARY KEY,
      name TEXT,
      department_ids_json TEXT DEFAULT '[]',
      main_department INTEGER,
      is_leader_in_dept_json TEXT DEFAULT '[]',
      direct_leader_user_ids_json TEXT DEFAULT '[]',
      position TEXT,
      mobile TEXT,
      gender INTEGER,
      email TEXT,
      biz_mail TEXT,
      status INTEGER,
      avatar TEXT,
      telephone TEXT,
      address TEXT,
      alias TEXT,
      qr_code TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    (err) => {
      if (err) {
        logWithTrace(traceId, 'db', 'schema.init.error', {
          table: 'wecom_contact_users',
          message: err.message,
        });
        return;
      }

      logWithTrace(traceId, 'db', 'schema.init.success', {
        table: 'wecom_contact_users',
      });
    }
  );

  db.run(
    `CREATE TABLE IF NOT EXISTS wecom_contact_departments (
      department_id INTEGER PRIMARY KEY,
      name TEXT,
      parent_department_id INTEGER,
      order_value INTEGER,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    (err) => {
      if (err) {
        logWithTrace(traceId, 'db', 'schema.init.error', {
          table: 'wecom_contact_departments',
          message: err.message,
        });
        return;
      }

      logWithTrace(traceId, 'db', 'schema.init.success', {
        table: 'wecom_contact_departments',
      });
    }
  );

  db.run(
    `CREATE TABLE IF NOT EXISTS wecom_contact_tags (
      tag_id INTEGER PRIMARY KEY,
      name TEXT,
      add_user_items_json TEXT DEFAULT '[]',
      del_user_items_json TEXT DEFAULT '[]',
      add_party_items_json TEXT DEFAULT '[]',
      del_party_items_json TEXT DEFAULT '[]',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    (err) => {
      if (err) {
        logWithTrace(traceId, 'db', 'schema.init.error', {
          table: 'wecom_contact_tags',
          message: err.message,
        });
        return;
      }

      logWithTrace(traceId, 'db', 'schema.init.success', {
        table: 'wecom_contact_tags',
      });
    }
  );

  db.run(
    `CREATE TABLE IF NOT EXISTS wecom_contact_event_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      change_type TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    (err) => {
      if (err) {
        logWithTrace(traceId, 'db', 'schema.init.error', {
          table: 'wecom_contact_event_log',
          message: err.message,
        });
        return;
      }

      logWithTrace(traceId, 'db', 'schema.init.success', {
        table: 'wecom_contact_event_log',
      });
    }
  );
});

module.exports = db;
