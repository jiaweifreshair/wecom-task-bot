-- ============================================================
-- 文件: 002-create-tables.sql
-- 版本: 1.0.0
-- 创建日期: 2025-07-15
-- 用途: 创建 wecom_task_bot 全部业务表（企业微信任务管理系统）
-- 字符集: utf8mb4 / utf8mb4_unicode_ci
-- 说明: 幂等脚本，可重复执行；表已存在时自动跳过
--       表结构与 db-dialect.js buildSchemaStatements('mysql') 输出一致
-- ============================================================

USE `wecom_task_bot`;

-- -----------------------------------------------------------
-- 1. tasks - 任务主表
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS tasks (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------
-- 2. user_calendar_map - 用户日历映射表
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_calendar_map (
  user_id VARCHAR(191) PRIMARY KEY,
  cal_id VARCHAR(191) NOT NULL,
  calendar_summary VARCHAR(255),
  source VARCHAR(64) DEFAULT 'auto_created',
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------
-- 3. wecom_contact_users - 企微通讯录用户表
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS wecom_contact_users (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------
-- 4. wecom_contact_departments - 企微通讯录部门表
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS wecom_contact_departments (
  department_id INT PRIMARY KEY,
  name VARCHAR(191),
  parent_department_id INT,
  order_value INT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------
-- 5. wecom_contact_tags - 企微通讯录标签表
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS wecom_contact_tags (
  tag_id INT PRIMARY KEY,
  name VARCHAR(191),
  add_user_items_json VARCHAR(2048) DEFAULT '[]',
  del_user_items_json VARCHAR(2048) DEFAULT '[]',
  add_party_items_json VARCHAR(2048) DEFAULT '[]',
  del_party_items_json VARCHAR(2048) DEFAULT '[]',
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------
-- 6. wecom_contact_event_log - 企微通讯录事件日志表
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS wecom_contact_event_log (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  change_type VARCHAR(64) NOT NULL,
  entity_type VARCHAR(64) NOT NULL,
  entity_id VARCHAR(191) NOT NULL,
  payload_json LONGTEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------
-- 7. platform_user_access - 平台用户权限表
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS platform_user_access (
  user_id VARCHAR(191) PRIMARY KEY,
  platform_role VARCHAR(32) NOT NULL,
  menu_permissions_json VARCHAR(2048) DEFAULT '[]',
  updated_by_userid VARCHAR(191),
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
