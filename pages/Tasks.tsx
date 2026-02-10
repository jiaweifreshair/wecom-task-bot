import React, { useState } from 'react';
import { Search, Filter, MoreVertical, RefreshCw, CheckCircle, XCircle } from 'lucide-react';
import { Task, TaskStatus } from '../types';
import StatusBadge from '../components/StatusBadge';
import { useTranslation } from '../contexts/LanguageContext';

interface TasksProps {
  tasks: Task[];
  onUpdateStatus: (taskId: number, newStatus: TaskStatus, reason?: string) => void;
}

const Tasks: React.FC<TasksProps> = ({ tasks, onUpdateStatus }) => {
  const [filter, setFilter] = useState<'ALL' | TaskStatus>('ALL');
  const [searchTerm, setSearchTerm] = useState('');
  const [rejectModalOpen, setRejectModalOpen] = useState<{ isOpen: boolean; taskId: number | null }>({ isOpen: false, taskId: null });
  const [rejectReason, setRejectReason] = useState('');
  const { t } = useTranslation();

  const filteredTasks = tasks.filter(task => {
    const matchesFilter = filter === 'ALL' || task.status === filter;
    const matchesSearch = task.title.toLowerCase().includes(searchTerm.toLowerCase()) || 
                          task.executor.name.toLowerCase().includes(searchTerm.toLowerCase());
    return matchesFilter && matchesSearch;
  });

  const handleRejectClick = (taskId: number) => {
    setRejectModalOpen({ isOpen: true, taskId });
    setRejectReason('');
  };

  const submitReject = () => {
    if (rejectModalOpen.taskId) {
      onUpdateStatus(rejectModalOpen.taskId, TaskStatus.REJECTED, rejectReason);
      setRejectModalOpen({ isOpen: false, taskId: null });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{t.taskManagement}</h1>
          <p className="text-slate-500 text-sm mt-1">{t.taskMgmtSubtitle}</p>
        </div>
        <button className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors shadow-sm shadow-blue-200 flex items-center gap-2">
          <span>{t.createTask}</span>
        </button>
      </div>

      {/* Filters & Search */}
      <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex flex-col md:flex-row gap-4 items-center justify-between">
        <div className="flex items-center gap-2 overflow-x-auto no-scrollbar w-full md:w-auto">
          <button 
            onClick={() => setFilter('ALL')}
            className={`px-4 py-2 text-sm font-medium rounded-lg whitespace-nowrap transition-colors ${filter === 'ALL' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'}`}
          >
            {t.allTasks} <span className="ml-1 opacity-70 bg-white/20 px-1.5 py-0.5 rounded-full text-xs">{tasks.length}</span>
          </button>
          <button 
            onClick={() => setFilter(TaskStatus.WAITING_VERIFY)}
            className={`px-4 py-2 text-sm font-medium rounded-lg whitespace-nowrap transition-colors ${filter === TaskStatus.WAITING_VERIFY ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`}
          >
            {t.waitingVerify} <span className={`ml-1 px-1.5 py-0.5 rounded-full text-xs ${filter === TaskStatus.WAITING_VERIFY ? 'bg-white/20' : 'bg-blue-100 text-blue-700'}`}>{tasks.filter(t => t.status === TaskStatus.WAITING_VERIFY).length}</span>
          </button>
          <button 
             onClick={() => setFilter(TaskStatus.PENDING)}
             className={`px-4 py-2 text-sm font-medium rounded-lg whitespace-nowrap transition-colors ${filter === TaskStatus.PENDING ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'}`}
          >
            {t.pending}
          </button>
          <button 
             onClick={() => setFilter(TaskStatus.REJECTED)}
             className={`px-4 py-2 text-sm font-medium rounded-lg whitespace-nowrap transition-colors ${filter === TaskStatus.REJECTED ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'}`}
          >
            {t.rejected}
          </button>
        </div>

        <div className="flex items-center gap-3 w-full md:w-auto">
          <div className="relative flex-1 md:w-64">
            <Search className="absolute left-3 top-2.5 w-4 h-4 text-slate-400" />
            <input 
              type="text" 
              placeholder={t.searchPlaceholder} 
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-9 pr-4 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:bg-white transition-all"
            />
          </div>
          <button className="p-2 text-slate-500 hover:bg-slate-100 rounded-lg border border-slate-200">
            <Filter className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Task Grid/List */}
      <div className="grid grid-cols-1 gap-4">
        {filteredTasks.length === 0 ? (
          <div className="text-center py-20 bg-white rounded-xl border border-slate-200 border-dashed">
            <p className="text-slate-500">{t.noTasks}</p>
          </div>
        ) : (
          filteredTasks.map((task) => (
            <div key={task.id} className={`bg-white rounded-xl p-5 border shadow-sm transition-all hover:shadow-md ${task.status === TaskStatus.WAITING_VERIFY ? 'border-blue-200 ring-1 ring-blue-100' : 'border-slate-200'}`}>
              <div className="flex flex-col lg:flex-row lg:items-center gap-4 lg:gap-8">
                {/* Main Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-3 mb-2">
                    <StatusBadge status={task.status} />
                    <span className="text-xs text-slate-400 flex items-center gap-1">
                      {t.due}: {new Date(task.endTime).toLocaleDateString()}
                    </span>
                    {task.redoCount > 0 && (
                      <span className="text-xs text-amber-600 bg-amber-50 px-2 py-0.5 rounded border border-amber-100 flex items-center gap-1">
                        <RefreshCw className="w-3 h-3" /> {t.redo}: {task.redoCount}
                      </span>
                    )}
                  </div>
                  <h3 className="text-lg font-semibold text-slate-900 truncate">{task.title}</h3>
                  <p className="text-sm text-slate-500 mt-1 line-clamp-2">{task.description}</p>
                </div>

                {/* People */}
                <div className="flex items-center gap-6 shrink-0">
                  <div className="flex flex-col gap-1">
                     <span className="text-[10px] uppercase tracking-wider text-slate-400 font-semibold">{t.creator}</span>
                     <div className="flex items-center gap-2">
                        <img src={task.creator.avatar} alt="" className="w-6 h-6 rounded-full border border-white shadow-sm" />
                        <span className="text-sm font-medium text-slate-700">{task.creator.name.split(' ')[0]}</span>
                     </div>
                  </div>
                  <div className="w-px h-8 bg-slate-200"></div>
                  <div className="flex flex-col gap-1">
                     <span className="text-[10px] uppercase tracking-wider text-slate-400 font-semibold">{t.executor}</span>
                     <div className="flex items-center gap-2">
                        <img src={task.executor.avatar} alt="" className="w-6 h-6 rounded-full border border-white shadow-sm" />
                        <span className="text-sm font-medium text-slate-700">{task.executor.name.split(' ')[0]}</span>
                     </div>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex lg:flex-col items-center gap-2 shrink-0 pt-4 lg:pt-0 border-t lg:border-t-0 lg:border-l border-slate-100 pl-0 lg:pl-6 w-full lg:w-auto">
                  {task.status === TaskStatus.WAITING_VERIFY && (
                    <>
                      <button 
                        onClick={() => onUpdateStatus(task.id, TaskStatus.COMPLETED)}
                        className="flex-1 lg:flex-none w-full flex items-center justify-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-700 text-white text-sm font-medium rounded-lg transition-colors shadow-sm"
                      >
                        <CheckCircle className="w-4 h-4" /> {t.pass}
                      </button>
                      <button 
                        onClick={() => handleRejectClick(task.id)}
                        className="flex-1 lg:flex-none w-full flex items-center justify-center gap-2 px-4 py-2 bg-white border border-red-200 text-red-600 hover:bg-red-50 text-sm font-medium rounded-lg transition-colors"
                      >
                        <XCircle className="w-4 h-4" /> {t.reject}
                      </button>
                    </>
                  )}
                  {task.status === TaskStatus.PENDING && (
                     <button 
                        onClick={() => onUpdateStatus(task.id, TaskStatus.WAITING_VERIFY)}
                        className="flex-1 lg:flex-none w-full px-4 py-2 bg-slate-900 hover:bg-slate-800 text-white text-sm font-medium rounded-lg transition-colors"
                     >
                       {t.markComplete}
                     </button>
                  )}
                  {(task.status === TaskStatus.COMPLETED || task.status === TaskStatus.REJECTED) && (
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

      {/* Reject Modal */}
      {rejectModalOpen.isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6 animate-in fade-in zoom-in duration-200">
            <h3 className="text-lg font-bold text-slate-900 mb-2">{t.rejectTitle}</h3>
            <p className="text-sm text-slate-500 mb-4">{t.rejectDesc}</p>
            <textarea
              className="w-full h-32 p-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-transparent outline-none text-sm resize-none mb-4"
              placeholder={t.enterReason}
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
            ></textarea>
            <div className="flex gap-3 justify-end">
              <button 
                onClick={() => setRejectModalOpen({ isOpen: false, taskId: null })}
                className="px-4 py-2 text-slate-600 hover:bg-slate-100 rounded-lg text-sm font-medium transition-colors"
              >
                {t.cancel}
              </button>
              <button 
                onClick={submitReject}
                disabled={!rejectReason.trim()}
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