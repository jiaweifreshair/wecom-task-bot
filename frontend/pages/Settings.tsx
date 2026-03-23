import React, { useEffect, useMemo, useState } from 'react';
import { Bell, Globe, Save, ShieldCheck, RefreshCw, Users2 } from 'lucide-react';
import {
  getSystemDepartments,
  getSystemUsers,
  pullSystemContacts,
  updateSystemUserMenuPermissions,
  updateSystemUserRole,
} from '../api';
import { MenuPermission, PlatformRole, SystemDepartmentRow, SystemUserRow, User } from '../types';
import { useTranslation } from '../contexts/LanguageContext';

interface SettingsProps {
  onSyncTasks: () => Promise<void>;
  currentUser: User;
}

interface SettingsState {
  autoSyncEnabled: boolean;
  notificationEnabled: boolean;
  preferredLanguage: 'zh' | 'en';
}

interface SystemUserListState {
  rows: SystemUserRow[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

const STORAGE_KEY = 'wecom-task-bot-settings';

// SYSTEM_ACCESS_MENU_OPTIONS
// 是什么：系统管理菜单权限可选项常量。
// 做什么：定义管理员菜单编辑器中允许勾选的菜单顺序。
// 为什么：菜单权限需要稳定顺序，便于比较草稿状态和保持界面一致性。
const SYSTEM_ACCESS_MENU_OPTIONS: MenuPermission[] = [
  'DASHBOARD',
  'TASKS',
  'CALENDAR',
  'TEAM_STATS',
  'SETTINGS',
];

// createEmptySystemUserListState
// 是什么：系统管理成员列表空状态工厂函数。
// 做什么：返回带默认分页的空列表结构，便于页面初始化与失败回退。
// 为什么：系统设置页含通讯录与角色配置模块，需要稳定的初始渲染结构。
const createEmptySystemUserListState = (): SystemUserListState => ({
  rows: [],
  page: 1,
  pageSize: 10,
  total: 0,
  totalPages: 1,
});

// sortMenuPermissionsByDisplayOrder
// 是什么：菜单权限展示顺序标准化函数。
// 做什么：按预定义菜单顺序输出去重后的菜单列表。
// 为什么：菜单草稿比较、展示和保存都需要稳定顺序，避免数组顺序不同造成误判。
const sortMenuPermissionsByDisplayOrder = (menuPermissions: MenuPermission[]): MenuPermission[] => {
  const normalizedSet = new Set((Array.isArray(menuPermissions) ? menuPermissions : []).filter(Boolean));
  return SYSTEM_ACCESS_MENU_OPTIONS.filter((permission) => normalizedSet.has(permission));
};

// areMenuPermissionsEqual
// 是什么：菜单权限数组等价比较函数。
// 做什么：忽略原始顺序差异，判断两组菜单集合是否一致。
// 为什么：系统设置页需要判断菜单草稿是否变更，从而控制“保存菜单”按钮状态。
const areMenuPermissionsEqual = (
  leftMenuPermissions: MenuPermission[],
  rightMenuPermissions: MenuPermission[]
): boolean => {
  const leftSorted = sortMenuPermissionsByDisplayOrder(leftMenuPermissions);
  const rightSorted = sortMenuPermissionsByDisplayOrder(rightMenuPermissions);

  if (leftSorted.length !== rightSorted.length) {
    return false;
  }

  return leftSorted.every((permission, index) => permission === rightSorted[index]);
};

// buildDepartmentOptionLabel
// 是什么：部门筛选选项文案构建函数。
// 做什么：根据部门层级输出带缩进和成员数的展示文案。
// 为什么：系统设置页需要在原生下拉框中直观表达部门树层级关系。
const buildDepartmentOptionLabel = (department: SystemDepartmentRow): string => {
  const indentPrefix = department.level > 0 ? `${'　'.repeat(department.level)}` : '';
  const memberCountSuffix = department.memberCount > 0 ? ` (${department.memberCount})` : '';
  return `${indentPrefix}${department.name}${memberCountSuffix}`;
};

// readSavedSettings
// 是什么：本地设置读取函数。
// 做什么：从 localStorage 读取并清洗系统设置页持久化的用户偏好。
// 为什么：初始化恢复与运行中状态同步应共用同一份解析逻辑，避免页面各处各自猜测存储结构。
const readSavedSettings = (): SettingsState | null => {
  const savedText = localStorage.getItem(STORAGE_KEY);
  if (!savedText) {
    return null;
  }

  try {
    const parsed = JSON.parse(savedText) as SettingsState;
    return {
      autoSyncEnabled: Boolean(parsed.autoSyncEnabled),
      notificationEnabled: Boolean(parsed.notificationEnabled),
      preferredLanguage: parsed.preferredLanguage === 'en' ? 'en' : 'zh',
    };
  } catch (error) {
    console.error(error);
    return null;
  }
};

const SettingsPage: React.FC<SettingsProps> = ({ onSyncTasks, currentUser }) => {
  const { t, language, setLanguage } = useTranslation();
  const [saving, setSaving] = useState(false);
  const [manualSyncing, setManualSyncing] = useState(false);
  const [pullingContacts, setPullingContacts] = useState(false);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [loadingDepartments, setLoadingDepartments] = useState(false);
  const [savingMenuUserId, setSavingMenuUserId] = useState('');
  const [systemUsers, setSystemUsers] = useState<SystemUserListState>(() => createEmptySystemUserListState());
  const [systemDepartments, setSystemDepartments] = useState<SystemDepartmentRow[]>([]);
  const [menuDrafts, setMenuDrafts] = useState<Record<string, MenuPermission[]>>({});
  const [accessKeyword, setAccessKeyword] = useState('');
  const [accessRoleFilter, setAccessRoleFilter] = useState<PlatformRole | ''>('');
  const [accessDepartmentId, setAccessDepartmentId] = useState<number | ''>('');
  const [feedbackText, setFeedbackText] = useState('');
  const [settings, setSettings] = useState<SettingsState>({
    autoSyncEnabled: true,
    notificationEnabled: true,
    preferredLanguage: language,
  });

  useEffect(() => {
    const savedSettings = readSavedSettings();
    if (!savedSettings) {
      setSettings((prev) => ({ ...prev, preferredLanguage: language }));
      return;
    }

    setSettings(savedSettings);
    if (savedSettings.preferredLanguage !== language) {
      setLanguage(savedSettings.preferredLanguage);
    }
  }, [setLanguage]);

  useEffect(() => {
    setSettings((prev) => {
      if (prev.preferredLanguage === language) {
        return prev;
      }

      return {
        ...prev,
        preferredLanguage: language,
      };
    });
  }, [language]);

  // loadSystemDepartments
  // 是什么：系统管理部门树加载函数。
  // 做什么：读取本地通讯录部门快照并刷新部门筛选下拉框。
  // 为什么：管理员需要先按部门定位成员，才能高效做角色和菜单配置。
  const loadSystemDepartments = async () => {
    try {
      setLoadingDepartments(true);
      const departments = await getSystemDepartments();
      setSystemDepartments(departments);
    } catch (error) {
      console.error(error);
      setFeedbackText(t.systemDepartmentLoadFailed);
      setSystemDepartments([]);
    } finally {
      setLoadingDepartments(false);
    }
  };

  // loadSystemUsers
  // 是什么：系统管理成员列表加载函数。
  // 做什么：读取本地通讯录、部门筛选和平台角色配置的聚合结果，并同步菜单草稿状态。
  // 为什么：角色分配与菜单裁剪是系统设置核心入口，必须在筛选后稳定刷新结果。
  const loadSystemUsers = async (page = systemUsers.page, pageSize = systemUsers.pageSize) => {
    try {
      setLoadingUsers(true);
      const result = await getSystemUsers({
        keyword: accessKeyword,
        platformRole: accessRoleFilter,
        departmentId: accessDepartmentId === '' ? undefined : Number(accessDepartmentId),
        page,
        pageSize,
      });
      setSystemUsers({
        rows: result.users,
        page: result.pagination.page,
        pageSize: result.pagination.pageSize,
        total: result.pagination.total,
        totalPages: result.pagination.totalPages,
      });
      setMenuDrafts(() => {
        const nextDrafts: Record<string, MenuPermission[]> = {};
        result.users.forEach((row) => {
          nextDrafts[row.userId] = sortMenuPermissionsByDisplayOrder(row.menuPermissions);
        });
        return nextDrafts;
      });
    } catch (error) {
      console.error(error);
      setFeedbackText(t.systemUsersLoadFailed);
      setSystemUsers((prev) => ({ ...prev, rows: [] }));
      setMenuDrafts({});
    } finally {
      setLoadingUsers(false);
    }
  };

  useEffect(() => {
    loadSystemDepartments().catch(() => undefined);
  }, []);

  useEffect(() => {
    loadSystemUsers(1, systemUsers.pageSize).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessKeyword, accessRoleFilter, accessDepartmentId]);

  // getMenuPermissionLabel
  // 是什么：菜单键转展示文案函数。
  // 做什么：把菜单权限标识映射为当前语言下的用户可读名称。
  // 为什么：系统设置页应展示业务术语，而不是直接暴露内部枚举值。
  const getMenuPermissionLabel = (menuPermission: MenuPermission) => {
    if (menuPermission === 'DASHBOARD') {
      return t.dashboard;
    }
    if (menuPermission === 'TASKS') {
      return t.taskList;
    }
    if (menuPermission === 'CALENDAR') {
      return t.calendarManage;
    }
    if (menuPermission === 'TEAM_STATS') {
      return t.teamStats;
    }
    return t.settings;
  };

  // toggleMenuDraft
  // 是什么：管理员菜单草稿切换函数。
  // 做什么：对指定管理员的菜单草稿增删某个菜单键，并保持统一顺序。
  // 为什么：菜单编辑器需要本地草稿层，避免用户每勾选一次就直接请求后端。
  const toggleMenuDraft = (row: SystemUserRow, menuPermission: MenuPermission) => {
    setMenuDrafts((prev) => {
      const currentDraft = sortMenuPermissionsByDisplayOrder(
        (prev[row.userId] || row.menuPermissions) as MenuPermission[]
      );
      const nextDraft = currentDraft.includes(menuPermission)
        ? currentDraft.filter((item) => item !== menuPermission)
        : sortMenuPermissionsByDisplayOrder([...currentDraft, menuPermission]);

      return {
        ...prev,
        [row.userId]: nextDraft,
      };
    });
  };

  // saveSettings
  // 是什么：本地偏好保存函数。
  // 做什么：将显示与提醒偏好写入浏览器本地存储，并同步语言设置。
  // 为什么：系统设置页除了权限管理外，还承载当前用户的个性化设置。
  const saveSettings = async () => {
    try {
      setSaving(true);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
      setLanguage(settings.preferredLanguage);
      setFeedbackText(t.settingsSaved);
    } finally {
      setSaving(false);
    }
  };

  // triggerManualSync
  // 是什么：手动同步触发函数。
  // 做什么：调用上层同步逻辑刷新企微任务，并反馈执行结果。
  // 为什么：系统设置页承载运维操作入口，需要显式触发全量同步。
  const triggerManualSync = async () => {
    try {
      setManualSyncing(true);
      await onSyncTasks();
      setFeedbackText(t.settingsTaskSyncSuccess);
    } catch (error) {
      console.error(error);
      setFeedbackText(t.operationFailed);
    } finally {
      setManualSyncing(false);
    }
  };

  // triggerContactPull
  // 是什么：全量通讯录拉取函数。
  // 做什么：触发后端刷新本地通讯录快照，并在成功后同步刷新部门与成员列表。
  // 为什么：部门树和角色分配都依赖本地快照，刷新通讯录后必须立即反映到页面。
  const triggerContactPull = async () => {
    try {
      setPullingContacts(true);
      const result = await pullSystemContacts();
      if (result && result.success) {
        setFeedbackText(
          t.systemContactPullSuccess.replace('{count}', String(Number(result.synced_count || 0)))
        );
        await loadSystemDepartments();
        await loadSystemUsers(1, systemUsers.pageSize);
        return;
      }

      setFeedbackText(String(result?.errmsg || t.systemContactPullFailed));
    } catch (error) {
      console.error(error);
      setFeedbackText(t.systemContactPullFailed);
    } finally {
      setPullingContacts(false);
    }
  };

  // handleRoleUpdate
  // 是什么：平台角色更新函数。
  // 做什么：由超级管理员为指定成员切换管理员或执行对象角色，并刷新当前页。
  // 为什么：角色变更会直接影响数据权限与菜单边界，需要以服务端结果为准重新加载。
  const handleRoleUpdate = async (row: SystemUserRow, nextRole: Exclude<PlatformRole, 'SUPER_ADMIN'>) => {
    try {
      await updateSystemUserRole(row.userId, nextRole);
      setFeedbackText(
        t.systemRoleUpdateSuccess
          .replace('{name}', row.name || row.userId)
          .replace('{role}', nextRole === 'ADMIN' ? t.platformRoleAdmin : t.platformRoleExecutor)
      );
      await loadSystemUsers(systemUsers.page, systemUsers.pageSize);
    } catch (error) {
      console.error(error);
      setFeedbackText(t.systemRoleUpdateFailed);
    }
  };

  // handleMenuPermissionsSave
  // 是什么：管理员菜单权限保存函数。
  // 做什么：把当前行的菜单草稿提交给后端，并在成功后刷新当前页数据。
  // 为什么：菜单权限属于系统级配置，必须持久化后再以服务端结果回填界面。
  const handleMenuPermissionsSave = async (row: SystemUserRow) => {
    const menuDraft = sortMenuPermissionsByDisplayOrder(
      (menuDrafts[row.userId] || row.menuPermissions) as MenuPermission[]
    );

    if (menuDraft.length === 0) {
      setFeedbackText(t.systemMenuUpdateFailed);
      return;
    }

    try {
      setSavingMenuUserId(row.userId);
      await updateSystemUserMenuPermissions(row.userId, menuDraft);
      setFeedbackText(
        t.systemMenuUpdateSuccess.replace('{name}', row.name || row.userId)
      );
      await loadSystemUsers(systemUsers.page, systemUsers.pageSize);
    } catch (error) {
      console.error(error);
      setFeedbackText(t.systemMenuUpdateFailed);
    } finally {
      setSavingMenuUserId('');
    }
  };

  const adminCount = useMemo(
    () => systemUsers.rows.filter((item) => item.platformRole === 'ADMIN' || item.platformRole === 'SUPER_ADMIN').length,
    [systemUsers.rows]
  );
  const executorCount = useMemo(
    () => systemUsers.rows.filter((item) => item.platformRole === 'EXECUTOR').length,
    [systemUsers.rows]
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">{t.settingsTitle}</h1>
        <p className="text-sm text-slate-500 mt-1">{t.settingsDesc}</p>
      </div>

      {feedbackText && (
        <div className="rounded-xl border border-blue-100 bg-blue-50 px-4 py-3 text-sm text-blue-700">
          {feedbackText}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
          <h2 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
            <Bell className="w-5 h-5 text-amber-500" />
            {t.settingsNotification}
          </h2>

          <label className="flex items-center justify-between text-sm text-slate-700">
            <span>{t.settingsTaskReminderToggle}</span>
            <input
              type="checkbox"
              checked={settings.notificationEnabled}
              onChange={(event) =>
                setSettings((prev) => ({
                  ...prev,
                  notificationEnabled: event.target.checked,
                }))
              }
              className="w-4 h-4"
            />
          </label>

          <label className="flex items-center justify-between text-sm text-slate-700">
            <span>{t.settingsAutoSyncToggle}</span>
            <input
              type="checkbox"
              checked={settings.autoSyncEnabled}
              onChange={(event) =>
                setSettings((prev) => ({
                  ...prev,
                  autoSyncEnabled: event.target.checked,
                }))
              }
              className="w-4 h-4"
            />
          </label>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
          <h2 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
            <Globe className="w-5 h-5 text-blue-500" />
            {t.settingsDisplay}
          </h2>

          <label className="block text-sm text-slate-700">
            <span className="block mb-2">{t.settingsLanguage}</span>
            <select
              value={settings.preferredLanguage}
              onChange={(event) => {
                const nextLang = event.target.value === 'en' ? 'en' : 'zh';
                setSettings((prev) => ({ ...prev, preferredLanguage: nextLang }));
                setLanguage(nextLang);
              }}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
            >
              <option value="zh">中文</option>
              <option value="en">English</option>
            </select>
          </label>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
        <h2 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
          <ShieldCheck className="w-5 h-5 text-emerald-500" />
          {t.settingsOperations}
        </h2>

        <div className="flex flex-wrap gap-3">
          <button
            onClick={triggerManualSync}
            disabled={manualSyncing}
            className="px-4 py-2 bg-slate-900 hover:bg-slate-800 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
          >
            {manualSyncing ? t.syncing : t.settingsManualSync}
          </button>

          <button
            onClick={triggerContactPull}
            disabled={pullingContacts}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50 flex items-center gap-2"
          >
            <RefreshCw className={`w-4 h-4 ${pullingContacts ? 'animate-spin' : ''}`} />
            {pullingContacts ? t.systemContactPulling : t.systemContactPull}
          </button>

          <button
            onClick={saveSettings}
            disabled={saving}
            className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-900 text-sm font-medium rounded-lg transition-colors disabled:opacity-50 flex items-center gap-2"
          >
            <Save className="w-4 h-4" />
            {saving ? t.saving : t.saveSettings}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-sm text-slate-500">{t.systemCurrentOperator}</p>
          <p className="text-xl font-semibold text-slate-900 mt-2">{currentUser.name}</p>
          <p className="text-sm text-slate-500 mt-1">
            {currentUser.isSuperAdmin ? t.platformRoleSuperAdmin : currentUser.isAdmin ? t.platformRoleAdmin : t.platformRoleExecutor}
          </p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-sm text-slate-500">{t.systemAdminCount}</p>
          <p className="text-xl font-semibold text-slate-900 mt-2">{adminCount}</p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-sm text-slate-500">{t.systemExecutorCount}</p>
          <p className="text-xl font-semibold text-slate-900 mt-2">{executorCount}</p>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
              <Users2 className="w-5 h-5 text-blue-500" />
              {t.systemAccessTitle}
            </h2>
            <p className="text-sm text-slate-500 mt-1">{t.systemAccessDesc}</p>
            <p className="text-xs text-slate-400 mt-2">{t.systemAccessMenuHintAdmin}</p>
          </div>
          <div className="text-xs text-slate-500">
            {currentUser.isSuperAdmin ? t.systemRoleManageEnabled : t.systemRoleManageReadonly}
          </div>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.6fr)_minmax(220px,1fr)_minmax(180px,220px)] gap-3">
          <input
            value={accessKeyword}
            onChange={(event) => setAccessKeyword(event.target.value)}
            placeholder={t.systemAccessSearchPlaceholder}
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
          />
          <select
            value={accessDepartmentId === '' ? '' : String(accessDepartmentId)}
            onChange={(event) => setAccessDepartmentId(event.target.value ? Number(event.target.value) : '')}
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
            disabled={loadingDepartments}
          >
            <option value="">{t.systemAccessDepartmentFilterAll}</option>
            {systemDepartments.map((department) => (
              <option key={department.departmentId} value={department.departmentId}>
                {buildDepartmentOptionLabel(department)}
              </option>
            ))}
          </select>
          <select
            value={accessRoleFilter}
            onChange={(event) => setAccessRoleFilter((event.target.value || '') as PlatformRole | '')}
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
          >
            <option value="">{t.systemAccessRoleAll}</option>
            <option value="ADMIN">{t.platformRoleAdmin}</option>
            <option value="EXECUTOR">{t.platformRoleExecutor}</option>
          </select>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[1220px]">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="text-left px-4 py-3 font-medium">{t.systemAccessUser}</th>
                <th className="text-left px-4 py-3 font-medium">{t.systemAccessDepartment}</th>
                <th className="text-left px-4 py-3 font-medium">{t.systemAccessPosition}</th>
                <th className="text-left px-4 py-3 font-medium">{t.systemAccessCalendar}</th>
                <th className="text-left px-4 py-3 font-medium">{t.systemAccessRole}</th>
                <th className="text-left px-4 py-3 font-medium">{t.systemAccessMenus}</th>
                <th className="text-left px-4 py-3 font-medium">{t.systemAccessAction}</th>
              </tr>
            </thead>
            <tbody>
              {loadingUsers ? (
                <tr>
                  <td className="px-4 py-8 text-slate-400" colSpan={7}>
                    {t.systemUsersLoading}
                  </td>
                </tr>
              ) : systemUsers.rows.length === 0 ? (
                <tr>
                  <td className="px-4 py-8 text-slate-400" colSpan={7}>
                    {t.systemUsersEmpty}
                  </td>
                </tr>
              ) : (
                systemUsers.rows.map((row) => {
                  const menuDraft = sortMenuPermissionsByDisplayOrder(
                    (menuDrafts[row.userId] || row.menuPermissions) as MenuPermission[]
                  );
                  const menuDraftChanged = !areMenuPermissionsEqual(menuDraft, row.menuPermissions);
                  const isSavingMenus = savingMenuUserId === row.userId;
                  const isEditableAdminMenus = currentUser.isSuperAdmin && row.platformRole === 'ADMIN' && !row.isSuperAdmin;
                  const translatedMenuLabels = sortMenuPermissionsByDisplayOrder(row.menuPermissions)
                    .map((permission) => getMenuPermissionLabel(permission))
                    .join(' / ');

                  return (
                    <tr key={row.userId} className="border-t border-slate-100 align-top">
                      <td className="px-4 py-3">
                        <div className="font-medium text-slate-900">{row.name || row.userId}</div>
                        <div className="text-xs text-slate-500 mt-1">{row.userId}</div>
                      </td>
                      <td className="px-4 py-3 text-slate-600">
                        {row.mainDepartmentName || row.mainDepartment || '-'}
                      </td>
                      <td className="px-4 py-3 text-slate-600">{row.position || '-'}</td>
                      <td className="px-4 py-3 text-slate-600">{row.calendarSummary || row.calId || '-'}</td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700">
                          {row.isSuperAdmin
                            ? t.platformRoleSuperAdmin
                            : row.platformRole === 'ADMIN'
                            ? t.platformRoleAdmin
                            : t.platformRoleExecutor}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-slate-600">
                        {row.isSuperAdmin ? (
                          <div className="space-y-2">
                            <div>{translatedMenuLabels}</div>
                            <div className="text-xs text-slate-400">{t.systemAccessMenuReadonlySuperAdmin}</div>
                          </div>
                        ) : row.platformRole === 'EXECUTOR' ? (
                          <div className="space-y-2">
                            <div>
                              {getMenuPermissionLabel('TASKS')} / {getMenuPermissionLabel('CALENDAR')}
                            </div>
                            <div className="text-xs text-slate-400">{t.systemAccessMenuReadonlyExecutor}</div>
                          </div>
                        ) : isEditableAdminMenus ? (
                          <div className="space-y-3">
                            <div className="flex flex-wrap gap-2">
                              {SYSTEM_ACCESS_MENU_OPTIONS.map((menuPermission) => (
                                <label
                                  key={`${row.userId}-${menuPermission}`}
                                  className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-700"
                                >
                                  <input
                                    type="checkbox"
                                    checked={menuDraft.includes(menuPermission)}
                                    onChange={() => toggleMenuDraft(row, menuPermission)}
                                    className="w-3.5 h-3.5"
                                  />
                                  <span>{getMenuPermissionLabel(menuPermission)}</span>
                                </label>
                              ))}
                            </div>
                            <div className="flex items-center gap-3">
                              <button
                                onClick={() => handleMenuPermissionsSave(row)}
                                disabled={isSavingMenus || !menuDraftChanged || menuDraft.length === 0}
                                className="px-3 py-1.5 rounded-lg bg-slate-900 text-white text-xs font-medium disabled:opacity-50"
                              >
                                {isSavingMenus ? t.systemAccessMenuSaving : t.systemAccessMenuSave}
                              </button>
                              {menuDraft.length === 0 && (
                                <span className="text-xs text-red-500">{t.systemMenuUpdateFailed}</span>
                              )}
                            </div>
                          </div>
                        ) : (
                          <div>{translatedMenuLabels || '-'}</div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {row.isSuperAdmin ? (
                          <span className="text-xs text-slate-400">{t.systemRoleFixedHint}</span>
                        ) : (
                          <select
                            value={row.platformRole}
                            disabled={!currentUser.isSuperAdmin}
                            onChange={(event) =>
                              handleRoleUpdate(
                                row,
                                (event.target.value === 'ADMIN' ? 'ADMIN' : 'EXECUTOR') as Exclude<PlatformRole, 'SUPER_ADMIN'>
                              )
                            }
                            className="px-3 py-2 border border-slate-300 rounded-lg text-sm disabled:bg-slate-100 disabled:text-slate-400"
                          >
                            <option value="ADMIN">{t.platformRoleAdmin}</option>
                            <option value="EXECUTOR">{t.platformRoleExecutor}</option>
                          </select>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div className="text-sm text-slate-500">
            {t.taskPaginationSummary
              .replace('{start}', String(systemUsers.total === 0 ? 0 : (systemUsers.page - 1) * systemUsers.pageSize + 1))
              .replace('{end}', String(Math.min(systemUsers.page * systemUsers.pageSize, systemUsers.total)))
              .replace('{total}', String(systemUsers.total))}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => loadSystemUsers(Math.max(1, systemUsers.page - 1), systemUsers.pageSize)}
              disabled={systemUsers.page <= 1 || loadingUsers}
              className="px-3 py-2 border border-slate-300 rounded-lg text-sm disabled:opacity-50"
            >
              {t.prevPage}
            </button>
            <span className="text-sm text-slate-600 min-w-[84px] text-center">
              {t.pageLabel
                .replace('{page}', String(systemUsers.page))
                .replace('{totalPages}', String(systemUsers.totalPages))}
            </span>
            <button
              onClick={() => loadSystemUsers(Math.min(systemUsers.totalPages, systemUsers.page + 1), systemUsers.pageSize)}
              disabled={systemUsers.page >= systemUsers.totalPages || loadingUsers}
              className="px-3 py-2 border border-slate-300 rounded-lg text-sm disabled:opacity-50"
            >
              {t.nextPage}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SettingsPage;
