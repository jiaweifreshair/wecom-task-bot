const path = require('path');

// normalizeText
// 是什么：数据库方言模块内部文本清洗函数。
// 做什么：把任意输入统一转为去首尾空白的字符串。
// 为什么：数据库客户端、环境变量和 SQL 片段都可能来自不同来源，先统一文本形态更稳。
const normalizeText = (value) => {
  if (value === undefined || value === null) {
    return '';
  }

  return String(value).trim();
};

// resolveDbClientName
// 是什么：数据库客户端名称解析函数。
// 做什么：优先读取显式配置，其次在存在 SQLite 路径时回退到 sqlite，否则默认切到 mysql。
// 为什么：运行时要切到 MySQL，但现有自动化测试仍依赖 SQLite 文件库，必须兼容两条链路。
// 注：WECOM_TASK_BOT_DB_CLIENT 为 start.sh/init-linux.sh 兼容旧配置保留的别名。
const resolveDbClientName = (env = process.env) => {
  const explicitClientName = normalizeText(
    env.TASK_BOT_DB_CLIENT || env.WECOM_TASK_BOT_DB_CLIENT
  ).toLowerCase();

  if (explicitClientName === 'mysql') {
    return 'mysql';
  }

  if (explicitClientName === 'sqlite') {
    return 'sqlite';
  }

  if (normalizeText(env.TASK_BOT_DB_PATH || env.WECOM_TASK_BOT_DB_PATH)) {
    return 'sqlite';
  }

  return 'mysql';
};

// resolveSqliteDbPath
// 是什么：SQLite 数据库路径解析函数。
// 做什么：优先读取环境变量中的自定义数据库文件路径，缺省回退到正式库 `database/tasks.db`。
// 为什么：测试与 E2E 仍需使用独立文件库，避免污染联调和真实业务数据。
const resolveSqliteDbPath = (env = process.env) => {
  const configuredDbPath = normalizeText(env.TASK_BOT_DB_PATH || env.WECOM_TASK_BOT_DB_PATH);

  if (!configuredDbPath) {
    return path.resolve(__dirname, '../../database/tasks.db');
  }

  if (path.isAbsolute(configuredDbPath)) {
    return configuredDbPath;
  }

  return path.resolve(__dirname, '../../', configuredDbPath);
};

// buildMysqlConnectionConfig
// 是什么：MySQL 连接配置构建函数。
// 做什么：从 TASK_BOT_DB_* 环境变量读取连接参数，并补齐连接池缺省项。
// 为什么：切库后需要统一的配置入口，避免不同脚本和服务各自拼装连接参数。
const buildMysqlConnectionConfig = (env = process.env) => {
  const portRaw = Number(normalizeText(env.TASK_BOT_DB_PORT) || 3306);
  const port = Number.isInteger(portRaw) && portRaw > 0 ? portRaw : 3306;

  return {
    host: normalizeText(env.TASK_BOT_DB_HOST) || '127.0.0.1',
    port,
    user: normalizeText(env.TASK_BOT_DB_USER) || 'root',
    password: normalizeText(env.TASK_BOT_DB_PASSWORD) || '',
    database: normalizeText(env.TASK_BOT_DB_NAME) || 'wecom_task_bot',
    connectionLimit: 10,
    waitForConnections: true,
    queueLimit: 0,
    charset: 'utf8mb4',
    timezone: 'Z',
    dateStrings: true,
  };
};

// escapeMysqlIdentifier
// 是什么：MySQL 标识符转义函数。
// 做什么：限制数据库名和表名只保留安全字符，并按反引号包裹输出。
// 为什么：初始化数据库和信息架构查询会拼接标识符，必须避免把原始环境变量直接拼进 SQL。
const escapeMysqlIdentifier = (value) => {
  const sanitizedValue = normalizeText(value).replace(/[^0-9A-Za-z_$]/g, '_') || 'wecom_task_bot';
  return `\`${sanitizedValue}\``;
};

