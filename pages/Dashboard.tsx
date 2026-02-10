import React, { useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { ClipboardList, Clock, AlertCircle, CheckCircle } from 'lucide-react';
import StatCard from '../components/StatCard';
import { Task, TaskStatus } from '../types';
import { WEEKLY_DATA } from '../data';
import { useTranslation } from '../contexts/LanguageContext';

interface DashboardProps {
  tasks: Task[];
}

const Dashboard: React.FC<DashboardProps> = ({ tasks }) => {
  const { t } = useTranslation();
  const [timeRange, setTimeRange] = useState<'TODAY' | 'WEEK' | 'MONTH'>('WEEK');

  // Calculate real-time stats
  const totalTasks = tasks.length;
  const completedTasks = tasks.filter(t => t.status === TaskStatus.COMPLETED).length;
  const waitingVerify = tasks.filter(t => t.status === TaskStatus.WAITING_VERIFY).length;
  const overdueCount = tasks.filter(t => new Date(t.endTime) < new Date() && t.status !== TaskStatus.COMPLETED).length;

  const onTimeRate = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{t.overviewTitle}</h1>
          <p className="text-slate-500 text-sm mt-1">{t.overviewSubtitle}</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1 bg-white p-1 rounded-lg border border-slate-200">
            <button
              onClick={() => setTimeRange('TODAY')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
                timeRange === 'TODAY' 
                  ? 'bg-slate-900 text-white shadow-sm' 
                  : 'text-slate-500 hover:bg-slate-50 hover:text-slate-700'
              }`}
            >
              {t.timeRange_today}
            </button>
            <button
              onClick={() => setTimeRange('WEEK')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
                timeRange === 'WEEK' 
                  ? 'bg-slate-900 text-white shadow-sm' 
                  : 'text-slate-500 hover:bg-slate-50 hover:text-slate-700'
              }`}
            >
              {t.timeRange_week}
            </button>
            <button
              onClick={() => setTimeRange('MONTH')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
                timeRange === 'MONTH' 
                  ? 'bg-slate-900 text-white shadow-sm' 
                  : 'text-slate-500 hover:bg-slate-50 hover:text-slate-700'
              }`}
            >
              {t.timeRange_month}
            </button>
          </div>
          <div className="h-8 w-px bg-slate-200 hidden md:block"></div>
          <button className="px-4 py-2 bg-white border border-slate-200 text-slate-600 rounded-lg text-sm font-medium hover:bg-slate-50 transition-colors">
            {t.exportReport}
          </button>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <StatCard
          title={t.totalTasks}
          value={totalTasks}
          change="+12%"
          changeType="positive"
          subtext={t.vsLastMonth}
          icon={<ClipboardList className="w-5 h-5 text-blue-600" />}
          colorClass="bg-blue-500"
        />
        <StatCard
          title={t.completionRate}
          value={`${onTimeRate}%`}
          change="+2.4%"
          changeType="positive"
          subtext={t.completedOnTime}
          icon={<CheckCircle className="w-5 h-5 text-green-600" />}
          colorClass="bg-green-500"
        />
        <StatCard
          title={t.waitingAcceptance}
          value={waitingVerify}
          change={t.needsAction}
          changeType="neutral"
          subtext={t.tasksWaiting}
          icon={<Clock className="w-5 h-5 text-amber-600" />}
          colorClass="bg-amber-500"
        />
        <StatCard
          title={t.overdueTasks}
          value={overdueCount}
          change="+1.2%"
          changeType="negative"
          subtext={t.overdue24h}
          icon={<AlertCircle className="w-5 h-5 text-red-600" />}
          colorClass="bg-red-500"
        />
      </div>

      {/* Charts and Recent Activity */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Weekly Analytics Chart */}
        <div className="lg:col-span-2 bg-white rounded-xl shadow-sm border border-slate-100 p-6">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-lg font-bold text-slate-900">{t.weeklyAnalytics}</h2>
            <div className="flex items-center gap-4 text-sm">
               <div className="flex items-center gap-2">
                 <div className="w-3 h-3 rounded-full bg-blue-500"></div>
                 <span className="text-slate-500">{t.completed}</span>
               </div>
               <div className="flex items-center gap-2">
                 <div className="w-3 h-3 rounded-full bg-red-400"></div>
                 <span className="text-slate-500">{t.rejected}</span>
               </div>
            </div>
          </div>
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={WEEKLY_DATA} margin={{ top: 10, right: 10, left: -20, bottom: 0 }} barGap={8}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fill: '#64748b', fontSize: 12 }} dy={10} />
                <YAxis axisLine={false} tickLine={false} tick={{ fill: '#64748b', fontSize: 12 }} />
                <Tooltip 
                  cursor={{ fill: '#f8fafc' }}
                  contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                />
                <Bar dataKey="completed" fill="#3b82f6" radius={[4, 4, 0, 0]} maxBarSize={40} />
                <Bar dataKey="rejected" fill="#f87171" radius={[4, 4, 0, 0]} maxBarSize={40} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Mini Feed / Notifications */}
        <div className="bg-white rounded-xl shadow-sm border border-slate-100 p-6 flex flex-col">
          <h2 className="text-lg font-bold text-slate-900 mb-4">{t.recentActivity}</h2>
          <div className="flex-1 overflow-y-auto space-y-6 pr-2">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="flex gap-3">
                <div className="w-2 h-2 mt-2 rounded-full bg-blue-500 shrink-0"></div>
                <div>
                  <p className="text-sm text-slate-800">
                    <span className="font-medium">Sarah Chen</span> marked <span className="font-medium text-blue-600">Q3 Report</span> as complete.
                  </p>
                  <p className="text-xs text-slate-400 mt-1">2 hours ago</p>
                </div>
              </div>
            ))}
             <div className="flex gap-3">
                <div className="w-2 h-2 mt-2 rounded-full bg-red-500 shrink-0"></div>
                <div>
                  <p className="text-sm text-slate-800">
                    <span className="font-medium">You</span> rejected <span className="font-medium text-red-600">Security Audit</span>.
                  </p>
                  <p className="text-xs text-slate-400 mt-1">5 hours ago</p>
                </div>
              </div>
          </div>
          <button className="w-full mt-4 py-2 text-sm text-blue-600 hover:bg-blue-50 rounded-lg transition-colors font-medium">
            {t.viewAll}
          </button>
        </div>
      </div>
    </div>
  );
};

export default Dashboard;