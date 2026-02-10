import React from 'react';
import { TaskStatus } from '../types';
import { useTranslation } from '../contexts/LanguageContext';

interface StatusBadgeProps {
  status: TaskStatus;
}

const StatusBadge: React.FC<StatusBadgeProps> = ({ status }) => {
  const { t } = useTranslation();

  switch (status) {
    case TaskStatus.PENDING:
      return (
        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-800 border border-gray-200">
          {t.status_PENDING}
        </span>
      );
    case TaskStatus.WAITING_VERIFY:
      return (
        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800 border border-blue-200">
          {t.status_WAITING_VERIFY}
        </span>
      );
    case TaskStatus.COMPLETED:
      return (
        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800 border border-green-200">
          {t.status_COMPLETED}
        </span>
      );
    case TaskStatus.REJECTED:
      return (
        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800 border border-red-200">
          {t.status_REJECTED}
        </span>
      );
    default:
      return null;
  }
};

export default StatusBadge;