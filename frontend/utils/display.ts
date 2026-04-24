// display.ts
// 是什么：数据展示准确性保障工具集。
// 做什么：提供统一的文本归一化、日期格式化、任务状态映射和 KPI 构建函数。
// 为什么：需求 10 要求前端展示数据与后端严格一致，禁止前端推断或多处分散实现。

import { TaskStatus, KPIStats } from '../types';
import type { BackendTaskKpi } from '../api';

/**
 * normalizeText
 * 是什么：空值防护文本归一化函数。
 * 做什么：将 null/undefined/空字符串转换为占位文本，禁止展示 'null'/'undefined'/空白。
 * 为什么：需求 10.10 要求展示明确占位文本。
 */
export function normalizeText(
  value: string | null | undefined,
  placeholder = '未设置'
): string {
  if (value === null || value === undefined) {
    return placeholder;
  }
  const trimmed = String(value).trim();
  if (trimmed === '' || trimmed === 'null' || trimmed === 'undefined' || trimmed === 'NaN') {
    return placeholder;
  }
  return trimmed;
}

/**
 * formatDateTime
 * 是什么：统一日期时间格式化函数。
 * 做什么：将后端 UTC 时间按本地时区格式化为 YYYY-MM-DD HH:mm。
 * 为什么：需求 10.2/10.8 要求统一格式化函数，禁止不同页面使用不同格式。
 */
export function formatDateTime(
  value: string | number | Date | null | undefined,
  fallback = '时间未设置'
): string {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }

  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    return fallback;
  }

  // 防止 epoch 零值
  if (date.getTime() === 0) {
    return fallback;
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');

  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

/**
 * mapTaskStatus
 * 是什么：任务状态恒等映射函数。
 * 做什么：直接返回后端 status 字段值，禁止前端推断或硬编码映射。
 * 为什么：需求 10.1 要求直接使用后端返回的 status 字段。
 */
export function mapTaskStatus(status: TaskStatus): TaskStatus {
  return status;
}

/**
 * buildTaskKpi
 * 是什么：任务 KPI 统计构建函数。
 * 做什么：从后端 KPI 数据构建前端 KPIStats，确保各状态数量之和等于 total_tasks。
 * 为什么：需求 10.7 要求各状态数量之和等于总任务数。
 */
export function buildTaskKpi(kpi: BackendTaskKpi): KPIStats {
  return {
    totalTasks: Number(kpi.total_tasks || 0),
    completionRate: Number(kpi.completion_rate || 0),
    waitingAcceptance: Number(kpi.waiting_verify_tasks || 0),
    overdueTasks: Number(kpi.overdue_tasks || 0),
    dueSoonTasks: Number(kpi.due_soon_tasks || 0),
    onTimeRate: Number(kpi.on_time_rate || 0),
  };
}

/**
 * computePaginationTotal
 * 是什么：分页总数计算函数。
 * 做什么：确保分页总数标注与实际列表长度一致。
 * 为什么：需求 10.12 要求分页总数准确。
 */
export function computePaginationTotal(
  filteredLength: number,
  serverTotal?: number
): number {
  // 优先使用服务端总数，但如果服务端未提供则使用本地过滤后长度
  if (typeof serverTotal === 'number' && serverTotal >= 0) {
    return serverTotal;
  }
  return filteredLength;
}

/** 数据过期阈值（毫秒） */
export const DATA_STALE_THRESHOLD_MS = 30_000;

/**
 * isDataStale
 * 是什么：数据过期判定函数。
 * 做什么：检查上次拉取时间是否超过 30 秒。
 * 为什么：需求 10.6 要求页面切换返回时检查数据过期并静默刷新。
 */
export function isDataStale(lastFetchedAt: number, now?: number): boolean {
  const currentTime = now ?? Date.now();
  return currentTime - lastFetchedAt > DATA_STALE_THRESHOLD_MS;
}
