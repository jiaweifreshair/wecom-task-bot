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
}

export interface KPIStats {
  totalTasks: number;
  onTimeRate: number;
  pendingAcceptance: number;
  overdueRate: number;
}