import axios from 'axios';
import {
  MenuPermission,
  PaginationMeta,
  PlatformRole,
  SystemDepartmentRow,
  SystemUserRow,
  TaskCreatePayload,
  TaskStatus,
  TeamStatsSnapshot,
} from './types';

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

// BackendTeamMetricRow
// 是什么：团队统计通用后端行模型。
// 做什么：描述角色总览、成员榜单和岗位榜单共用的 snake_case 结构。
// 为什么：前端需要先接收后端原始响应，再统一映射为 camelCase 类型。
interface BackendTeamMetricRow {
  role: 'MANAGER' | 'EXECUTOR';
  user_id?: string;
  user_name?: string;
  position?: string;
  member_count?: number;
  task_count?: number;
  completed_count?: number;
  pending_count?: number;
  waiting_verify_count?: number;
  overdue_count?: number;
  due_soon_count?: number;
  completion_rate?: number;
  on_time_rate?: number;
}

// BackendTeamStatsResponse
// 是什么：团队统计后端返回模型。
// 做什么：描述 `/tasks/team-stats` 响应体中的角色总览、成员列表和岗位列表。
// 为什么：接口响应嵌套较深，需要明确原始结构以便安全映射。
interface BackendTeamStatsResponse {
  team_stats?: {
    summaries?: {
      manager?: BackendTeamMetricRow;
      executor?: BackendTeamMetricRow;
    };
    members?: {
      manager?: BackendTeamMetricRow[];
      executor?: BackendTeamMetricRow[];
    };
    positions?: {
      manager?: BackendTeamMetricRow[];
      executor?: BackendTeamMetricRow[];
    };
  };
}

export interface TaskListResponse {
  tasks: BackendTaskRow[];
  kpi: BackendTaskKpi;
  pagination?: {
    page?: number;
    page_size?: number;
    total?: number;
    total_pages?: number;
  };
}

interface BackendUserProfileResponse {
  userid: string;
  name: string;
  avatar?: string;
  role?: 'MANAGER' | 'EXECUTOR';
  platform_role?: PlatformRole;
  is_admin?: boolean;
  is_super_admin?: boolean;
  menu_permissions?: MenuPermission[];
}

interface BackendSystemUserRow {
  user_id: string;
  name?: string;
  position?: string;
  mobile?: string;
  email?: string;
  alias?: string;
  status?: number;
  main_department?: number;
  main_department_name?: string;
  cal_id?: string;
  calendar_summary?: string;
  calendar_source?: string;
  platform_role?: PlatformRole;
  is_super_admin?: boolean;
  is_admin?: boolean;
  menu_permissions?: MenuPermission[];
  access_source?: string;
  contact_updated_at?: string;
}

interface BackendSystemUsersResponse {
  users?: BackendSystemUserRow[];
  pagination?: {
    page?: number;
    page_size?: number;
    total?: number;
    total_pages?: number;
  };
}

interface BackendSystemDepartmentRow {
  department_id?: number;
  name?: string;
  parent_department_id?: number;
  order_value?: number;
  level?: number;
  member_count?: number;
}

