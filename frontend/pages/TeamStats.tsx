import React, { useEffect, useState } from 'react';
import { Users, CheckCircle2, Clock3, AlertTriangle } from 'lucide-react';
import { getTeamStats } from '../api';
import { Task, TeamPositionStats, TeamRoleMemberStats, TeamStatsSnapshot } from '../types';
import { useTranslation } from '../contexts/LanguageContext';

interface TeamStatsProps {
  tasks: Task[];
}

// createEmptyTeamStatsSnapshot
// 是什么：团队统计空快照工厂函数。
// 做什么：在接口尚未返回时提供稳定的零值结构，避免页面渲染判空分支过多。
// 为什么：团队页包含多块榜单与总览卡片，统一空结构能降低状态管理复杂度。
const createEmptyTeamStatsSnapshot = (): TeamStatsSnapshot => ({
  summaries: {
    manager: {
      role: 'MANAGER',
      memberCount: 0,
      taskCount: 0,
      completedCount: 0,
      pendingCount: 0,
      waitingVerifyCount: 0,
      overdueCount: 0,
      dueSoonCount: 0,
      completionRate: 0,
      onTimeRate: 0,
    },
    executor: {
      role: 'EXECUTOR',
      memberCount: 0,
      taskCount: 0,
      completedCount: 0,
      pendingCount: 0,
      waitingVerifyCount: 0,
      overdueCount: 0,
      dueSoonCount: 0,
      completionRate: 0,
      onTimeRate: 0,
    },
  },
  members: {
    manager: [],
    executor: [],
  },
  positions: {
    manager: [],
    executor: [],
  },
});

// SummaryCard
// 是什么：团队统计概览卡片组件。
// 做什么：渲染顶部核心 KPI，统一图标、标题、数值和补充说明样式。
// 为什么：管理岗与执行岗需要并列展示关键指标，抽成小组件可减少重复结构。
const SummaryCard: React.FC<{
  title: string;
  value: string | number;
  subtext: string;
  icon: React.ReactNode;
}> = ({ title, value, subtext, icon }) => {
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-5">
      <div className="flex items-center gap-2 text-slate-600 text-sm">
        {icon}
        {title}
      </div>
      <p className="text-3xl font-bold text-slate-900 mt-2">{value}</p>
      <p className="text-xs text-slate-400 mt-2">{subtext}</p>
    </div>
  );
};

