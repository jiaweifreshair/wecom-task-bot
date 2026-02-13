import React, { useCallback, useEffect, useState } from 'react';
import {
  LayoutDashboard,
  CheckSquare,
  Users,
  Settings,
  Bell,
  Search,
  Menu,
  X,
  Globe,
  LogIn,
  RefreshCw,
} from 'lucide-react';
import { KPIStats, Task, TaskCreatePayload, TaskStatus } from './types';
import Dashboard from './pages/Dashboard';
import Tasks from './pages/Tasks';
import TeamStats from './pages/TeamStats';
import SettingsPage from './pages/Settings';
import { useTranslation } from './contexts/LanguageContext';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import {
  getTasks,
  createTask,
  completeTask,
  verifyTask,
  syncTasks,
  type BackendTaskKpi,
  type BackendTaskRow,
} from './api';

type View = 'DASHBOARD' | 'TASKS' | 'TEAM' | 'SETTINGS';

const mapTaskStatus = (status: string): TaskStatus => {
  if (status === TaskStatus.PENDING) {
    return TaskStatus.PENDING;
  }
  if (status === TaskStatus.WAITING_VERIFY) {
    return TaskStatus.WAITING_VERIFY;
  }
  if (status === TaskStatus.COMPLETED) {
    return TaskStatus.COMPLETED;
  }
  return TaskStatus.REJECTED;
};

const mapTaskRowToTask = (row: BackendTaskRow): Task => {
  return {
    id: row.id,
    wecomScheduleId: row.wecom_schedule_id,
    title: row.title || '未命名任务',
    description: row.description || '',
    creator: {
      id: row.creator_userid || 'unknown-manager',
      name: row.creator_userid || '未知发起人',
      avatar: '',
      role: 'MANAGER',
    },
    executor: {
      id: row.executor_userid || 'unknown-executor',
      name: row.executor_userid || '未知执行人',
      avatar: '',
      role: 'EXECUTOR',
    },
    startTime: row.start_time,
    endTime: row.end_time,
    status: mapTaskStatus(row.status),
    completionTime: row.completion_time,
    verifyTime: row.verify_time,
    rejectReason: row.reject_reason,
    redoCount: Number(row.redo_count || 0),
    canComplete: Boolean(row.can_complete),
    canVerify: Boolean(row.can_verify),
    isDueSoon: Boolean(row.is_due_soon),
    isOverdue: Boolean(row.is_overdue),
  };
};

const mapKpi = (kpi: BackendTaskKpi): KPIStats => {
  return {
    totalTasks: Number(kpi.total_tasks || 0),
    completionRate: Number(kpi.completion_rate || 0),
    waitingAcceptance: Number(kpi.waiting_verify_tasks || 0),
    overdueTasks: Number(kpi.overdue_tasks || 0),
    dueSoonTasks: Number(kpi.due_soon_tasks || 0),
    onTimeRate: Number(kpi.on_time_rate || 0),
  };
};

const emptyKpi: KPIStats = {
  totalTasks: 0,
  completionRate: 0,
  waitingAcceptance: 0,
  overdueTasks: 0,
  dueSoonTasks: 0,
  onTimeRate: 0,
};

// buildQrLoginUrl
// 是什么：扫码登录 URL 生成函数。
// 做什么：将扫码登录入口包装为可嵌入 iframe 的地址。
// 为什么：登录页需直接展示二维码而非按钮跳转，减少用户操作步骤。
const buildQrLoginUrl = () => {
  const loginPath = '/api/auth/login?mode=qr';
  if (typeof window === 'undefined') {
    return loginPath;
  }

  return `${window.location.origin}${loginPath}`;
};