// transformSqliteUpsertToMysql
// 是什么：SQLite upsert 语句转 MySQL 语句函数。
// 做什么：把 `ON CONFLICT ... DO UPDATE` 转换为 `ON DUPLICATE KEY UPDATE` 并替换 `excluded.xxx`。
// 为什么：现有服务层大量依赖 SQLite upsert 语法，切库后不能要求业务层全量重写。
const transformSqliteUpsertToMysql = (sql) => {
  const matched = sql.match(/ON\s+CONFLICT\s*\(([^)]+)\)\s*DO\s+UPDATE\s+SET\s+([\s\S]*)$/i);
  if (!matched) {
    return sql;
  }

  const updateClause = matched[2]
    .replace(/excluded\.([a-zA-Z0-9_]+)/gi, 'VALUES($1)')
    .replace(/;\s*$/g, '');

  return sql.replace(/ON\s+CONFLICT\s*\(([^)]+)\)\s*DO\s+UPDATE\s+SET\s+([\s\S]*)$/i, `ON DUPLICATE KEY UPDATE ${updateClause}`);
};

// transformSqlForClient
// 是什么：跨数据库 SQL 兼容转换函数。
// 做什么：在 mysql 模式下将 SQLite 时间函数、upsert 语法和排序表达式改写为兼容写法。
// 为什么：路由和服务层已有 SQL 量较大，优先通过兼容层平滑切换能把改动面控制在数据库适配层。
const transformSqlForClient = (sql, clientName) => {
  if (clientName !== 'mysql') {
    return sql;
  }

  let transformedSql = String(sql || '');

  transformedSql = transformedSql.replace(
    /datetime\(\s*'now'\s*,\s*'([+-]?\d+)\s+hour'\s*\)/gi,
    (_, hourOffset) => {
      const offsetValue = Number(hourOffset || 0);
      const intervalValue = Math.abs(offsetValue);
      const intervalDirection = offsetValue >= 0 ? 'DATE_ADD' : 'DATE_SUB';
      return `${intervalDirection}(CURRENT_TIMESTAMP, INTERVAL ${intervalValue} HOUR)`;
    }
  );

  transformedSql = transformedSql.replace(/datetime\(\s*'now'\s*\)/gi, 'CURRENT_TIMESTAMP');
  transformedSql = transformedSql.replace(/datetime\(\s*\?\s*,\s*'unixepoch'\s*\)/gi, 'FROM_UNIXTIME(?)');
  transformedSql = transformedSql.replace(/datetime\(\s*\?\s*\)/gi, '?');
  transformedSql = transformedSql.replace(/datetime\(\s*([a-zA-Z_][a-zA-Z0-9_\.]*)\s*\)/g, '$1');
  transformedSql = transformSqliteUpsertToMysql(transformedSql);

  return transformedSql;
};

