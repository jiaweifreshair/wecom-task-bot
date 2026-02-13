import React, { useMemo } from 'react';
import { Users, CheckCircle2, Clock3, AlertTriangle } from 'lucide-react';
import { Task, TaskStatus, TeamMemberStats } from '../types';
import { useTranslation } from '../contexts/LanguageContext';

interface TeamStatsProps {
  tasks: Task[];
}

const TeamStats: React.FC<TeamStatsProps> = ({ tasks }) => {
  const { t } = useTranslation();

  const memberStats = useMemo<TeamMemberStats[]>(() => {
    const executorMap = new Map<string, TeamMemberStats>();

    tasks.forEach((task) => {
      const key = task.executor.id || task.executor.name;
      if (!executorMap.has(key)) {
        executorMap.set(key, {
          userId: task.executor.id,
          userName: task.executor.name,
          role: 'EXECUTOR',
          taskCount: 0,
          completedCount: 0,
          pendingCount: 0,
          waitingVerifyCount: 0,
          overdueCount: 0,
          completionRate: 0,
        });
      }

      const member = executorMap.get(key);
      if (!member) {
        return;
      }

      member.taskCount += 1;
      if (task.status === TaskStatus.COMPLETED) {
        member.completedCount += 1;
      }
      if (task.status === TaskStatus.PENDING) {
        member.pendingCount += 1;
      }
      if (task.status === TaskStatus.WAITING_VERIFY) {
        member.waitingVerifyCount += 1;
      }
      if (task.isOverdue) {
        member.overdueCount += 1;
      }
    });

    return Array.from(executorMap.values())
      .map((member) => ({
        ...member,
        completionRate:
          member.taskCount > 0 ? Number(((member.completedCount / member.taskCount) * 100).toFixed(2)) : 0,
      }))
      .sort((a, b) => b.taskCount - a.taskCount);
  }, [tasks]);

  const totalMembers = memberStats.length;
  const avgCompletionRate =
    totalMembers > 0
      ? Number(
          (
            memberStats.reduce((accumulator, item) => accumulator + item.completionRate, 0) / totalMembers
          ).toFixed(2)
        )
      : 0;
  const totalOverdue = memberStats.reduce((accumulator, item) => accumulator + item.overdueCount, 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">{t.teamStatsTitle}</h1>
        <p className="text-sm text-slate-500 mt-1">{t.teamStatsDesc}</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <div className="flex items-center gap-2 text-slate-600 text-sm">
            <Users className="w-4 h-4" />
            {t.teamMemberCount}
          </div>
          <p className="text-3xl font-bold text-slate-900 mt-2">{totalMembers}</p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <div className="flex items-center gap-2 text-slate-600 text-sm">
            <CheckCircle2 className="w-4 h-4" />
            {t.teamAvgCompletionRate}
          </div>
          <p className="text-3xl font-bold text-slate-900 mt-2">{avgCompletionRate}%</p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <div className="flex items-center gap-2 text-slate-600 text-sm">
            <AlertTriangle className="w-4 h-4" />
            {t.teamOverdueCount}
          </div>
          <p className="text-3xl font-bold text-slate-900 mt-2">{totalOverdue}</p>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-900">{t.teamMemberBoard}</h2>
          <span className="text-xs text-slate-400">{t.teamTableTip}</span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="text-left px-5 py-3 font-medium">{t.executor}</th>
                <th className="text-left px-5 py-3 font-medium">{t.totalTasks}</th>
                <th className="text-left px-5 py-3 font-medium">{t.status_COMPLETED}</th>
                <th className="text-left px-5 py-3 font-medium">{t.status_WAITING_VERIFY}</th>
                <th className="text-left px-5 py-3 font-medium">{t.status_PENDING}</th>
                <th className="text-left px-5 py-3 font-medium">{t.overdueTasks}</th>
                <th className="text-left px-5 py-3 font-medium">{t.completionRate}</th>
              </tr>
            </thead>
            <tbody>
              {memberStats.length === 0 ? (
                <tr>
                  <td className="px-5 py-8 text-slate-400" colSpan={7}>
                    {t.noTasks}
                  </td>
                </tr>
              ) : (
                memberStats.map((member) => (
                  <tr key={member.userId || member.userName} className="border-t border-slate-100">
                    <td className="px-5 py-3 font-medium text-slate-800">{member.userName}</td>
                    <td className="px-5 py-3 text-slate-700">{member.taskCount}</td>
                    <td className="px-5 py-3 text-green-600">{member.completedCount}</td>
                    <td className="px-5 py-3 text-amber-600">{member.waitingVerifyCount}</td>
                    <td className="px-5 py-3 text-slate-700">{member.pendingCount}</td>
                    <td className="px-5 py-3 text-red-600">{member.overdueCount}</td>
                    <td className="px-5 py-3 text-blue-600">{member.completionRate}%</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-5">
        <h3 className="text-base font-semibold text-slate-900 mb-3">{t.teamActionHintTitle}</h3>
        <div className="space-y-2 text-sm text-slate-600">
          <p className="flex items-center gap-2">
            <Clock3 className="w-4 h-4 text-amber-500" /> {t.teamActionHint1}
          </p>
          <p className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-red-500" /> {t.teamActionHint2}
          </p>
        </div>
      </div>
    </div>
  );
};

export default TeamStats;
