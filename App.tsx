import React, { useState } from 'react';
import { LayoutDashboard, CheckSquare, Users, Settings, Bell, Search, Menu, X, Globe } from 'lucide-react';
import { Task, TaskStatus } from './types';
import { INITIAL_TASKS, CURRENT_USER } from './data';
import Dashboard from './pages/Dashboard';
import Tasks from './pages/Tasks';
import { useTranslation } from './contexts/LanguageContext';

// Simple Router Type
type View = 'DASHBOARD' | 'TASKS' | 'TEAM' | 'SETTINGS';

const App: React.FC = () => {
  const [currentView, setCurrentView] = useState<View>('DASHBOARD');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [tasks, setTasks] = useState<Task[]>(INITIAL_TASKS);
  const { t, language, setLanguage } = useTranslation();

  // Core State Machine Logic
  const handleUpdateTaskStatus = (taskId: number, newStatus: TaskStatus, reason?: string) => {
    setTasks(prevTasks => prevTasks.map(task => {
      if (task.id !== taskId) return task;

      const updatedTask = { ...task, status: newStatus };

      if (newStatus === TaskStatus.WAITING_VERIFY) {
        // Logic: Executor marks complete
        updatedTask.completionTime = new Date().toISOString();
      } else if (newStatus === TaskStatus.COMPLETED) {
        // Logic: Manager approves
        updatedTask.verifyTime = new Date().toISOString();
      } else if (newStatus === TaskStatus.REJECTED) {
        // Logic: Manager rejects -> status resets to PENDING in some systems, 
        // but PRD says "REJECTED" state specifically, then implied flow back to pending or staying rejected until action.
        // PRD says: "REJECTED (已驳回): 领导点击“驳回”后，状态自动回滚至 PENDING，并标记重做次数。"
        // So we set it to PENDING and increment redoCount.
        updatedTask.status = TaskStatus.PENDING; 
        updatedTask.rejectReason = reason;
        updatedTask.redoCount = (task.redoCount || 0) + 1;
        
        // Optional: We can keep a history log here if needed.
        console.log(`Task ${task.id} rejected. Reason: ${reason}. Redo Count: ${updatedTask.redoCount}`);
      }

      return updatedTask;
    }));
  };

  const NavItem = ({ view, icon: Icon, label }: { view: View; icon: any; label: string }) => (
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

  return (
    <div className="min-h-screen bg-slate-50 flex overflow-hidden">
      {/* Sidebar */}
      <aside className={`
        fixed inset-y-0 left-0 z-30 w-64 bg-slate-900 text-white transform transition-transform duration-300 ease-in-out lg:translate-x-0 lg:static lg:inset-0
        ${mobileMenuOpen ? 'translate-x-0' : '-translate-x-full'}
      `}>
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
            <img src={CURRENT_USER.avatar} alt="User" className="w-10 h-10 rounded-full border-2 border-slate-700" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-white truncate">{CURRENT_USER.name}</p>
              <p className="text-xs text-slate-400 truncate">{CURRENT_USER.role}</p>
            </div>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0 h-screen overflow-hidden">
        {/* Header */}
        <header className="bg-white border-b border-slate-200 h-16 flex items-center justify-between px-4 lg:px-8 z-10 shrink-0">
          <div className="flex items-center gap-4">
             <button 
                onClick={() => setMobileMenuOpen(true)}
                className="lg:hidden p-2 text-slate-500 hover:bg-slate-100 rounded-lg"
             >
               <Menu className="w-6 h-6" />
             </button>
             {/* Breadcrumb-ish */}
             <div className="hidden md:flex items-center text-sm text-slate-500">
                <span className="hover:text-slate-800 cursor-pointer">{t.home}</span>
                <span className="mx-2">/</span>
                <span className="font-medium text-slate-900 capitalize">
                  {currentView === 'DASHBOARD' ? t.dashboard : 
                   currentView === 'TASKS' ? t.taskList : 
                   currentView === 'TEAM' ? t.teamStats : t.settings}
                </span>
             </div>
          </div>

          <div className="flex items-center gap-4">
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

            <button className="relative p-2 text-slate-500 hover:bg-slate-100 rounded-full transition-colors">
              <Bell className="w-5 h-5" />
              <span className="absolute top-2 right-2.5 w-2 h-2 bg-red-500 rounded-full ring-2 ring-white"></span>
            </button>
          </div>
        </header>

        {/* Scrollable Content Area */}
        <main className="flex-1 overflow-y-auto p-4 lg:p-8">
          <div className="max-w-7xl mx-auto animate-in fade-in duration-300">
            {currentView === 'DASHBOARD' && <Dashboard tasks={tasks} />}
            {currentView === 'TASKS' && <Tasks tasks={tasks} onUpdateStatus={handleUpdateTaskStatus} />}
            {currentView === 'TEAM' && (
              <div className="flex items-center justify-center h-96 text-slate-400">
                {t.teamAnalyticsComingSoon}
              </div>
            )}
            {currentView === 'SETTINGS' && (
               <div className="flex items-center justify-center h-96 text-slate-400">
                 {t.settingsComingSoon}
               </div>
            )}
          </div>
        </main>
      </div>

      {/* Mobile Overlay */}
      {mobileMenuOpen && (
        <div 
          className="fixed inset-0 bg-black/50 z-20 lg:hidden backdrop-blur-sm"
          onClick={() => setMobileMenuOpen(false)}
        ></div>
      )}
    </div>
  );
};

export default App;