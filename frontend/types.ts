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
  role: 'MANAGER' | 'EXECUTOR';
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
  role: 'MANAGER' | 'EXECUTOR';
  taskCount: number;
  completedCount: number;
  pendingCount: number;
  waitingVerifyCount: number;
  overdueCount: number;
  completionRate: number;
}
