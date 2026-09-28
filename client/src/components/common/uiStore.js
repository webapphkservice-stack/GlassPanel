import { create } from 'zustand';

let toastSeq = 0;

export const useUIStore = create((set, get) => ({
  confirmState: null,
  toasts: [],
  // 弹出确认框，返回 Promise<boolean>
  confirm(opts) {
    return new Promise((resolve) => {
      set({ confirmState: { ...opts, resolve } });
    });
  },
  resolveConfirm(ok) {
    const cs = get().confirmState;
    set({ confirmState: null });
    cs?.resolve(ok);
  },
  // 弹出轻提示
  toast(message, type = 'info') {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts, { id, message, type }] }));
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    }, 3500);
  },
  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
}));