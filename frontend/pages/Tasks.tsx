import React, { useMemo, useState } from 'react';
import {
  Search,
  Filter,
  MoreVertical,
  RefreshCw,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Eye,
  Calendar,
  UserPlus,
} from 'lucide-react';
import { Task, TaskCreatePayload, TaskStatus } from '../types';
import StatusBadge from '../components/StatusBadge';
import { useTranslation } from '../contexts/LanguageContext';

interface TasksProps {
  tasks: Task[];
  onCreateTask: (payload: TaskCreatePayload) => Promise<void>;
  onCompleteTask: (taskId: number) => Promise<void>;
  onVerifyTask: (taskId: number, action: 'PASS' | 'REJECT', reason?: string) => Promise<void>;
}

interface CreateTaskFormState {
  title: string;
  description: string;
  executorUserId: string;
  startTime: string;
  endTime: string;
}

const defaultCreateTaskForm = (): CreateTaskFormState => {
  const now = new Date();
  const end = new Date(now.getTime() + 2 * 60 * 60 * 1000);

  const toDatetimeLocalValue = (date: Date) => {
    const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return localDate.toISOString().slice(0, 16);
  };

  return {
    title: '',
    description: '',
    executorUserId: '',
    startTime: toDatetimeLocalValue(now),
    endTime: toDatetimeLocalValue(end),
  };
};