// buildSchemaStatements
// 是什么：建表语句构建函数。
// 做什么：根据目标数据库输出完整的初始化语句列表。
// 为什么：SQLite 与 MySQL 的主键、自增和字符列约束不同，必须分别生成而不是简单替换关键字。
const buildSchemaStatements = (clientName) => {
  if (clientName === 'mysql') {
    return [
      {
        tableName: 'tasks',
        sql: `CREATE TABLE IF NOT EXISTS tasks (
          id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
          wecom_schedule_id VARCHAR(191) UNIQUE,
          title TEXT,
          description TEXT,
          creator_userid VARCHAR(191),
          executor_userid VARCHAR(191),
          owner_userid VARCHAR(191),
          owner_cal_id VARCHAR(191),
          start_time DATETIME,
          end_time DATETIME,
          status VARCHAR(32) DEFAULT 'PENDING',
          completion_time DATETIME,
          verify_time DATETIME,
          reject_reason TEXT,
          redo_count INT DEFAULT 0,
          last_reminder_at DATETIME,
          last_reminder_kind VARCHAR(64),
          completed_by_userid VARCHAR(191),
          verified_by_userid VARCHAR(191),
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      },
      {
        tableName: 'user_calendar_map',
        sql: `CREATE TABLE IF NOT EXISTS user_calendar_map (
          user_id VARCHAR(191) PRIMARY KEY,
          cal_id VARCHAR(191) NOT NULL,
          calendar_summary VARCHAR(255),
          source VARCHAR(64) DEFAULT 'auto_created',
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      },
      {
        tableName: 'wecom_contact_users',
        sql: `CREATE TABLE IF NOT EXISTS wecom_contact_users (
          user_id VARCHAR(191) PRIMARY KEY,
          name VARCHAR(191),
          department_ids_json VARCHAR(2048) DEFAULT '[]',
          main_department INT,
          is_leader_in_dept_json VARCHAR(2048) DEFAULT '[]',
          direct_leader_user_ids_json VARCHAR(2048) DEFAULT '[]',
          position VARCHAR(191),
          mobile VARCHAR(64),
          gender INT,
          email VARCHAR(191),
          biz_mail VARCHAR(191),
          status INT,
          avatar TEXT,
          telephone VARCHAR(64),
          address VARCHAR(255),
          alias VARCHAR(191),
          qr_code TEXT,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      },
      {
        tableName: 'wecom_contact_departments',
        sql: `CREATE TABLE IF NOT EXISTS wecom_contact_departments (
          department_id INT PRIMARY KEY,
          name VARCHAR(191),
          parent_department_id INT,
          order_value INT,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      },
      {
        tableName: 'wecom_contact_tags',
        sql: `CREATE TABLE IF NOT EXISTS wecom_contact_tags (
          tag_id INT PRIMARY KEY,
          name VARCHAR(191),
          add_user_items_json VARCHAR(2048) DEFAULT '[]',
          del_user_items_json VARCHAR(2048) DEFAULT '[]',
          add_party_items_json VARCHAR(2048) DEFAULT '[]',
          del_party_items_json VARCHAR(2048) DEFAULT '[]',
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      },
      {
        tableName: 'wecom_contact_event_log',
        sql: `CREATE TABLE IF NOT EXISTS wecom_contact_event_log (
          id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
          change_type VARCHAR(64) NOT NULL,
          entity_type VARCHAR(64) NOT NULL,
          entity_id VARCHAR(191) NOT NULL,
          payload_json LONGTEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      },
      {
        tableName: 'platform_user_access',
        sql: `CREATE TABLE IF NOT EXISTS platform_user_access (
          user_id VARCHAR(191) PRIMARY KEY,
          platform_role VARCHAR(32) NOT NULL,
          menu_permissions_json VARCHAR(2048) DEFAULT '[]',
          updated_by_userid VARCHAR(191),
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      },
    ];
  }

  return [
    {
      tableName: 'tasks',
      sql: `CREATE TABLE IF NOT EXISTS tasks (
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
      )`,
    },
    {
      tableName: 'user_calendar_map',
      sql: `CREATE TABLE IF NOT EXISTS user_calendar_map (
        user_id TEXT PRIMARY KEY,
        cal_id TEXT NOT NULL,
        calendar_summary TEXT,
        source TEXT DEFAULT 'auto_created',
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
    },
    {
      tableName: 'wecom_contact_users',
      sql: `CREATE TABLE IF NOT EXISTS wecom_contact_users (
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
    },
    {
      tableName: 'wecom_contact_departments',
      sql: `CREATE TABLE IF NOT EXISTS wecom_contact_departments (
        department_id INTEGER PRIMARY KEY,
        name TEXT,
        parent_department_id INTEGER,
        order_value INTEGER,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
    },
    {
      tableName: 'wecom_contact_tags',
      sql: `CREATE TABLE IF NOT EXISTS wecom_contact_tags (
        tag_id INTEGER PRIMARY KEY,
        name TEXT,
        add_user_items_json TEXT DEFAULT '[]',
        del_user_items_json TEXT DEFAULT '[]',
        add_party_items_json TEXT DEFAULT '[]',
        del_party_items_json TEXT DEFAULT '[]',
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
    },
    {
      tableName: 'wecom_contact_event_log',
      sql: `CREATE TABLE IF NOT EXISTS wecom_contact_event_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        change_type TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
    },
    {
      tableName: 'platform_user_access',
      sql: `CREATE TABLE IF NOT EXISTS platform_user_access (
        user_id TEXT PRIMARY KEY,
        platform_role TEXT NOT NULL,
        menu_permissions_json TEXT DEFAULT '[]',
        updated_by_userid TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
    },
  ];
};

module.exports = {
  buildMysqlConnectionConfig,
  buildSchemaStatements,
  escapeMysqlIdentifier,
  resolveDbClientName,
  resolveSqliteDbPath,
  transformSqlForClient,
};
