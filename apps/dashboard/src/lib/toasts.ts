import { create } from 'zustand';

/**
 * Toast queue — tiny Zustand slice for the top-right notification
 * cards. Any component can push a toast; the `<Toasts />` renderer
 * subscribes and displays them. Each toast auto-dismisses after
 * `ttlMs` (default 4500ms) and can also be dismissed manually.
 *
 * We deliberately don't do "toast IDs are hashes of content" — the
 * staff might legitimately want to see two "New order at Table 3"
 * cards if two orders came in back to back. So every push gets a
 * fresh id.
 */

export type ToastTone = 'brand' | 'sage' | 'saffron' | 'alert';

export interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  body?: string;
  href?: string;      // optional deep-link path
  ttlMs?: number;
}

interface ToastStore {
  toasts: Toast[];
  push: (t: Omit<Toast, 'id'>) => void;
  dismiss: (id: number) => void;
}

let _seq = 1;

export const useToasts = create<ToastStore>((set) => ({
  toasts: [],
  push: (t) => {
    const id = _seq++;
    const toast: Toast = { id, ttlMs: 4500, ...t };
    set((s) => ({ toasts: [...s.toasts, toast] }));
    // Auto-dismiss via a plain setTimeout — no interval bookkeeping
    // needed since each toast owns its own timer and gets removed
    // by id.
    window.setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) }));
    }, toast.ttlMs);
  },
  dismiss: (id) =>
    set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
}));