const Tasks: React.FC<TasksProps> = ({ tasks, onCreateTask, onCompleteTask, onVerifyTask }) => {
  const [filter, setFilter] = useState<'ALL' | TaskStatus>('ALL');
  const [searchTerm, setSearchTerm] = useState('');
  const [rejectModalOpen, setRejectModalOpen] = useState<{ isOpen: boolean; taskId: number | null }>({
    isOpen: false,
    taskId: null,
  });
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [detailTaskId, setDetailTaskId] = useState<number | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [creating, setCreating] = useState(false);
  const [submittingTaskId, setSubmittingTaskId] = useState<number | null>(null);
  const [createForm, setCreateForm] = useState<CreateTaskFormState>(defaultCreateTaskForm());
  const { t } = useTranslation();

  const filteredTasks = tasks.filter((task) => {
    const matchesFilter = filter === 'ALL' || task.status === filter;
    const matchesSearch =
      task.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
      task.executor.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      task.creator.name.toLowerCase().includes(searchTerm.toLowerCase());
    return matchesFilter && matchesSearch;
  });

  const detailTask = useMemo(() => {
    return tasks.find((task) => task.id === detailTaskId) || null;
  }, [tasks, detailTaskId]);

  const executorCandidates = useMemo(() => {
    const userMap = new Map<string, string>();
    tasks.forEach((task) => {
      if (task.executor.id) {
        userMap.set(task.executor.id, task.executor.name);
      }
      if (task.creator.id) {
        userMap.set(task.creator.id, task.creator.name);
      }
    });
    return Array.from(userMap.entries()).map(([id, name]) => ({ id, name }));
  }, [tasks]);

  const handleRejectClick = (taskId: number) => {
    setRejectModalOpen({ isOpen: true, taskId });
    setRejectReason('');
  };

  const handleCreateTask = async () => {
    if (!createForm.title.trim() || !createForm.executorUserId || !createForm.endTime) {
      return;
    }

    try {
      setCreating(true);
      await onCreateTask({
        title: createForm.title.trim(),
        description: createForm.description.trim(),
        executorUserId: createForm.executorUserId,
        startTime: new Date(createForm.startTime).toISOString(),
        endTime: new Date(createForm.endTime).toISOString(),
      });
      setCreateModalOpen(false);
      setCreateForm(defaultCreateTaskForm());
    } finally {
      setCreating(false);
    }
  };

  const submitReject = async () => {
    if (!rejectModalOpen.taskId) {
      return;
    }

    try {
      setSubmittingTaskId(rejectModalOpen.taskId);
      await onVerifyTask(rejectModalOpen.taskId, 'REJECT', rejectReason);
      setRejectModalOpen({ isOpen: false, taskId: null });
      setRejectReason('');
    } finally {
      setSubmittingTaskId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{t.taskManagement}</h1>
          <p className="text-slate-500 text-sm mt-1">{t.taskMgmtSubtitle}</p>
        </div>
        <button
          onClick={() => setCreateModalOpen(true)}
          className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors shadow-sm shadow-blue-200 flex items-center gap-2"
        >
          <UserPlus className="w-4 h-4" />
          <span>{t.createTask}</span>
        </button>
      </div>

      <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex flex-col md:flex-row gap-4 items-center justify-between">
        <div className="flex items-center gap-2 overflow-x-auto no-scrollbar w-full md:w-auto">
          <button
            onClick={() => setFilter('ALL')}
            className={`px-4 py-2 text-sm font-medium rounded-lg whitespace-nowrap transition-colors ${
              filter === 'ALL' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            {t.allTasks}
            <span className="ml-1 opacity-70 bg-white/20 px-1.5 py-0.5 rounded-full text-xs">{tasks.length}</span>
          </button>
          <button
            onClick={() => setFilter(TaskStatus.WAITING_VERIFY)}
            className={`px-4 py-2 text-sm font-medium rounded-lg whitespace-nowrap transition-colors ${
              filter === TaskStatus.WAITING_VERIFY ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            {t.waitingVerify}
            <span
              className={`ml-1 px-1.5 py-0.5 rounded-full text-xs ${
                filter === TaskStatus.WAITING_VERIFY ? 'bg-white/20' : 'bg-blue-100 text-blue-700'
              }`}
            >
              {tasks.filter((item) => item.status === TaskStatus.WAITING_VERIFY).length}
            </span>
          </button>
          <button
            onClick={() => setFilter(TaskStatus.PENDING)}
            className={`px-4 py-2 text-sm font-medium rounded-lg whitespace-nowrap transition-colors ${
              filter === TaskStatus.PENDING ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            {t.pending}
          </button>
          <button
            onClick={() => setFilter(TaskStatus.COMPLETED)}
            className={`px-4 py-2 text-sm font-medium rounded-lg whitespace-nowrap transition-colors ${
              filter === TaskStatus.COMPLETED ? 'bg-green-600 text-white' : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            {t.status_COMPLETED}
          </button>
        </div>

        <div className="flex items-center gap-3 w-full md:w-auto">
          <div className="relative flex-1 md:w-64">
            <Search className="absolute left-3 top-2.5 w-4 h-4 text-slate-400" />
            <input
              type="text"
              placeholder={t.searchPlaceholder}
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              className="w-full pl-9 pr-4 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:bg-white transition-all"
            />
          </div>
          <button className="p-2 text-slate-500 hover:bg-slate-100 rounded-lg border border-slate-200">
            <Filter className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4">
        {filteredTasks.length === 0 ? (
          <div className="text-center py-20 bg-white rounded-xl border border-slate-200 border-dashed">
            <p className="text-slate-500">{t.noTasks}</p>
          </div>
        ) : (
          filteredTasks.map((task) => (
            <div
              key={task.id}
              className={`bg-white rounded-xl p-5 border shadow-sm transition-all hover:shadow-md ${
                task.status === TaskStatus.WAITING_VERIFY ? 'border-blue-200 ring-1 ring-blue-100' : 'border-slate-200'
              }`}
            >
              <div className="flex flex-col lg:flex-row lg:items-center gap-4 lg:gap-8">
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-3 mb-2">
                    <StatusBadge status={task.status} />
                    <span className="text-xs text-slate-400 flex items-center gap-1">
                      {t.due}: {new Date(task.endTime).toLocaleString()}
                    </span>
                    {task.redoCount > 0 && (
                      <span className="text-xs text-amber-600 bg-amber-50 px-2 py-0.5 rounded border border-amber-100 flex items-center gap-1">
                        <RefreshCw className="w-3 h-3" /> {t.redo}: {task.redoCount}
                      </span>
                    )}
                    {task.isOverdue && (
                      <span className="text-xs text-red-600 bg-red-50 px-2 py-0.5 rounded border border-red-100 flex items-center gap-1">
                        <AlertTriangle className="w-3 h-3" /> {t.overdueLabel}
                      </span>
                    )}
                    {!task.isOverdue && task.isDueSoon && (
                      <span className="text-xs text-amber-600 bg-amber-50 px-2 py-0.5 rounded border border-amber-100 flex items-center gap-1">
                        <AlertTriangle className="w-3 h-3" /> {t.dueSoonLabel}
                      </span>
                    )}
                  </div>
                  <h3 className="text-lg font-semibold text-slate-900 truncate">{task.title}</h3>
                  <p className="text-sm text-slate-500 mt-1 line-clamp-2">{task.description || '-'}</p>
                  {task.rejectReason && (
                    <p className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-lg px-2 py-1 mt-2 inline-block">
                      {t.rejectReasonLabel}: {task.rejectReason}
                    </p>
                  )}
                </div>

                <div className="flex items-center gap-6 shrink-0">
                  <div className="flex flex-col gap-1">
                    <span className="text-[10px] uppercase tracking-wider text-slate-400 font-semibold">{t.creator}</span>
                    <div className="flex items-center gap-2">
                      <img
                        src={task.creator.avatar || 'https://via.placeholder.com/24'}
                        alt=""
                        className="w-6 h-6 rounded-full border border-white shadow-sm"
                      />
                      <span className="text-sm font-medium text-slate-700">{task.creator.name}</span>
                    </div>
                  </div>
                  <div className="w-px h-8 bg-slate-200" />
                  <div className="flex flex-col gap-1">
                    <span className="text-[10px] uppercase tracking-wider text-slate-400 font-semibold">{t.executor}</span>
                    <div className="flex items-center gap-2">
                      <img
                        src={task.executor.avatar || 'https://via.placeholder.com/24'}
                        alt=""
                        className="w-6 h-6 rounded-full border border-white shadow-sm"
                      />
                      <span className="text-sm font-medium text-slate-700">{task.executor.name}</span>
                    </div>
                  </div>
                </div>

                <div className="flex lg:flex-col items-center gap-2 shrink-0 pt-4 lg:pt-0 border-t lg:border-t-0 lg:border-l border-slate-100 pl-0 lg:pl-6 w-full lg:w-auto">
                  <button
                    onClick={() => setDetailTaskId(task.id)}
                    className="flex-1 lg:flex-none w-full px-4 py-2 border border-slate-200 text-slate-700 hover:bg-slate-50 text-sm font-medium rounded-lg transition-colors flex items-center justify-center gap-2"
                  >
                    <Eye className="w-4 h-4" />
                    {t.viewDetail}
                  </button>

                  {task.canVerify && task.status === TaskStatus.WAITING_VERIFY && (
                    <>
                      <button
                        onClick={async () => {
                          try {
                            setSubmittingTaskId(task.id);
                            await onVerifyTask(task.id, 'PASS');
                          } finally {
                            setSubmittingTaskId(null);
                          }
                        }}
                        disabled={submittingTaskId === task.id}
                        className="flex-1 lg:flex-none w-full flex items-center justify-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-700 text-white text-sm font-medium rounded-lg transition-colors shadow-sm disabled:opacity-50"
                      >
                        <CheckCircle className="w-4 h-4" /> {t.pass}
                      </button>
                      <button
                        onClick={() => handleRejectClick(task.id)}
                        disabled={submittingTaskId === task.id}
                        className="flex-1 lg:flex-none w-full flex items-center justify-center gap-2 px-4 py-2 bg-white border border-red-200 text-red-600 hover:bg-red-50 text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
                      >
                        <XCircle className="w-4 h-4" /> {t.reject}
                      </button>
                    </>
                  )}

                  {task.canComplete && task.status === TaskStatus.PENDING && (
                    <button
                      onClick={async () => {
                        try {
                          setSubmittingTaskId(task.id);
                          await onCompleteTask(task.id);
                        } finally {
                          setSubmittingTaskId(null);
                        }
                      }}
                      disabled={submittingTaskId === task.id}
                      className="flex-1 lg:flex-none w-full px-4 py-2 bg-slate-900 hover:bg-slate-800 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
                    >
                      {t.markComplete}
                    </button>
                  )}

                  {!task.canComplete && !task.canVerify && (
                    <button className="flex-1 lg:flex-none w-full px-4 py-2 text-slate-400 hover:text-slate-600 transition-colors">
                      <MoreVertical className="w-5 h-5 mx-auto" />
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {createModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="bg-white rounded-xl shadow-xl max-w-lg w-full p-6 animate-in fade-in zoom-in duration-200">
            <h3 className="text-lg font-bold text-slate-900 mb-2">{t.createTaskTitle}</h3>
            <p className="text-sm text-slate-500 mb-4">{t.createTaskDesc}</p>

            <div className="space-y-3">
              <input
                value={createForm.title}
                onChange={(event) => setCreateForm((prev) => ({ ...prev, title: event.target.value }))}
                placeholder={t.createTaskTitlePlaceholder}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />

              <textarea
                value={createForm.description}
                onChange={(event) => setCreateForm((prev) => ({ ...prev, description: event.target.value }))}
                placeholder={t.createTaskDescPlaceholder}
                className="w-full h-24 px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
              />

              <select
                value={createForm.executorUserId}
                onChange={(event) => setCreateForm((prev) => ({ ...prev, executorUserId: event.target.value }))}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">{t.selectExecutor}</option>
                {executorCandidates.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name} ({candidate.id})
                  </option>
                ))}
              </select>

              <input
                value={createForm.executorUserId}
                onChange={(event) => setCreateForm((prev) => ({ ...prev, executorUserId: event.target.value.trim() }))}
                placeholder={t.executorIdInputPlaceholder}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-slate-500 mb-1">{t.startTime}</label>
                  <input
                    type="datetime-local"
                    value={createForm.startTime}
                    onChange={(event) => setCreateForm((prev) => ({ ...prev, startTime: event.target.value }))}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1">{t.endTime}</label>
                  <input
                    type="datetime-local"
                    value={createForm.endTime}
                    onChange={(event) => setCreateForm((prev) => ({ ...prev, endTime: event.target.value }))}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>
            </div>

            <div className="flex gap-3 justify-end mt-5">
              <button
                onClick={() => {
                  setCreateModalOpen(false);
                  setCreateForm(defaultCreateTaskForm());
                }}
                className="px-4 py-2 text-slate-600 hover:bg-slate-100 rounded-lg text-sm font-medium transition-colors"
              >
                {t.cancel}
              </button>
              <button
                onClick={handleCreateTask}
                disabled={!createForm.title.trim() || !createForm.executorUserId || creating}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg text-sm font-medium transition-colors"
              >
                {creating ? t.creatingTask : t.confirmCreateTask}
              </button>
            </div>
          </div>
        </div>
      )}

      {detailTask && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="bg-white rounded-xl shadow-xl max-w-lg w-full p-6 animate-in fade-in zoom-in duration-200">
            <div className="flex items-start justify-between gap-3 mb-4">
              <div>
                <h3 className="text-lg font-bold text-slate-900">{detailTask.title}</h3>
                <p className="text-sm text-slate-500 mt-1">{t.taskDetailSubtitle}</p>
              </div>
              <StatusBadge status={detailTask.status} />
            </div>

            <div className="space-y-3 text-sm">
              <div className="flex items-start gap-2">
                <Calendar className="w-4 h-4 mt-0.5 text-slate-400" />
                <div>
                  <p className="text-slate-700">
                    {t.startTime}: {new Date(detailTask.startTime).toLocaleString()}
                  </p>
                  <p className="text-slate-700">
                    {t.endTime}: {new Date(detailTask.endTime).toLocaleString()}
                  </p>
                </div>
              </div>
              <p className="text-slate-700">{detailTask.description || '-'}</p>
              <p className="text-slate-500">
                {t.creator}: {detailTask.creator.name}
              </p>
              <p className="text-slate-500">
                {t.executor}: {detailTask.executor.name}
              </p>
              {detailTask.rejectReason && (
                <p className="text-red-600">
                  {t.rejectReasonLabel}: {detailTask.rejectReason}
                </p>
              )}
            </div>

            <div className="flex gap-3 justify-end mt-6">
              <button
                onClick={() => setDetailTaskId(null)}
                className="px-4 py-2 text-slate-600 hover:bg-slate-100 rounded-lg text-sm font-medium transition-colors"
              >
                {t.close}
              </button>
            </div>
          </div>
        </div>
      )}

      {rejectModalOpen.isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6 animate-in fade-in zoom-in duration-200">
            <h3 className="text-lg font-bold text-slate-900 mb-2">{t.rejectTitle}</h3>
            <p className="text-sm text-slate-500 mb-4">{t.rejectDesc}</p>
            <textarea
              className="w-full h-32 p-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-transparent outline-none text-sm resize-none mb-4"
              placeholder={t.enterReason}
              value={rejectReason}
              onChange={(event) => setRejectReason(event.target.value)}
            />
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setRejectModalOpen({ isOpen: false, taskId: null })}
                className="px-4 py-2 text-slate-600 hover:bg-slate-100 rounded-lg text-sm font-medium transition-colors"
              >
                {t.cancel}
              </button>
              <button
                onClick={submitReject}
                disabled={!rejectReason.trim() || submittingTaskId === rejectModalOpen.taskId}
                className="px-4 py-2 bg-red-600 hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg text-sm font-medium transition-colors"
              >
                {t.confirmReject}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Tasks;
