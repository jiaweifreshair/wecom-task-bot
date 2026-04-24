-- ============================================================
-- 文件: 003-migrations.sql
-- 版本: 1.0.0
-- 创建日期: 2025-07-15
-- 用途: 幂等字段迁移（企业微信任务管理系统）
-- 说明: 为已有 tasks 表补齐 8 个迁移列，为 platform_user_access
--       表补齐 1 个迁移列。使用存储过程 + INFORMATION_SCHEMA
--       条件判断实现幂等性，列已存在时自动跳过。
--       迁移定义与 db.js TASKS_TABLE_COLUMN_MIGRATIONS /
--       PLATFORM_USER_ACCESS_COLUMN_MIGRATIONS 完全一致。
-- ============================================================

USE `wecom_task_bot`;

DELIMITER //

-- -----------------------------------------------------------
-- 幂等迁移存储过程：列不存在时才执行 ALTER TABLE ADD COLUMN
-- -----------------------------------------------------------
DROP PROCEDURE IF EXISTS `__run_idempotent_migrations`//

CREATE PROCEDURE `__run_idempotent_migrations`()
BEGIN
  DECLARE v_db_name VARCHAR(64) DEFAULT DATABASE();

  -- ---------------------------------------------------------
  -- tasks 表迁移列 (8 列)
  -- ---------------------------------------------------------

  -- 1. redo_count INT DEFAULT 0
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = v_db_name AND TABLE_NAME = 'tasks' AND COLUMN_NAME = 'redo_count'
  ) THEN
    ALTER TABLE tasks ADD COLUMN redo_count INT DEFAULT 0;
  END IF;

  -- 2. last_reminder_at DATETIME NULL
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = v_db_name AND TABLE_NAME = 'tasks' AND COLUMN_NAME = 'last_reminder_at'
  ) THEN
    ALTER TABLE tasks ADD COLUMN last_reminder_at DATETIME;
  END IF;

  -- 3. last_reminder_kind VARCHAR(64) NULL
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = v_db_name AND TABLE_NAME = 'tasks' AND COLUMN_NAME = 'last_reminder_kind'
  ) THEN
    ALTER TABLE tasks ADD COLUMN last_reminder_kind VARCHAR(64);
  END IF;

  -- 4. completed_by_userid VARCHAR(191) NULL
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = v_db_name AND TABLE_NAME = 'tasks' AND COLUMN_NAME = 'completed_by_userid'
  ) THEN
    ALTER TABLE tasks ADD COLUMN completed_by_userid VARCHAR(191);
  END IF;

  -- 5. verified_by_userid VARCHAR(191) NULL
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = v_db_name AND TABLE_NAME = 'tasks' AND COLUMN_NAME = 'verified_by_userid'
  ) THEN
    ALTER TABLE tasks ADD COLUMN verified_by_userid VARCHAR(191);
  END IF;

  -- 6. updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = v_db_name AND TABLE_NAME = 'tasks' AND COLUMN_NAME = 'updated_at'
  ) THEN
    ALTER TABLE tasks ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP;
  END IF;

  -- 7. owner_cal_id VARCHAR(191) NULL
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = v_db_name AND TABLE_NAME = 'tasks' AND COLUMN_NAME = 'owner_cal_id'
  ) THEN
    ALTER TABLE tasks ADD COLUMN owner_cal_id VARCHAR(191);
  END IF;

  -- 8. owner_userid VARCHAR(191) NULL
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = v_db_name AND TABLE_NAME = 'tasks' AND COLUMN_NAME = 'owner_userid'
  ) THEN
    ALTER TABLE tasks ADD COLUMN owner_userid VARCHAR(191);
  END IF;

  -- ---------------------------------------------------------
  -- platform_user_access 表迁移列 (1 列)
  -- ---------------------------------------------------------

  -- 1. menu_permissions_json VARCHAR(2048) DEFAULT '[]'
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = v_db_name AND TABLE_NAME = 'platform_user_access' AND COLUMN_NAME = 'menu_permissions_json'
  ) THEN
    ALTER TABLE platform_user_access ADD COLUMN menu_permissions_json VARCHAR(2048) DEFAULT '[]';
  END IF;

END//

DELIMITER ;

-- -----------------------------------------------------------
-- 执行迁移并清理临时存储过程
-- -----------------------------------------------------------
CALL `__run_idempotent_migrations`();
DROP PROCEDURE IF EXISTS `__run_idempotent_migrations`;