// RoleBoardTable
// 是什么：角色成员榜单组件。
// 做什么：按管理岗或执行岗渲染成员表格，并根据角色切换差异化列定义。
// 为什么：用户要求不同岗位展示不同统计口径，表头和指标必须随角色变化。
const RoleBoardTable: React.FC<{
  title: string;
  role: 'MANAGER' | 'EXECUTOR';
  rows: TeamRoleMemberStats[];
  emptyText: string;
  labels: {
    person: string;
    position: string;
    taskCount: string;
    completed: string;
    pending: string;
    waitingVerify: string;
    overdue: string;
    onTimeRate: string;
    completionRate: string;
  };
}> = ({ title, role, rows, emptyText, labels }) => {
  return (
    <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
        <span className="text-xs text-slate-400">{rows.length} 人</span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-left px-5 py-3 font-medium">{labels.person}</th>
              <th className="text-left px-5 py-3 font-medium">{labels.position}</th>
              <th className="text-left px-5 py-3 font-medium">{labels.taskCount}</th>
              <th className="text-left px-5 py-3 font-medium">{labels.completed}</th>
              {role === 'EXECUTOR' && (
                <th className="text-left px-5 py-3 font-medium">{labels.pending}</th>
              )}
              <th className="text-left px-5 py-3 font-medium">{labels.waitingVerify}</th>
              <th className="text-left px-5 py-3 font-medium">{labels.overdue}</th>
              <th className="text-left px-5 py-3 font-medium">
                {role === 'MANAGER' ? labels.onTimeRate : labels.completionRate}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td className="px-5 py-8 text-slate-400" colSpan={role === 'EXECUTOR' ? 8 : 7}>
                  {emptyText}
                </td>
              </tr>
            ) : (
              rows.map((member) => (
                <tr key={`${role}-${member.userId || member.userName}`} className="border-t border-slate-100">
                  <td className="px-5 py-3 font-medium text-slate-800">{member.userName}</td>
                  <td className="px-5 py-3 text-slate-600">{member.position}</td>
                  <td className="px-5 py-3 text-slate-700">{member.taskCount}</td>
                  <td className="px-5 py-3 text-green-600">{member.completedCount}</td>
                  {role === 'EXECUTOR' && (
                    <td className="px-5 py-3 text-slate-700">{member.pendingCount}</td>
                  )}
                  <td className="px-5 py-3 text-amber-600">{member.waitingVerifyCount}</td>
                  <td className="px-5 py-3 text-red-600">{member.overdueCount}</td>
                  <td className="px-5 py-3 text-blue-600">
                    {role === 'MANAGER' ? `${member.onTimeRate}%` : `${member.completionRate}%`}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

// PositionBoardTable
// 是什么：岗位分布榜单组件。
// 做什么：按岗位聚合展示成员数、任务量和风险指标。
// 为什么：团队页除了成员视角，还需要回答“哪些岗位压力大、风险高”。
const PositionBoardTable: React.FC<{
  title: string;
  role: 'MANAGER' | 'EXECUTOR';
  rows: TeamPositionStats[];
  emptyText: string;
  labels: {
    position: string;
    memberCount: string;
    taskLoad: string;
    pending: string;
    waitingVerify: string;
    overdue: string;
    dueSoon: string;
    rate: string;
  };
}> = ({ title, role, rows, emptyText, labels }) => {
  return (
    <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
        <span className="text-xs text-slate-400">{rows.length} 个岗位</span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-left px-5 py-3 font-medium">{labels.position}</th>
              <th className="text-left px-5 py-3 font-medium">{labels.memberCount}</th>
              <th className="text-left px-5 py-3 font-medium">{labels.taskLoad}</th>
              <th className="text-left px-5 py-3 font-medium">
                {role === 'MANAGER' ? labels.waitingVerify : labels.pending}
              </th>
              <th className="text-left px-5 py-3 font-medium">{labels.overdue}</th>
              <th className="text-left px-5 py-3 font-medium">{labels.dueSoon}</th>
              <th className="text-left px-5 py-3 font-medium">{labels.rate}</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td className="px-5 py-8 text-slate-400" colSpan={7}>
                  {emptyText}
                </td>
              </tr>
            ) : (
              rows.map((positionItem) => (
                <tr key={`${role}-${positionItem.position}`} className="border-t border-slate-100">
                  <td className="px-5 py-3 font-medium text-slate-800">{positionItem.position}</td>
                  <td className="px-5 py-3 text-slate-700">{positionItem.memberCount}</td>
                  <td className="px-5 py-3 text-slate-700">{positionItem.taskCount}</td>
                  <td className="px-5 py-3 text-amber-600">
                    {role === 'MANAGER' ? positionItem.waitingVerifyCount : positionItem.pendingCount}
                  </td>
                  <td className="px-5 py-3 text-red-600">{positionItem.overdueCount}</td>
                  <td className="px-5 py-3 text-amber-600">{positionItem.dueSoonCount}</td>
                  <td className="px-5 py-3 text-blue-600">
                    {role === 'MANAGER' ? `${positionItem.onTimeRate}%` : `${positionItem.completionRate}%`}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

const TeamStats: React.FC<TeamStatsProps> = ({ tasks }) => {
  const { t } = useTranslation();
  const [stats, setStats] = useState<TeamStatsSnapshot>(() => createEmptyTeamStatsSnapshot());
  const [loading, setLoading] = useState(false);
  const [errorText, setErrorText] = useState('');

  useEffect(() => {
    let active = true;

    const load = async () => {
      setLoading(true);

      try {
        const result = await getTeamStats();
        if (!active) {
          return;
        }

        setStats(result);
        setErrorText('');
      } catch (error) {
        if (!active) {
          return;
        }
        setErrorText(t.teamStatsLoadFailed);
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    };

    load();

    return () => {
      active = false;
    };
  }, [tasks, t.teamStatsLoadFailed]);

  const managerSummary = stats.summaries.manager;
  const executorSummary = stats.summaries.executor;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">{t.teamStatsTitle}</h1>
        <p className="text-sm text-slate-500 mt-1">{t.teamStatsDesc}</p>
      </div>

      {errorText && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-700">
          {errorText}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        <SummaryCard
          title={t.teamManagerRoleLabel}
          value={managerSummary.memberCount}
          subtext={`${t.teamManagerTaskCount} ${managerSummary.taskCount}`}
          icon={<Users className="w-4 h-4" />}
        />
        <SummaryCard
          title={t.teamExecutorRoleLabel}
          value={executorSummary.memberCount}
          subtext={`${t.teamExecutorTaskCount} ${executorSummary.taskCount}`}
          icon={<Users className="w-4 h-4" />}
        />
        <SummaryCard
          title={t.teamOnTimeRate}
          value={`${managerSummary.onTimeRate.toFixed(2)}%`}
          subtext={`${t.teamManagerRoleLabel}${t.completionRate} ${managerSummary.completionRate.toFixed(2)}%`}
          icon={<CheckCircle2 className="w-4 h-4" />}
        />
        <SummaryCard
          title={t.teamDueSoonCount}
          value={executorSummary.dueSoonCount}
          subtext={`${t.overdueTasks} ${executorSummary.overdueCount}`}
          icon={<Clock3 className="w-4 h-4" />}
        />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-slate-900">{t.teamManagerRoleLabel}</h2>
            <AlertTriangle className="w-4 h-4 text-amber-500" />
          </div>
          <div className="grid grid-cols-2 gap-4 mt-4 text-sm">
            <div>
              <p className="text-slate-500">{t.teamManagerTaskCount}</p>
              <p className="text-xl font-semibold text-slate-900 mt-1">{managerSummary.taskCount}</p>
            </div>
            <div>
              <p className="text-slate-500">{t.waitingAcceptance}</p>
              <p className="text-xl font-semibold text-amber-600 mt-1">{managerSummary.waitingVerifyCount}</p>
            </div>
            <div>
              <p className="text-slate-500">{t.overdueTasks}</p>
              <p className="text-xl font-semibold text-red-600 mt-1">{managerSummary.overdueCount}</p>
            </div>
            <div>
              <p className="text-slate-500">{t.teamOnTimeRate}</p>
              <p className="text-xl font-semibold text-blue-600 mt-1">{managerSummary.onTimeRate.toFixed(2)}%</p>
            </div>
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-slate-900">{t.teamExecutorRoleLabel}</h2>
            <CheckCircle2 className="w-4 h-4 text-blue-500" />
          </div>
          <div className="grid grid-cols-2 gap-4 mt-4 text-sm">
            <div>
              <p className="text-slate-500">{t.teamExecutorTaskCount}</p>
              <p className="text-xl font-semibold text-slate-900 mt-1">{executorSummary.taskCount}</p>
            </div>
            <div>
              <p className="text-slate-500">{t.pending}</p>
              <p className="text-xl font-semibold text-slate-700 mt-1">{executorSummary.pendingCount}</p>
            </div>
            <div>
              <p className="text-slate-500">{t.teamDueSoonCount}</p>
              <p className="text-xl font-semibold text-amber-600 mt-1">{executorSummary.dueSoonCount}</p>
            </div>
            <div>
              <p className="text-slate-500">{t.completionRate}</p>
              <p className="text-xl font-semibold text-blue-600 mt-1">{executorSummary.completionRate.toFixed(2)}%</p>
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <RoleBoardTable
          title={t.teamManagerBoard}
          role="MANAGER"
          rows={stats.members.manager}
          emptyText={loading ? `${t.syncing}...` : t.teamNoStats}
          labels={{
            person: t.creator,
            position: t.teamPosition,
            taskCount: t.teamManagerTaskCount,
            completed: t.status_COMPLETED,
            pending: t.pending,
            waitingVerify: t.status_WAITING_VERIFY,
            overdue: t.overdueTasks,
            onTimeRate: t.teamOnTimeRate,
            completionRate: t.completionRate,
          }}
        />

        <RoleBoardTable
          title={t.teamExecutorBoard}
          role="EXECUTOR"
          rows={stats.members.executor}
          emptyText={loading ? `${t.syncing}...` : t.teamNoStats}
          labels={{
            person: t.executor,
            position: t.teamPosition,
            taskCount: t.teamExecutorTaskCount,
            completed: t.status_COMPLETED,
            pending: t.status_PENDING,
            waitingVerify: t.status_WAITING_VERIFY,
            overdue: t.overdueTasks,
            onTimeRate: t.teamOnTimeRate,
            completionRate: t.completionRate,
          }}
        />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <PositionBoardTable
          title={t.teamManagerPositionBoard}
          role="MANAGER"
          rows={stats.positions.manager}
          emptyText={loading ? `${t.syncing}...` : t.teamNoStats}
          labels={{
            position: t.teamPosition,
            memberCount: t.teamMemberCount,
            taskLoad: t.teamTaskLoad,
            pending: t.pending,
            waitingVerify: t.status_WAITING_VERIFY,
            overdue: t.overdueTasks,
            dueSoon: t.teamDueSoonCount,
            rate: t.teamOnTimeRate,
          }}
        />

        <PositionBoardTable
          title={t.teamExecutorPositionBoard}
          role="EXECUTOR"
          rows={stats.positions.executor}
          emptyText={loading ? `${t.syncing}...` : t.teamNoStats}
          labels={{
            position: t.teamPosition,
            memberCount: t.teamMemberCount,
            taskLoad: t.teamTaskLoad,
            pending: t.status_PENDING,
            waitingVerify: t.status_WAITING_VERIFY,
            overdue: t.overdueTasks,
            dueSoon: t.teamDueSoonCount,
            rate: t.completionRate,
          }}
        />
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