interface BackendSystemDepartmentsResponse {
  departments?: BackendSystemDepartmentRow[];
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

// mapBackendTeamMetricRow
// 是什么：团队统计通用行映射函数。
// 做什么：把后端 snake_case 指标行转换为前端 camelCase 结构。
// 为什么：前端组件应消费统一字段命名，避免界面层散落映射逻辑。
const mapBackendTeamMetricRow = (row: BackendTeamMetricRow) => {
  return {
    role: row.role,
    userId: row.user_id || '',
    userName: row.user_name || '',
    position: row.position || '未设置岗位',
    memberCount: Number(row.member_count || 0),
    taskCount: Number(row.task_count || 0),
    completedCount: Number(row.completed_count || 0),
    pendingCount: Number(row.pending_count || 0),
    waitingVerifyCount: Number(row.waiting_verify_count || 0),
    overdueCount: Number(row.overdue_count || 0),
    dueSoonCount: Number(row.due_soon_count || 0),
    completionRate: Number(row.completion_rate || 0),
    onTimeRate: Number(row.on_time_rate || 0),
  };
};

// getTeamStats
// 是什么：团队统计查询 API。
// 做什么：从后端读取管理岗与执行岗的总览、成员榜单和岗位榜单，并完成字段映射。
// 为什么：团队页需要真实岗位统计数据，不能继续依赖本地按执行人单一聚合。
export const getTeamStats = async (): Promise<TeamStatsSnapshot> => {
  const response = await api.get<BackendTeamStatsResponse>('/tasks/team-stats');
  const teamStats = response.data.team_stats || {};
  const managerSummary = mapBackendTeamMetricRow(teamStats.summaries?.manager || { role: 'MANAGER' });
  const executorSummary = mapBackendTeamMetricRow(teamStats.summaries?.executor || { role: 'EXECUTOR' });

  return {
    summaries: {
      manager: managerSummary,
      executor: executorSummary,
    },
    members: {
      manager: (teamStats.members?.manager || []).map((item) => mapBackendTeamMetricRow(item)),
      executor: (teamStats.members?.executor || []).map((item) => mapBackendTeamMetricRow(item)),
    },
    positions: {
      manager: (teamStats.positions?.manager || []).map((item) => mapBackendTeamMetricRow(item)),
      executor: (teamStats.positions?.executor || []).map((item) => mapBackendTeamMetricRow(item)),
    },
  };
};

export const getUser = async () => {
  const response = await api.get<BackendUserProfileResponse>('/user/me');
  return response.data;
};

export const getUserDetails = async (userId: string) => {
  const response = await api.get(`/users/${userId}`);
  return response.data;
};

// OrgUserProfile
// 是什么：组织成员列表项类型。
// 做什么：承载参与人选择所需的成员基础信息。
// 为什么：参与人面板需要展示姓名、账号和部门信息做筛选与选择。
export interface OrgUserProfile {
  userid: string;
  name?: string;
  position?: string;
  mobile?: string;
  email?: string;
  department?: number[];
  [key: string]: unknown;
}

// mapBackendSystemUserRow
// 是什么：系统管理用户行映射函数。
// 做什么：将后端系统管理页的 snake_case 结构转换为前端 camelCase 类型。
// 为什么：系统管理页表格字段较多，统一映射可避免界面层散落字段清洗。
const mapBackendSystemUserRow = (row: BackendSystemUserRow): SystemUserRow => {
  return {
    userId: row.user_id || '',
    name: row.name || row.user_id || '',
    position: row.position || '',
    mobile: row.mobile || '',
    email: row.email || '',
    alias: row.alias || '',
    status: Number(row.status || 0),
    mainDepartment: Number(row.main_department || 0),
    mainDepartmentName: row.main_department_name || '',
    calId: row.cal_id || '',
    calendarSummary: row.calendar_summary || '',
    calendarSource: row.calendar_source || '',
    platformRole: (row.platform_role || 'EXECUTOR') as PlatformRole,
    isSuperAdmin: Boolean(row.is_super_admin),
    isAdmin: Boolean(row.is_admin),
    menuPermissions: Array.isArray(row.menu_permissions) ? row.menu_permissions : [],
    accessSource: row.access_source || '',
    contactUpdatedAt: row.contact_updated_at || '',
  };
};

// mapBackendSystemDepartmentRow
// 是什么：系统管理部门行映射函数。
// 做什么：将后端部门扁平树节点转换为前端 camelCase 类型。
// 为什么：系统设置页的部门筛选器需要稳定的字段命名，避免视图层直接处理 snake_case。
const mapBackendSystemDepartmentRow = (row: BackendSystemDepartmentRow): SystemDepartmentRow => {
  return {
    departmentId: Number(row.department_id || 0),
    name: row.name || '',
    parentDepartmentId: Number(row.parent_department_id || 0),
    orderValue: Number(row.order_value || 0),
    level: Number(row.level || 0),
    memberCount: Number(row.member_count || 0),
  };
};

// mapBackendPagination
// 是什么：分页元信息映射函数。
// 做什么：将后端分页结构统一转换为前端 camelCase 字段。
// 为什么：任务列表和系统管理页都需要复用一致的分页元信息模型。
const mapBackendPagination = (pagination: BackendSystemUsersResponse['pagination']): PaginationMeta => {
  return {
    page: Number(pagination?.page || 1),
    pageSize: Number(pagination?.page_size || 20),
    total: Number(pagination?.total || 0),
    totalPages: Number(pagination?.total_pages || 1),
  };
};

// getSystemUsers
// 是什么：系统管理成员列表查询 API。
// 做什么：读取通讯录快照与平台角色配置的汇总数据，并支持分页与筛选。
// 为什么：系统管理页需要拉全量成员后再做管理员/执行对象分配。
export const getSystemUsers = async (options: {
  keyword?: string;
  platformRole?: PlatformRole | '';
  departmentId?: number;
  page?: number;
  pageSize?: number;
} = {}): Promise<{ users: SystemUserRow[]; pagination: PaginationMeta }> => {
  const response = await api.get<BackendSystemUsersResponse>('/system/users', {
    params: {
      keyword: options.keyword || undefined,
      platform_role: options.platformRole || undefined,
      department_id: options.departmentId || undefined,
      fetch_child: options.departmentId ? 1 : undefined,
      page: options.page || 1,
      page_size: options.pageSize || 20,
    },
  });

  return {
    users: (response.data.users || []).map((item) => mapBackendSystemUserRow(item)),
    pagination: mapBackendPagination(response.data.pagination),
  };
};

// getSystemDepartments
// 是什么：系统管理部门列表查询 API。
// 做什么：读取本地通讯录部门树的扁平节点列表，供系统设置页做部门筛选。
// 为什么：管理员需要按部门快速筛选通讯录成员，而不是只靠关键字检索。
export const getSystemDepartments = async (): Promise<SystemDepartmentRow[]> => {
  const response = await api.get<BackendSystemDepartmentsResponse>('/system/departments');
  return (response.data.departments || []).map((item) => mapBackendSystemDepartmentRow(item));
};

// pullSystemContacts
// 是什么：系统通讯录刷新 API。
// 做什么：触发后端从企微全量拉取成员并刷新本地快照。
// 为什么：角色分配必须基于最新通讯录成员，而不是过期缓存。
export const pullSystemContacts = async () => {
  const response = await api.post('/system/contacts/pull');
  return response.data;
};

// updateSystemUserRole
// 是什么：平台角色更新 API。
// 做什么：由超级管理员为指定成员分配管理员或执行对象角色。
// 为什么：系统管理页需要直接完成平台权限收口，而不是依赖环境变量。
export const updateSystemUserRole = async (userId: string, platformRole: Exclude<PlatformRole, 'SUPER_ADMIN'>) => {
  const response = await api.post(`/system/users/${encodeURIComponent(userId)}/role`, {
    platform_role: platformRole,
  });
  return response.data;
};

// updateSystemUserMenuPermissions
// 是什么：管理员菜单权限更新 API。
// 做什么：由超级管理员为指定管理员写入菜单权限集合。
// 为什么：系统设置页需要把“菜单管理”从固定角色映射升级为按人配置。
export const updateSystemUserMenuPermissions = async (userId: string, menuPermissions: MenuPermission[]) => {
  const response = await api.post(`/system/users/${encodeURIComponent(userId)}/menu-permissions`, {
    menu_permissions: menuPermissions,
  });
  return response.data;
};

// OrgUsersResponse
// 是什么：组织成员接口响应类型。
// 做什么：承载实时查询与本地缓存降级两种返回模式。
// 为什么：日历页需要识别 `degraded/source`，在网络异常时给出可继续操作的提示。
export interface OrgUsersResponse {
  errcode?: number;
  errmsg?: string;
  userlist?: OrgUserProfile[];
  degraded?: boolean;
  source?: string;
  degrade_reason?: string;
}

// getOrgUsers
// 是什么：组织成员列表查询 API。
// 做什么：按部门读取企业微信组织成员，默认读取根部门并递归子部门。
// 为什么：参与人管理需要可选的组织成员全集，不依赖手工输入 user_id。
export const getOrgUsers = async (
  options: {
    department_id?: number;
    fetch_child?: 0 | 1;
    status?: number;
  } = {}
): Promise<OrgUsersResponse> => {
  const response = await api.get('/users', {
    params: {
      department_id: options.department_id ?? 1,
      fetch_child: options.fetch_child ?? 1,
      status: options.status ?? 0,
    },
  });
  return response.data;
};

// WecomApiResult
// 是什么：企业微信网关接口通用返回类型。
// 做什么：统一描述 errcode/errmsg 结构，便于页面对齐提示逻辑。
// 为什么：不同接口返回字段不完全一致，但错误处理基于同一核心字段。
export interface WecomApiResult {
  errcode?: number;
  errmsg?: string;
  [key: string]: unknown;
}

// CalendarMappingRow
// 是什么：用户与日历绑定关系的前端类型定义。
// 做什么：描述 `/api/calendar/mappings` 返回行结构。
// 为什么：管理页需要展示映射状态并辅助定位账号绑定问题。
export interface CalendarMappingRow {
  user_id: string;
  cal_id: string;
  calendar_summary?: string;
  source?: string;
  created_at?: string;
  updated_at?: string;
}

// CreateCalendarRequest
// 是什么：创建日历接口请求类型。
// 做什么：支持完整 calendar 对象透传与账号绑定参数。
// 为什么：兼容“纯接口字段”与“页面快速建历”两种输入模式。
export interface CreateCalendarRequest {
  calendar?: Record<string, unknown>;
  summary?: string;
  color?: string;
  description?: string;
  agentid?: number;
  bind_user_id?: string;
  bind_user_name?: string;
  source?: string;
}

// UpdateCalendarRequest
// 是什么：更新日历接口请求类型。
// 做什么：承载覆盖更新参数与 `skip_public_range` 开关。
// 为什么：企微日历更新为覆盖式，需完整表达请求体结构。
export interface UpdateCalendarRequest {
  calendar?: Record<string, unknown>;
  skip_public_range?: number;
}

// CreateScheduleRequest
// 是什么：创建日程接口请求类型。
// 做什么：支持直接传 schedule 对象或扁平字段。
// 为什么：前端页面会同时支持简化表单与高级 JSON 输入两种创建模式。
export interface CreateScheduleRequest {
  schedule?: Record<string, unknown>;
  [key: string]: unknown;
}

// UpdateScheduleRequest
// 是什么：更新日程接口请求类型。
// 做什么：表达 schedule 与重复日程控制参数。
// 为什么：需覆盖 `op_mode/op_start_time/skip_attendees` 等扩展能力。
export interface UpdateScheduleRequest {
  schedule?: Record<string, unknown>;
  skip_attendees?: number;
  op_mode?: number;
  op_start_time?: number;
}

// CancelScheduleRequest
// 是什么：取消日程接口请求类型。
// 做什么：支持重复日程取消模式参数透传。
// 为什么：`schedule/del` 在重复日程场景需 `op_mode/op_start_time` 才能精确操作。
export interface CancelScheduleRequest {
  op_mode?: number;
  op_start_time?: number;
}

// getCalendarMappings
// 是什么：日历映射查询 API。
// 做什么：读取后端已绑定的用户与 cal_id 列表。
// 为什么：页面需展示当前绑定状态并支持联调排障。
export const getCalendarMappings = async (): Promise<{ mappings: CalendarMappingRow[] }> => {
  const response = await api.get('/calendar/mappings', {
    params: {
      _ts: Date.now(),
    },
    headers: {
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
    },
  });
  return response.data;
};

// ensureUserCalendar
// 是什么：用户日历确保 API。
// 做什么：按用户触发“已存在复用，不存在自动创建”逻辑。
// 为什么：满足登录自动建历与管理页手动触发双场景。
export const ensureUserCalendar = async (payload: {
  user_id?: string;
  user_name?: string;
  source?: string;
}): Promise<WecomApiResult> => {
  const response = await api.post('/calendar/ensure', payload);
  return response.data;
};

// createCalendar
// 是什么：创建日历 API。
// 做什么：调用后端网关创建企业微信日历并返回结果。
// 为什么：前端不直接拼接企微接口，统一由后端托管鉴权与请求细节。
export const createCalendar = async (payload: CreateCalendarRequest): Promise<WecomApiResult> => {
  const response = await api.post('/calendar/create', payload);
  return response.data;
};

// getCalendars
// 是什么：批量获取日历详情 API。
// 做什么：按 `cal_id_list` 查询日历详情。
// 为什么：用于创建后校验、更新前回显和映射排查。
export const getCalendars = async (calIdList: string[]): Promise<WecomApiResult> => {
  const response = await api.post('/calendar/get', {
    cal_id_list: calIdList,
  });
  return response.data;
};

// updateCalendar
// 是什么：更新日历 API。
// 做什么：按 cal_id 调用覆盖更新接口。
// 为什么：页面需要对现有日历做描述、共享范围等维护。
export const updateCalendar = async (
  calId: string,
  payload: UpdateCalendarRequest
): Promise<WecomApiResult> => {
  const response = await api.put(`/calendar/${encodeURIComponent(calId)}`, payload);
  return response.data;
};

// deleteCalendar
// 是什么：删除日历 API。
// 做什么：删除指定 cal_id 并清理映射。
// 为什么：无效测试日历或迁移场景需要回收能力。
export const deleteCalendar = async (calId: string): Promise<WecomApiResult> => {
  const response = await api.delete(`/calendar/${encodeURIComponent(calId)}`);
  return response.data;
};

// getCalendarSchedules
// 是什么：按日历获取日程列表 API。
// 做什么：支持 offset/limit 分页读取日程。
// 为什么：企微列表接口分页拉取是日程同步与核验的基础能力。
export const getCalendarSchedules = async (
  calId: string,
  options: { offset?: number; limit?: number } = {}
): Promise<WecomApiResult> => {
  const response = await api.get(`/calendar/${encodeURIComponent(calId)}/schedules`, {
    params: {
      offset: options.offset,
      limit: options.limit,
    },
  });
  return response.data;
};

// createSchedule
// 是什么：创建日程 API。
// 做什么：将日程参数提交给后端网关并返回 schedule_id。
// 为什么：管理页需支持手工建日程与联调验证。
export const createSchedule = async (payload: CreateScheduleRequest): Promise<WecomApiResult> => {
  const response = await api.post('/schedule/create', payload);
  return response.data;
};

// getSchedules
// 是什么：批量获取日程详情 API。
// 做什么：按 `schedule_id_list` 查询日程详情。
// 为什么：避免逐条调用详情接口，提升页面联调效率。
export const getSchedules = async (scheduleIdList: string[]): Promise<WecomApiResult> => {
  const response = await api.post('/schedule/get', {
    schedule_id_list: scheduleIdList,
  });
  return response.data;
};

// updateSchedule
// 是什么：更新日程 API。
// 做什么：按 schedule_id 覆盖更新日程属性。
// 为什么：支持标题/时间/重复规则等维护动作。
export const updateSchedule = async (
  scheduleId: string,
  payload: UpdateScheduleRequest
): Promise<WecomApiResult> => {
  const response = await api.put(`/schedule/${encodeURIComponent(scheduleId)}`, payload);
  return response.data;
};

// cancelSchedule
// 是什么：取消日程 API。
// 做什么：按 schedule_id 调用取消接口，支持重复日程操作模式。
// 为什么：管理页需要“终止日程”闭环能力。
export const cancelSchedule = async (
  scheduleId: string,
  payload: CancelScheduleRequest = {}
): Promise<WecomApiResult> => {
  const response = await api.delete(`/schedule/${encodeURIComponent(scheduleId)}`, {
    data: payload,
  });
  return response.data;
};

// addScheduleAttendees
// 是什么：新增日程参与人 API。
// 做什么：以增量方式追加参与人。
// 为什么：避免覆盖式更新导致并发冲突。
export const addScheduleAttendees = async (
  scheduleId: string,
  attendees: Array<{ userid: string }>
): Promise<WecomApiResult> => {
  const response = await api.post(`/schedule/${encodeURIComponent(scheduleId)}/attendees/add`, {
    attendees,
  });
  return response.data;
};

// removeScheduleAttendees
// 是什么：删除日程参与人 API。
// 做什么：以增量方式移除参与人。
// 为什么：与新增参与人接口配对，形成完整参与人维护能力。
export const removeScheduleAttendees = async (
  scheduleId: string,
  attendees: Array<{ userid: string }>
): Promise<WecomApiResult> => {
  const response = await api.post(`/schedule/${encodeURIComponent(scheduleId)}/attendees/del`, {
    attendees,
  });
  return response.data;
};

export default api;
