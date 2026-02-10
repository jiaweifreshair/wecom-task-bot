import React, { createContext, useContext, useState, ReactNode } from 'react';

type Language = 'zh' | 'en';

const translations = {
  zh: {
    // Sidebar & Header
    appName: '企微任务管家',
    dashboard: '仪表盘',
    taskList: '任务列表',
    teamStats: '团队统计',
    settings: '系统设置',
    system: '系统管理',
    home: '首页',
    search: '全局搜索...',
    
    // Dashboard
    overviewTitle: '概览',
    overviewSubtitle: '欢迎回来，今日动态如下。',
    exportReport: '导出报表',
    totalTasks: '任务总数',
    completionRate: '完成率',
    waitingAcceptance: '待验收',
    overdueTasks: '逾期任务',
    vsLastMonth: '较上月',
    completedOnTime: '按时完成',
    tasksWaiting: '等待管理者验收',
    overdue24h: '逾期超过24小时',
    weeklyAnalytics: '周数据分析',
    recentActivity: '近期动态',
    viewAll: '查看全部',
    completed: '已完成',
    rejected: '已驳回',
    needsAction: '待办',
    timeRange_today: '今日',
    timeRange_week: '本周',
    timeRange_month: '本月',
    
    // Tasks
    taskManagement: '任务管理',
    taskMgmtSubtitle: '管理、验收及追踪团队任务。',
    createTask: '+ 新建任务',
    allTasks: '全部任务',
    pending: '待处理',
    waitingVerify: '待验收',
    searchPlaceholder: '搜索任务...',
    noTasks: '未找到符合条件的任务。',
    due: '截止',
    redo: '重做',
    creator: '发起人',
    executor: '执行人',
    pass: '通过',
    reject: '驳回',
    markComplete: '标记完成',
    cancel: '取消',
    confirmReject: '确认驳回',
    rejectTitle: '驳回任务',
    rejectDesc: '请输入驳回理由，任务将返回给执行人并增加重做计数。',
    enterReason: '输入驳回理由...',
    
    // Status
    status_PENDING: '待处理',
    status_WAITING_VERIFY: '待验收',
    status_COMPLETED: '已闭环',
    status_REJECTED: '已驳回',

    // Other
    teamAnalyticsComingSoon: '团队分析模块 (开发中)',
    settingsComingSoon: '系统设置模块 (开发中)',
  },
  en: {
    // Sidebar & Header
    appName: 'WeCom Task Master',
    dashboard: 'Dashboard',
    taskList: 'Task List',
    teamStats: 'Team Stats',
    settings: 'Settings',
    system: 'System',
    home: 'Home',
    search: 'Global search...',
    
    // Dashboard
    overviewTitle: 'Dashboard Overview',
    overviewSubtitle: "Welcome back, here's what's happening today.",
    exportReport: 'Export Report',
    totalTasks: 'Total Tasks',
    completionRate: 'Completion Rate',
    waitingAcceptance: 'Waiting Acceptance',
    overdueTasks: 'Overdue Tasks',
    vsLastMonth: 'vs. last month',
    completedOnTime: 'Tasks completed on time',
    tasksWaiting: 'Tasks waiting for manager',
    overdue24h: 'Tasks overdue > 24h',
    weeklyAnalytics: 'Weekly Analytics',
    recentActivity: 'Recent Activity',
    viewAll: 'View All Activity',
    completed: 'Completed',
    rejected: 'Rejected',
    needsAction: 'Needs Action',
    timeRange_today: 'Today',
    timeRange_week: 'This Week',
    timeRange_month: 'This Month',
    
    // Tasks
    taskManagement: 'Task Management',
    taskMgmtSubtitle: 'Manage, verify, and track team tasks.',
    createTask: '+ Create Task',
    allTasks: 'All Tasks',
    pending: 'Pending',
    waitingVerify: 'Waiting Verify',
    searchPlaceholder: 'Search tasks...',
    noTasks: 'No tasks found matching your filters.',
    due: 'Due',
    redo: 'Redo',
    creator: 'Creator',
    executor: 'Executor',
    pass: 'Pass',
    reject: 'Reject',
    markComplete: 'Mark Complete',
    cancel: 'Cancel',
    confirmReject: 'Confirm Reject',
    rejectTitle: 'Reject Task',
    rejectDesc: 'Please provide a reason for rejecting this task. The task will be returned to the executor with an incremented redo count.',
    enterReason: 'Enter rejection reason...',
    
    // Status
    status_PENDING: 'Pending',
    status_WAITING_VERIFY: 'Waiting Verify',
    status_COMPLETED: 'Completed',
    status_REJECTED: 'Rejected',

    // Other
    teamAnalyticsComingSoon: 'Team Analytics Module (Coming Soon)',
    settingsComingSoon: 'System Settings Module (Coming Soon)',
  }
};

type Translations = typeof translations.en;

interface LanguageContextType {
  language: Language;
  setLanguage: (lang: Language) => void;
  t: Translations;
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

export const LanguageProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [language, setLanguage] = useState<Language>('zh');

  return (
    <LanguageContext.Provider value={{ language, setLanguage, t: translations[language] }}>
      {children}
    </LanguageContext.Provider>
  );
};

export const useTranslation = () => {
  const context = useContext(LanguageContext);
  if (!context) {
    throw new Error('useTranslation must be used within a LanguageProvider');
  }
  return context;
};