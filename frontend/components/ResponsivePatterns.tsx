import React, { useCallback, useEffect, useRef, useState } from 'react';

// useBreakpoint
// 是什么：响应式断点检测 hook。
// 做什么：实时检测当前视口宽度所属断点（mobile / tablet / desktop）。
// 为什么：需求 9.1-9.3 要求不同断点使用不同交互模式。
export type Breakpoint = 'mobile' | 'tablet' | 'desktop';

export const useBreakpoint = (): Breakpoint => {
  const [bp, setBp] = useState<Breakpoint>(() => {
    if (typeof window === 'undefined') return 'desktop';
    const w = window.innerWidth;
    if (w < 768) return 'mobile';
    if (w < 1024) return 'tablet';
    return 'desktop';
  });

  useEffect(() => {
    const onResize = () => {
      const w = window.innerWidth;
      if (w < 768) setBp('mobile');
      else if (w < 1024) setBp('tablet');
      else setBp('desktop');
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return bp;
};

// useUnsavedChangesWarning
// 是什么：未保存变更离开提示 hook。
// 做什么：当 dirty 为 true 时，拦截页面关闭/刷新并弹出浏览器原生确认。
// 为什么：需求 9.12 要求未保存编辑状态离开时提示。
export const useUnsavedChangesWarning = (dirty: boolean) => {
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);
};

// BottomDrawer
// 是什么：全屏底部抽屉组件。
// 做什么：从底部滑入的全屏面板，用于移动端表单展示。
// 为什么：需求 7.15, 9.2, 9.5 要求移动端使用全屏底部 Drawer。
interface BottomDrawerProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
}

export const BottomDrawer: React.FC<BottomDrawerProps> = ({ open, onClose, title, children }) => {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/50" onClick={onClose}>
      <div className="flex-1" />
      <div
        className="schedule-enter max-h-[90vh] overflow-y-auto rounded-t-2xl bg-white"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3">
          <h3 className="text-base font-semibold text-slate-900">{title || ''}</h3>
          <button
            onClick={onClose}
            className="min-h-[44px] min-w-[44px] rounded-lg text-sm text-slate-500 hover:bg-slate-100"
            aria-label="关闭"
          >
            ✕
          </button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
};

// Popconfirm
// 是什么：轻量级确认气泡组件。
// 做什么：桌面端删除确认，紧贴触发按钮位置。
// 为什么：需求 9.7 要求桌面端使用 Popconfirm 而非全屏模态弹窗。
interface PopconfirmProps {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  message?: string;
  confirmText?: string;
  cancelText?: string;
  loading?: boolean;
}

export const Popconfirm: React.FC<PopconfirmProps> = ({
  open,
  onConfirm,
  onCancel,
  message = '确定要删除吗？',
  confirmText = '确定',
  cancelText = '取消',
  loading = false,
}) => {
  if (!open) return null;
  return (
    <div className="absolute bottom-full left-1/2 z-30 mb-2 -translate-x-1/2 animate-in fade-in zoom-in">
      <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-lg" style={{ minWidth: 200 }}>
        <p className="text-sm text-slate-700">{message}</p>
        <div className="mt-3 flex items-center justify-end gap-2">
          <button
            onClick={onCancel}
            className="min-h-[36px] rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
            disabled={loading}
          >
            {cancelText}
          </button>
          <button
            onClick={onConfirm}
            className="min-h-[36px] rounded-lg bg-rose-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-rose-700 disabled:opacity-60"
            disabled={loading}
          >
            {loading ? '删除中...' : confirmText}
          </button>
        </div>
      </div>
    </div>
  );
};

// MobileActionSheet
// 是什么：移动端底部操作面板组件。
// 做什么：移动端删除确认，按钮区域 ≥ 44×44px。
// 为什么：需求 9.8 要求移动端使用底部 Action Sheet。
interface MobileActionSheetProps {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  message?: string;
  confirmText?: string;
  cancelText?: string;
  loading?: boolean;
}

export const MobileActionSheet: React.FC<MobileActionSheetProps> = ({
  open,
  onConfirm,
  onCancel,
  message = '确定要删除吗？此操作不可撤销。',
  confirmText = '确定删除',
  cancelText = '取消',
  loading = false,
}) => {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/50" onClick={onCancel}>
      <div className="flex-1" />
      <div
        className="schedule-enter rounded-t-2xl bg-white p-4 pb-8"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="mb-4 text-center text-sm text-slate-700">{message}</p>
        <div className="space-y-2">
          <button
            onClick={onConfirm}
            className="min-h-[44px] w-full rounded-xl bg-rose-600 px-4 py-3 text-sm font-medium text-white hover:bg-rose-700 disabled:opacity-60"
            disabled={loading}
          >
            {loading ? '删除中...' : confirmText}
          </button>
          <button
            onClick={onCancel}
            className="min-h-[44px] w-full rounded-xl border border-slate-200 px-4 py-3 text-sm text-slate-600 hover:bg-slate-50"
            disabled={loading}
          >
            {cancelText}
          </button>
        </div>
      </div>
    </div>
  );
};
