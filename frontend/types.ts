export type LegacyRole = 'MANAGER' | 'EXECUTOR';
export type PlatformRole = 'SUPER_ADMIN' | 'ADMIN' | 'EXECUTOR';
export type MenuPermission = 'DASHBOARD' | 'TASKS' | 'CALENDAR' | 'TEAM_STATS' | 'SETTINGS';

export enum TaskStatus {
  PENDING = 'PENDING',
  WAITING_VERIFY = 'WAITING_VERIFY',
  COMPLETED = 'COMPLETED',
  REJECTED = 'REJECTED'
}

export interface User {
  id: string;
  name: string;
  avatar: string;
  role: LegacyRole;
  platformRole: PlatformRole;
  isAdmin: boolean;
  isSuperAdmin: boolean;
  menuPermissions: MenuPermission[];
}

export interface Task {
  id: number;
  wecomScheduleId: string;
  title: string;
  description: string;
  creator: User;
  executor: User;
  startTime: string;
  endTime: string;
  status: TaskStatus;
  completionTime?: string;
  verifyTime?: string;
  rejectReason?: string;
  redoCount: number;
  canComplete: boolean;
  canVerify: boolean;
  isDueSoon: boolean;
  isOverdue: boolean;
}

export interface KPIStats {
  totalTasks: number;
  completionRate: number;
  waitingAcceptance: number;
  overdueTasks: number;
  dueSoonTasks: number;
  onTimeRate: number;
}

export interface TaskCreatePayload {
  title: string;
  description: string;
  executorUserId: string;
  startTime: string;
  endTime: string;
}

export interface TeamMemberStats {
  userId: string;
  userName: string;
  role: LegacyRole;
  taskCount: number;
  completedCount: number;
  pendingCount: number;
  waitingVerifyCount: number;
  overdueCount: number;
  completionRate: number;
}

// TeamRoleSummaryStats
// 是什么：团队角色总览统计模型。
// 做什么：承载管理岗或执行岗在当前视角下的成员数、任务数、时效和完成率指标。
// 为什么：团队页需要先展示角色层级总览，再下钻到成员和岗位维度。
export interface TeamRoleSummaryStats {
  role: LegacyRole;
  memberCount: number;
  taskCount: number;
  completedCount: number;
  pendingCount: number;
  waitingVerifyCount: number;
  overdueCount: number;
  dueSoonCount: number;
  completionRate: number;
  onTimeRate: number;
}

// TeamRoleMemberStats
// 是什么：团队角色成员统计模型。
// 做什么：描述单个成员在某个岗位口径下的任务表现及岗位信息。
// 为什么：管理岗与执行岗需要显示不同成员榜单，并带出真实岗位名称供管理判断。
export interface TeamRoleMemberStats {
  userId: string;
  userName: string;
  role: LegacyRole;
  position: string;
  taskCount: number;
  completedCount: number;
  pendingCount: number;
  waitingVerifyCount: number;
  overdueCount: number;
  dueSoonCount: number;
  completionRate: number;
  onTimeRate: number;
}

// TeamPositionStats
// 是什么：岗位聚合统计模型。
// 做什么：按岗位名称聚合成员数量、任务量和时效指标。
// 为什么：用户要求不同岗位展示不同统计结果，前端需要稳定的岗位分组结构。
export interface TeamPositionStats {
  role: LegacyRole;
  position: string;
  memberCount: number;
  taskCount: number;
  completedCount: number;
  pendingCount: number;
  waitingVerifyCount: number;
  overdueCount: number;
  dueSoonCount: number;
  completionRate: number;
  onTimeRate: number;
}

// TeamStatsSnapshot
// 是什么：团队统计快照模型。
// 做什么：统一承载管理岗、执行岗的总览、成员榜单和岗位榜单。
// 为什么：团队页需要一次请求拿到完整统计，避免多接口拼装导致口径漂移。
export interface TeamStatsSnapshot {
  summaries: {
    manager: TeamRoleSummaryStats;
    executor: TeamRoleSummaryStats;
  };
  members: {
    manager: TeamRoleMemberStats[];
    executor: TeamRoleMemberStats[];
  };
  positions: {
    manager: TeamPositionStats[];
    executor: TeamPositionStats[];
  };
}

export interface SystemUserRow {
  userId: string;
  name: string;
  position: string;
  mobile: string;
  email: string;
  alias: string;
  status: number;
  mainDepartment: number;
  mainDepartmentName: string;
  calId: string;
  calendarSummary: string;
  calendarSource: string;
  platformRole: PlatformRole;
  isSuperAdmin: boolean;
  isAdmin: boolean;
  menuPermissions: MenuPermission[];
  accessSource: string;
  contactUpdatedAt: string;
}

// SystemDepartmentRow
// 是什么：系统管理部门筛选行模型。
// 做什么：描述本地通讯录部门树的扁平节点信息与层级深度。
// 为什么：系统设置页需要直接消费带层级的部门数据，快速渲染筛选器。
export interface SystemDepartmentRow {
  departmentId: number;
  name: string;
  parentDepartmentId: number;
  orderValue: number;
  level: number;
  memberCount: number;
}

export interface PaginationMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}
