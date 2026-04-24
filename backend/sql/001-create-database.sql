-- ============================================================
-- 文件: 001-create-database.sql
-- 版本: 1.0.0
-- 创建日期: 2025-07-15
-- 用途: 创建 wecom_task_bot 数据库（企业微信任务管理系统）
-- 字符集: utf8mb4 / utf8mb4_unicode_ci
-- 说明: 幂等脚本，可重复执行；数据库已存在时自动跳过
-- ============================================================

CREATE DATABASE IF NOT EXISTS `wecom_task_bot`
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;
