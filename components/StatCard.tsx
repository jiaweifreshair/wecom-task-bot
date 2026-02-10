import React, { ReactNode } from 'react';

interface StatCardProps {
  title: string;
  value: string | number;
  change?: string;
  changeType?: 'positive' | 'negative' | 'neutral';
  subtext?: string;
  icon: ReactNode;
  colorClass: string;
}

const StatCard: React.FC<StatCardProps> = ({ title, value, change, changeType = 'positive', subtext, icon, colorClass }) => {
  return (
    <div className="bg-white rounded-xl p-6 shadow-sm border border-slate-100 hover:border-blue-100 transition-colors">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-medium text-slate-500">{title}</h3>
        <div className={`p-2 rounded-lg ${colorClass} bg-opacity-10 text-opacity-100`}>
          {icon}
        </div>
      </div>
      <div className="flex items-baseline gap-2">
        <span className="text-3xl font-bold text-slate-900">{value}</span>
        {change && (
          <span className={`text-xs font-medium px-2 py-0.5 rounded-full flex items-center gap-1 
            ${changeType === 'positive' ? 'text-green-700 bg-green-50' : 
              changeType === 'negative' ? 'text-red-700 bg-red-50' : 'text-gray-600 bg-gray-100'}`}>
             {change}
          </span>
        )}
      </div>
      {subtext && <p className="text-xs text-slate-400 mt-2">{subtext}</p>}
    </div>
  );
};

export default StatCard;