const MainApp: React.FC = () => {
  const { user, loading: authLoading, login } = useAuth();
  const [currentView, setCurrentView] = useState<View>('DASHBOARD');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [kpi, setKpi] = useState<KPIStats>(emptyKpi);
  const [loadingTasks, setLoadingTasks] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [qrLoginUrl, setQrLoginUrl] = useState<string>(() => buildQrLoginUrl());
  const [qrLoading, setQrLoading] = useState(false);
  const { t, language, setLanguage } = useTranslation();

  const loadTasks = useCallback(async () => {
    if (!user) {
      setTasks([]);
      setKpi(emptyKpi);
      return;
    }

    setLoadingTasks(true);
    try {
      const response = await getTasks();
      setTasks((response.tasks || []).map(mapTaskRowToTask));
      setKpi(mapKpi(response.kpi || ({} as BackendTaskKpi)));
    } catch (error) {
      console.error(error);
      setTasks([]);
      setKpi(emptyKpi);
    } finally {
      setLoadingTasks(false);
    }
  }, [user]);

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (user && token) {
      loadTasks();
    } else {
      setTasks([]);
      setKpi(emptyKpi);
    }
  }, [user, loadTasks]);

  const handleCreateTask = async (payload: TaskCreatePayload) => {
    try {
      await createTask(payload);
      await loadTasks();
    } catch (error) {
      console.error(error);
      alert(t.operationFailed);
    }
  };

  const handleCompleteTask = async (taskId: number) => {
    try {
      await completeTask(taskId);
      await loadTasks();
    } catch (error) {
      console.error(error);
      alert(t.operationFailed);
    }
  };

  const handleVerifyTask = async (taskId: number, action: 'PASS' | 'REJECT', reason?: string) => {
    try {
      await verifyTask(taskId, action, reason || '');
      await loadTasks();
    } catch (error) {
      console.error(error);
      alert(t.operationFailed);
    }
  };

  const handleSyncTasks = async () => {
    try {
      setSyncing(true);
      await syncTasks();
      await loadTasks();
    } catch (error) {
      console.error(error);
      alert(t.syncFailed);
    } finally {
      setSyncing(false);
    }
  };

  // refreshQrCode
  // 是什么：扫码二维码刷新函数。
  // 做什么：通过追加时间戳参数强制刷新二维码页面，避免缓存导致二维码失效。
  // 为什么：企业微信扫码票据存在时效，用户停留后需要一键刷新入口。
  const refreshQrCode = () => {
    setQrLoading(true);
    const nextUrl = `${buildQrLoginUrl()}&ts=${Date.now()}`;
    setQrLoginUrl(nextUrl);
  };

  const handleQrLoaded = () => {
    setQrLoading(false);
  };

  const handleQrError = () => {
    setQrLoading(false);
  };

  const NavItem = ({
    view,
    icon: Icon,
    label,
  }: {
    view: View;
    icon: React.ComponentType<{ className?: string }>;
    label: string;
  }) => (
    <button
      onClick={() => {
        setCurrentView(view);
        setMobileMenuOpen(false);
      }}
      className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-colors ${
        currentView === view
          ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/30'
          : 'text-slate-400 hover:text-white hover:bg-slate-800'
      }`}
    >
      <Icon className="w-5 h-5" />
      {label}
    </button>
  );

  if (authLoading) {
    return <div className="flex items-center justify-center min-h-screen bg-slate-50">Loading...</div>;
  }

  if (!user) {
    return (
      <div className="relative flex items-center justify-center min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-blue-950 overflow-hidden px-4">
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute -top-24 -left-16 w-96 h-96 rounded-full bg-blue-500/15 blur-3xl" />
          <div className="absolute top-1/3 -right-24 w-[28rem] h-[28rem] rounded-full bg-cyan-400/10 blur-3xl" />
          <div className="absolute bottom-0 left-1/3 w-80 h-80 rounded-full bg-indigo-500/15 blur-3xl" />
        </div>

        <div className="relative w-full max-w-md bg-white/95 backdrop-blur-sm p-8 rounded-2xl shadow-2xl text-center border border-white/60">
          <h1 className="text-3xl font-bold mb-2 text-slate-900">{t.loginWelcomeTitle}</h1>
          <p className="text-slate-600 mb-4">{t.loginScanSubtitle}</p>

          <div className="bg-white rounded-xl border border-slate-200 shadow-inner p-3 mb-4">
            <div className="w-full aspect-square rounded-lg overflow-hidden bg-slate-100 flex items-center justify-center">
              <iframe
                title="wecom-qr-login"
                src={qrLoginUrl}
                className="w-full h-full border-0"
                onLoad={handleQrLoaded}
                onError={handleQrError}
              />
            </div>
          </div>

          <div className="flex items-center justify-center gap-3">
            <button
              onClick={refreshQrCode}
              className="inline-flex items-center justify-center gap-2 px-4 py-2 bg-slate-800 text-white rounded-lg hover:bg-slate-900 transition-colors"
            >
              <RefreshCw className={`w-4 h-4 ${qrLoading ? 'animate-spin' : ''}`} />
              {qrLoading ? t.loginScanRefreshing : t.loginScanRetry}
            </button>
            <button
              onClick={() => login('qr')}
              className="inline-flex items-center justify-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
            >
              <LogIn className="w-4 h-4" />
              {t.loginButtonQr}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative min-h-screen bg-gradient-to-br from-slate-100 via-white to-blue-100 flex overflow-hidden">
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute -top-24 -left-16 w-96 h-96 rounded-full bg-blue-500/10 blur-3xl" />
        <div className="absolute top-1/3 -right-24 w-[28rem] h-[28rem] rounded-full bg-cyan-400/10 blur-3xl" />
      </div>
      <aside
        className={`
        relative fixed inset-y-0 left-0 z-30 w-64 bg-slate-900 text-white transform transition-transform duration-300 ease-in-out lg:translate-x-0 lg:static lg:inset-0
        ${mobileMenuOpen ? 'translate-x-0' : '-translate-x-full'}
      `}
      >
        <div className="h-16 flex items-center px-6 border-b border-slate-800">
          <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center mr-3">
            <CheckSquare className="w-5 h-5 text-white" />
          </div>
          <span className="font-bold text-lg tracking-tight">{t.appName}</span>
          <button
            onClick={() => setMobileMenuOpen(false)}
            className="ml-auto lg:hidden text-slate-400 hover:text-white"
          >
            <X className="w-6 h-6" />
          </button>
        </div>

        <div className="p-4 space-y-1">
          <NavItem view="DASHBOARD" icon={LayoutDashboard} label={t.dashboard} />
          <NavItem view="TASKS" icon={CheckSquare} label={t.taskList} />
          <NavItem view="TEAM" icon={Users} label={t.teamStats} />
          <div className="pt-4 mt-4 border-t border-slate-800">
            <p className="px-4 text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">{t.system}</p>
            <NavItem view="SETTINGS" icon={Settings} label={t.settings} />
          </div>
        </div>

        <div className="absolute bottom-0 left-0 right-0 p-4 border-t border-slate-800 bg-slate-900/50">
          <div className="flex items-center gap-3">
            <img
              src={user.avatar || 'https://via.placeholder.com/100'}
              alt="User"
              className="w-10 h-10 rounded-full border-2 border-slate-700"
            />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-white truncate">{user.name}</p>
              <p className="text-xs text-slate-400 truncate">{user.role}</p>
            </div>
          </div>
        </div>
      </aside>

      <div className="relative flex-1 flex flex-col min-w-0 h-screen overflow-hidden">
        <header className="bg-white border-b border-slate-200 h-16 flex items-center justify-between px-4 lg:px-8 z-10 shrink-0">
          <div className="flex items-center gap-4">
            <button
              onClick={() => setMobileMenuOpen(true)}
              className="lg:hidden p-2 text-slate-500 hover:bg-slate-100 rounded-lg"
            >
              <Menu className="w-6 h-6" />
            </button>

            <div className="hidden md:flex items-center text-sm text-slate-500">
              <span className="hover:text-slate-800 cursor-pointer">{t.home}</span>
              <span className="mx-2">/</span>
              <span className="font-medium text-slate-900 capitalize">
                {currentView === 'DASHBOARD'
                  ? t.dashboard
                  : currentView === 'TASKS'
                  ? t.taskList
                  : currentView === 'TEAM'
                  ? t.teamStats
                  : t.settings}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="relative hidden md:block">
              <Search className="absolute left-3 top-2.5 w-4 h-4 text-slate-400" />
              <input
                type="text"
                placeholder={t.search}
                className="pl-10 pr-4 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 w-64 transition-all"
              />
            </div>

            <button
              onClick={() => setLanguage(language === 'zh' ? 'en' : 'zh')}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-full transition-colors"
            >
              <Globe className="w-3.5 h-3.5" />
              {language === 'zh' ? 'EN' : '中文'}
            </button>

            <button
              onClick={handleSyncTasks}
              disabled={syncing}
              className="flex items-center gap-2 p-2 text-slate-500 hover:bg-slate-100 rounded-full transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-5 h-5 ${syncing ? 'animate-spin' : ''}`} />
              <span className="hidden md:inline text-sm">{t.syncNow}</span>
            </button>

            <button className="relative p-2 text-slate-500 hover:bg-slate-100 rounded-full transition-colors">
              <Bell className="w-5 h-5" />
              {kpi.dueSoonTasks > 0 && (
                <span className="absolute top-2 right-2.5 w-2 h-2 bg-red-500 rounded-full ring-2 ring-white" />
              )}
            </button>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto p-4 lg:p-8">
          <div className="max-w-7xl mx-auto animate-in fade-in duration-300">
            {loadingTasks ? (
              <div className="text-center py-10">Loading tasks...</div>
            ) : (
              <>
                {currentView === 'DASHBOARD' && <Dashboard tasks={tasks} kpi={kpi} />}
                {currentView === 'TASKS' && (
                  <Tasks
                    tasks={tasks}
                    onCreateTask={handleCreateTask}
                    onCompleteTask={handleCompleteTask}
                    onVerifyTask={handleVerifyTask}
                  />
                )}
                {currentView === 'TEAM' && <TeamStats tasks={tasks} />}
                {currentView === 'SETTINGS' && <SettingsPage onSyncTasks={handleSyncTasks} />}
              </>
            )}
          </div>
        </main>
      </div>

      {mobileMenuOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-20 lg:hidden backdrop-blur-sm"
          onClick={() => setMobileMenuOpen(false)}
        />
      )}
    </div>
  );
};

const App: React.FC = () => {
  return (
    <AuthProvider>
      <MainApp />
    </AuthProvider>
  );
};

export default App;
