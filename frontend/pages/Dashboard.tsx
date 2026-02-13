import React from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { ClipboardList, Clock, AlertCircle, CheckCircle } from 'lucide-react';
import StatCard from '../components/StatCard';
import { KPIStats, Task, TaskStatus } from '../types';
import { useTranslation } from '../contexts/LanguageContext';

interface DashboardProps {
  tasks: Task[];
  kpi: KPIStats;
}

interface WeeklyDataItem {
  name: string;
  completed: number;
  rejected: number;
}

const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const buildWeeklyData = (tasks: Task[]): WeeklyDataItem[] => {
  const grouped = new Map<number, WeeklyDataItem>();

  tasks.forEach((task) => {
    const date = new Date(task.startTime || task.endTime || Date.now());
    if (Number.isNaN(date.getTime())) {
      return;
    }

    const day = date.getDay();
    if (!grouped.has(day)) {
      grouped.set(day, {
        name: dayLabels[day],
        completed: 0,
        rejected: 0,
      });
    }

    const record = grouped.get(day);
    if (!record) {
      return;
    }

    if (task.status === TaskStatus.COMPLETED) {
      record.completed += 1;
      return;
    }

    if (task.redoCount > 0 || Boolean(task.rejectReason)) {
      record.rejected += 1;
    }
  });

  return dayLabels.map((label, index) => {
    const item = grouped.get(index);
    return (
      item || {
        name: label,
        completed: 0,
        rejected: 0,
      }
    );
  });
};

const Dashboard: React.FC<DashboardProps> = ({ tasks, kpi }) => {
  const { t } = useTranslation();

  const weeklyData = buildWeeklyData(tasks);
  const recentActivityTasks = [...tasks]
    .sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime())
    .slice(0, 6);

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{t.overviewTitle}</h1>
          <p className="text-slate-500 text-sm mt-1">{t.overviewSubtitle}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <StatCard
          title={t.totalTasks}
          value={kpi.totalTasks}
          change={kpi.totalTasks > 0 ? `${kpi.dueSoonTasks}${t.dueSoonSuffix}` : undefined}
          changeType="neutral"
          subtext={t.kpiTotalTaskDesc}
          icon={<ClipboardList className="w-5 h-5 text-blue-600" />}
          colorClass="bg-blue-500"
        />
        <StatCard
          title={t.completionRate}
          value={`${kpi.completionRate.toFixed(2)}%`}
          change={`${kpi.onTimeRate.toFixed(2)}%`}
          changeType="positive"
          subtext={t.completedOnTime}
          icon={<CheckCircle className="w-5 h-5 text-green-600" />}
          colorClass="bg-green-500"
        />
        <StatCard
          title={t.waitingAcceptance}
          value={kpi.waitingAcceptance}
          change={t.needsAction}
          changeType="neutral"
          subtext={t.tasksWaiting}
          icon={<Clock className="w-5 h-5 text-amber-600" />}
          colorClass="bg-amber-500"
        />
        <StatCard
          title={t.overdueTasks}
          value={kpi.overdueTasks}
          change={kpi.overdueTasks > 0 ? t.needsAction : t.noRisk}
          changeType={kpi.overdueTasks > 0 ? 'negative' : 'positive'}
          subtext={t.overdue24h}
          icon={<AlertCircle className="w-5 h-5 text-red-600" />}
          colorClass="bg-red-500"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 bg-white rounded-xl shadow-sm border border-slate-100 p-6">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-lg font-bold text-slate-900">{t.weeklyAnalytics}</h2>
            <div className="flex items-center gap-4 text-sm">
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-blue-500" />
                <span className="text-slate-500">{t.completed}</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-red-400" />
                <span className="text-slate-500">{t.rejected}</span>
              </div>
            </div>
          </div>
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={weeklyData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }} barGap={8}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fill: '#64748b', fontSize: 12 }} dy={10} />
                <YAxis axisLine={false} tickLine={false} tick={{ fill: '#64748b', fontSize: 12 }} allowDecimals={false} />
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

        <div className="bg-white rounded-xl shadow-sm border border-slate-100 p-6 flex flex-col">
          <h2 className="text-lg font-bold text-slate-900 mb-4">{t.recentActivity}</h2>
          <div className="flex-1 overflow-y-auto space-y-4 pr-2">
            {recentActivityTasks.length === 0 && (
              <p className="text-sm text-slate-400">{t.noTasks}</p>
            )}

            {recentActivityTasks.map((task) => {
              const isCompleted = task.status === TaskStatus.COMPLETED;
              const isWaiting = task.status === TaskStatus.WAITING_VERIFY;
              const dotColor = isCompleted ? 'bg-green-500' : isWaiting ? 'bg-amber-500' : 'bg-blue-500';
              const actionText = isCompleted
                ? t.activityCompleted
                : isWaiting
                ? t.activityWaitingVerify
                : t.activityPending;

              return (
                <div key={task.id} className="flex gap-3">
                  <div className={`w-2 h-2 mt-2 rounded-full shrink-0 ${dotColor}`} />
                  <div>
                    <p className="text-sm text-slate-800">
                      <span className="font-medium">{task.executor.name}</span>
                      <span className="mx-1">{actionText}</span>
                      <span className="font-medium text-blue-600">{task.title}</span>
                    </p>
                    <p className="text-xs text-slate-400 mt-1">{new Date(task.startTime).toLocaleString()}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};

export default Dashboard;
