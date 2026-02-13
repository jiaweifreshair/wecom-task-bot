import axios from 'axios';
import { TaskCreatePayload, TaskStatus } from './types';

const API_BASE = '/api';

const api = axios.create({
  baseURL: API_BASE,
  headers: {
    'Content-Type': 'application/json',
  },
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

export interface BackendTaskRow {
  id: number;
  wecom_schedule_id: string;
  title: string;
  description: string;
  creator_userid: string;
  executor_userid: string;
  start_time: string;
  end_time: string;
  status: TaskStatus;
  completion_time?: string;
  verify_time?: string;
  reject_reason?: string;
  redo_count?: number;
  can_complete?: boolean;
  can_verify?: boolean;
  is_due_soon?: boolean;
  is_overdue?: boolean;
}

export interface BackendTaskKpi {
  total_tasks: number;
  completed_tasks: number;
  waiting_verify_tasks: number;
  overdue_tasks: number;
  due_soon_tasks: number;
  completion_rate: number;
  on_time_rate: number;
}

export interface TaskListResponse {
  tasks: BackendTaskRow[];
  kpi: BackendTaskKpi;
}

export type AuthLoginMode = 'auto' | 'qr' | 'oauth';

export const login = (mode: AuthLoginMode = 'auto') => {
  const target = `${API_BASE}/auth/login?mode=${encodeURIComponent(mode)}`;
  window.location.href = target;
};

export const getTasks = async (): Promise<TaskListResponse> => {
  const response = await api.get('/tasks');
  return response.data;
};

export const createTask = async (payload: TaskCreatePayload) => {
  const response = await api.post('/tasks', {
    title: payload.title,
    description: payload.description,
    executor_userid: payload.executorUserId,
    start_time: payload.startTime,
    end_time: payload.endTime,
  });
  return response.data;
};

export const completeTask = async (taskId: number) => {
  const response = await api.post(`/tasks/${taskId}/complete`);
  return response.data;
};

export const verifyTask = async (
  taskId: number,
  action: 'PASS' | 'REJECT',
  rejectReason = ''
) => {
  const response = await api.post(`/tasks/${taskId}/verify`, {
    action,
    reject_reason: rejectReason,
  });
  return response.data;
};

export const syncTasks = async () => {
  const response = await api.post('/tasks/sync');
  return response.data;
};

export const getTaskKpi = async (): Promise<BackendTaskKpi> => {
  const response = await api.get('/tasks/kpi');
  return response.data.kpi;
};

export const getUser = async () => {
  const response = await api.get('/user/me');
  return response.data;
};

export const getUserDetails = async (userId: string) => {
  const response = await api.get(`/users/${userId}`);
  return response.data;
};

export default api;
