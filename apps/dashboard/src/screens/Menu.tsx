import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  Camera,
  Plus,
  Pencil,
  Trash2,
  RotateCcw,
  Utensils,
  X,
  Check,
  Sparkles,
  ArchiveRestore,
} from 'lucide-react';
import { clsx } from 'clsx';
import { api } from '../lib/api';
import type { ApiException } from '../lib/api';
import { useAuthStore } from '../lib/auth';
import { ScanMenuModal, type ScannedItem } from '../components/ScanMenuModal';

// ── Types (mirror the backend schemas) ─────────────────────────────

type Category = 'starter' | 'main' | 'side' | 'bread' | 'drink' | 'dessert';

interface MenuItem {
  id: string;
  restaurant_id: string;
  name: string;
  description: string | null;
  price_minor: number;
  category: string | null;
  is_reward_eligible: boolean;
  is_active: boolean;
  reference_image_url: string | null;
}

const CATEGORIES: Category[] = ['starter', 'main', 'side', 'bread', 'drink', 'dessert'];

// ── Toast plumbing — dead-simple in-component queue ────────────────

interface Toast {
  id: number;
  message: string;
  action?: { label: string; onClick: () => void };
  tone: 'default' | 'success';
}

/**
 * Menu — the staff CRUD surface for menu items.
 *
 * Layout: page heading, action bar with "Scan menu card" (primary) +
 * "Add dish" (outline), list of items grouped by category, edit side
 * sheet, scan modal. Undo toast makes soft delete recoverable in one tap.
 *
 * All three staff roles can reach this screen — the API guard was
 * widened to `_require_any_restaurant_staff` in Commit 1.
 */
export function Menu() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { token, restaurantId } = useAuthStore();
  const qc = useQueryClient();

  const [showArchived, setShowArchived] = useState(false);
  const [sheet, setSheet] = useState<
    { mode: 'create'; item: null } | { mode: 'edit'; item: MenuItem } | null
  >(null);
  const [scanOpen, setScanOpen] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    if (!token) navigate('/login');
  }, [token, navigate]);

  const { data, isLoading, error } = useQuery({
    queryKey: ['menu-items', restaurantId, showArchived],
    queryFn: () =>
      api.get<MenuItem[]>(
        `/restaurants/${restaurantId}/menu-items?include_inactive=${showArchived ? 'true' : 'false'}`,
        token,
      ),
    enabled: Boolean(restaurantId && token),
  });

  const items = data ?? [];
  const activeCount = items.filter((i) => i.is_active).length;

  // Grouped by category so the same order the diner sees is what the
  // staff sees when editing. `null` (uncategorized) goes last.
  const grouped = useMemo(() => {
    const map = new Map<string | null, MenuItem[]>();
    for (const it of items) {
      const key = (it.category as Category) ?? null;
      const arr = map.get(key) ?? [];
      arr.push(it);
      map.set(key, arr);
    }
    const order: (Category | null)[] = [...CATEGORIES, null];
    return order
      .filter((c) => map.has(c))
      .map((c) => ({ category: c, rows: map.get(c) ?? [] }));
  }, [items]);

  function invalidate() {
    void qc.invalidateQueries({ queryKey: ['menu-items', restaurantId] });
  }

  function pushToast(toast: Omit<Toast, 'id'>) {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { ...toast, id }]);
    const ttl = toast.action ? 6_000 : 3_000;
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((x) => x.id !== id));
    }, ttl);
  }

  const remove = useMutation({
    mutationFn: (itemId: string) =>
      api.del<MenuItem>(
        `/restaurants/${restaurantId}/menu-items/${itemId}`,
        token,
      ),
    onSuccess: (removed) => {
      invalidate();
      pushToast({
        tone: 'default',
        message: t('menu_editor.delete_confirm_toast', { name: removed.name }),
        action: {
          label: t('menu_editor.undo'),
          onClick: () => void restore.mutate(removed),
        },
      });
    },
  });

  const restore = useMutation({
    mutationFn: (item: MenuItem) =>
      api.patch<MenuItem>(
        `/restaurants/${restaurantId}/menu-items/${item.id}`,
        { is_active: true },
        token,
      ),
    onSuccess: (updated) => {
      invalidate();
      pushToast({
        tone: 'success',
        message: t('menu_editor.restored_toast', { name: updated.name }),
      });
    },
  });

  async function persistScannedItems(picked: ScannedItem[]) {
    if (picked.length === 0) return;
    await api.post(
      `/restaurants/${restaurantId}/menu-items`,
      {
        items: picked.map((p) => ({
          name: p.name,
          description: null,
          price_minor: p.price_minor,
          category: p.category,
          is_reward_eligible: false,
        })),
      },
      token,
    );
    setScanOpen(false);
    invalidate();
    pushToast({
      tone: 'success',
      message: t('menu_editor.scan_toast_added', { count: picked.length }),
    });
  }

  if (!restaurantId) {
    return (
      <p className="text-s-muted text-sm">
        {t('summary.pick_restaurant')}
      </p>
    );
  }

  return (
    <section className="flex flex-col gap-4 pb-6">
      <header className="flex flex-col gap-2">
        <div className="row spread items-end flex-wrap gap-2">
          <div>
            <div className="text-[12px] font-semibold text-s-muted dev uppercase tracking-wide">
              {t('app.nav.menu')}
            </div>
            <h1 className="display text-[28px] text-s-ink leading-tight">
              {t('menu_editor.title')}
            </h1>
          </div>
          <div className="row gap-2 flex-wrap">
            <button
              onClick={() => setShowArchived((v) => !v)}
              className={clsx(
                'chip transition',
                showArchived
                  ? 'bg-brand text-white'
                  : 'bg-s-paper border border-s-line text-s-muted hover:text-s-ink',
              )}
              aria-pressed={showArchived}
            >
              <ArchiveRestore size={12} />
              {showArchived
                ? t('menu_editor.hide_archived')
                : t('menu_editor.show_archived')}
            </button>
            <button
              onClick={() => setSheet({ mode: 'create', item: null })}
              className="btn btn-outline text-[14px] min-h-[40px] px-4"
            >
              <Plus size={16} />
              {t('menu_editor.add_button')}
            </button>
            <button
              onClick={() => setScanOpen(true)}
              className="btn btn-primary text-[14px] min-h-[40px] px-4"
            >
              <Camera size={16} />
              {t('menu_editor.scan_button')}
            </button>
          </div>
        </div>
        <div className="text-[13px] text-s-muted">
          {t('menu_editor.count_active', { count: activeCount })}
        </div>
      </header>

      {isLoading && (
        <p className="text-s-muted text-sm">{t('menu_editor.title')}…</p>
      )}
      {error && (
        <p className="text-sm text-danger bg-danger-wash border border-danger/20 rounded-md px-3 py-2">
          {(error as ApiException).message}
        </p>
      )}

      {!isLoading && items.length === 0 && (
        <div className="empty rounded-lg border border-s-line bg-s-paper">
          <div className="art">
            <Utensils size={32} />
          </div>
          <p className="text-[15px] font-semibold text-s-ink">
            {t('menu_editor.empty_title')}
          </p>
          <p className="text-[13px] text-s-muted mt-1.5 max-w-[42ch]">
            {t('menu_editor.empty_blurb')}
          </p>
          <div className="row gap-2 mt-4">
            <button
              onClick={() => setScanOpen(true)}
              className="btn btn-primary text-[14px] min-h-[40px] px-4"
            >
              <Camera size={16} />
              {t('menu_editor.scan_button')}
            </button>
            <button
              onClick={() => setSheet({ mode: 'create', item: null })}
              className="btn btn-outline text-[14px] min-h-[40px] px-4"
            >
              <Plus size={16} />
              {t('menu_editor.add_button')}
            </button>
          </div>
        </div>
      )}

      {grouped.map(({ category, rows }) => (
        <section key={category ?? '__uncat'} className="flex flex-col gap-2">
          <div className="row gap-2 items-baseline px-1">
            <span className="text-[11px] font-semibold text-s-muted dev uppercase tracking-wide">
              {category
                ? t(`admin.menu.category.${category}`, {
                    defaultValue: category,
                  })
                : '—'}
            </span>
            <span className="text-[11px] text-s-muted/70">
              · {rows.length}
            </span>
          </div>
          <div className="rounded-lg border border-s-line bg-s-paper overflow-hidden">
            {rows.map((it, idx) => (
              <ItemRow
                key={it.id}
                item={it}
                showDivider={idx < rows.length - 1}
                onEdit={() => setSheet({ mode: 'edit', item: it })}
                onDelete={() => remove.mutate(it.id)}
                onRestore={() => restore.mutate(it)}
                t={t}
              />
            ))}
          </div>
        </section>
      ))}

      {sheet && (
        <EditSheet
          mode={sheet.mode}
          item={sheet.item}
          restaurantId={restaurantId}
          token={token}
          onClose={() => setSheet(null)}
          onSaved={() => {
            setSheet(null);
            invalidate();
          }}
        />
      )}

      {scanOpen && (
        <ScanMenuModal
          restaurantId={restaurantId}
          token={token}
          onClose={() => setScanOpen(false)}
          onConfirmed={persistScannedItems}
        />
      )}

      <ToastStack
        toasts={toasts}
        onDismiss={(id) => setToasts((p) => p.filter((x) => x.id !== id))}
      />
    </section>
  );
}

/* ── Row ───────────────────────────────────────────────────────────── */

function ItemRow({
  item,
  showDivider,
  onEdit,
  onDelete,
  onRestore,
  t,
}: {
  item: MenuItem;
  showDivider: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onRestore: () => void;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  return (
    <div
      className={clsx(
        'px-4 py-3 row gap-3.5 items-center',
        showDivider && 'border-b border-s-line',
        !item.is_active && 'bg-s-bg/40',
      )}
    >
      <div className="flex-1 min-w-0">
        <div className="row gap-2 items-center flex-wrap">
          <span
            className={clsx(
              'font-semibold text-[14px]',
              item.is_active ? 'text-s-ink' : 'text-s-muted line-through',
            )}
          >
            {item.name}
          </span>
          {item.is_reward_eligible && (
            <span className="chip chip-saffron">
              <Sparkles size={11} />
              {t('menu_editor.reward_toggle')}
            </span>
          )}
          {!item.is_active && (
            <span className="chip chip-muted">
              {t('menu_editor.archived_badge')}
            </span>
          )}
        </div>
        {item.description && (
          <p className="text-[12.5px] text-s-muted mt-0.5 line-clamp-1">
            {item.description}
          </p>
        )}
      </div>
      <div className="tnum text-[15px] font-bold text-s-ink whitespace-nowrap">
        ₹{(item.price_minor / 100).toFixed(0)}
      </div>
      <div className="row gap-1">
        {item.is_active ? (
          <>
            <button
              onClick={onEdit}
              aria-label={t('menu_editor.edit')}
              className="w-9 h-9 rounded-md hover:bg-s-bg flex items-center justify-center text-s-muted hover:text-s-ink transition"
            >
              <Pencil size={15} />
            </button>
            <button
              onClick={onDelete}
              aria-label={t('menu_editor.delete')}
              className="w-9 h-9 rounded-md hover:bg-danger-wash flex items-center justify-center text-s-muted hover:text-danger transition"
            >
              <Trash2 size={15} />
            </button>
          </>
        ) : (
          <button
            onClick={onRestore}
            className="chip chip-brand"
          >
            <RotateCcw size={12} />
            {t('menu_editor.restore')}
          </button>
        )}
      </div>
    </div>
  );
}

/* ── Edit sheet — create + edit share the same form ────────────────── */

function EditSheet({
  mode,
  item,
  restaurantId,
  token,
  onClose,
  onSaved,
}: {
  mode: 'create' | 'edit';
  item: MenuItem | null;
  restaurantId: string;
  token: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(item?.name ?? '');
  const [description, setDescription] = useState(item?.description ?? '');
  const [priceRupees, setPriceRupees] = useState(
    item ? String(Math.round(item.price_minor / 100)) : '',
  );
  const [category, setCategory] = useState<Category | ''>(
    (item?.category as Category) ?? '',
  );
  const [rewardEligible, setRewardEligible] = useState(
    item?.is_reward_eligible ?? false,
  );
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      const priceMinor = Math.max(0, Math.round(Number(priceRupees) * 100) || 0);
      if (!name.trim()) throw new Error('name');
      if (mode === 'create') {
        return api.post(
          `/restaurants/${restaurantId}/menu-items`,
          {
            items: [
              {
                name: name.trim(),
                description: description.trim() || null,
                price_minor: priceMinor,
                category: category || null,
                is_reward_eligible: rewardEligible,
              },
            ],
          },
          token,
        );
      }
      return api.patch(
        `/restaurants/${restaurantId}/menu-items/${item!.id}`,
        {
          name: name.trim(),
          description: description.trim() || null,
          price_minor: priceMinor,
          category: category || null,
          is_reward_eligible: rewardEligible,
        },
        token,
      );
    },
    onSuccess: onSaved,
    onError: (e: ApiException) => setError(e.message ?? 'Save failed'),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    save.mutate();
  }

  return (
    <div className="fixed inset-0 z-40 bg-black/25 flex items-stretch justify-end">
      <button
        onClick={onClose}
        aria-label={t('menu_editor.cancel')}
        className="flex-1 cursor-default"
      />
      <form
        onSubmit={submit}
        className="w-full max-w-[440px] h-full bg-s-paper border-l border-s-line flex flex-col shadow-pop"
      >
        <div className="px-5 pt-4 pb-3 border-b border-s-line row spread items-start">
          <div>
            <div className="text-[12px] font-semibold text-s-muted dev uppercase tracking-wide">
              {t('app.nav.menu')}
            </div>
            <h2 className="display text-[22px] text-s-ink leading-tight">
              {mode === 'edit'
                ? t('menu_editor.sheet_edit_title')
                : t('menu_editor.sheet_new_title')}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-md hover:bg-s-bg flex items-center justify-center text-s-muted"
          >
            <X size={16} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-semibold text-s-ink">
              {t('menu_editor.field_name')}
            </span>
            <input
              autoFocus
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="input mt-0"
              maxLength={120}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-semibold text-s-ink">
              {t('menu_editor.field_description')}
            </span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="rounded-md border border-s-line bg-s-bg/40 px-3 py-2 text-[14px] text-s-ink focus:bg-white focus:border-brand focus:outline-none transition"
              maxLength={400}
            />
            <span className="text-[11.5px] text-s-muted">
              {t('menu_editor.field_description_hint')}
            </span>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-semibold text-s-ink">
              {t('menu_editor.field_price')}
            </span>
            <input
              required
              type="number"
              min={0}
              step={10}
              value={priceRupees}
              onChange={(e) => setPriceRupees(e.target.value)}
              className="input mt-0 tnum"
              placeholder="e.g. 250"
            />
          </label>
          <div className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-semibold text-s-ink">
              {t('menu_editor.field_category')}
            </span>
            <div className="flex flex-wrap gap-1.5">
              {CATEGORIES.map((c) => {
                const active = category === c;
                return (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setCategory(active ? '' : c)}
                    className={clsx(
                      'chip transition',
                      active
                        ? 'bg-brand text-white'
                        : 'bg-s-bg border border-s-line text-s-muted hover:text-s-ink',
                    )}
                    aria-pressed={active}
                  >
                    {t(`admin.menu.category.${c}`, { defaultValue: c })}
                  </button>
                );
              })}
            </div>
            <span className="text-[11.5px] text-s-muted">
              {t('menu_editor.field_category_hint')}
            </span>
          </div>
          <label className="row gap-3 items-start cursor-pointer">
            <input
              type="checkbox"
              checked={rewardEligible}
              onChange={(e) => setRewardEligible(e.target.checked)}
              className="mt-0.5 accent-brand"
            />
            <div>
              <div className="text-[13px] font-semibold text-s-ink">
                {t('menu_editor.reward_toggle')}
              </div>
              <div className="text-[11.5px] text-s-muted">
                {t('menu_editor.reward_toggle_hint')}
              </div>
            </div>
          </label>
          {error && (
            <p className="text-sm text-danger bg-danger-wash border border-danger/20 rounded-md px-3 py-2">
              {error}
            </p>
          )}
        </div>
        <div className="px-5 py-3 border-t border-s-line row gap-2 bg-s-paper">
          <button
            type="button"
            onClick={onClose}
            className="btn btn-outline flex-1 min-h-[44px] text-[14px]"
          >
            {t('menu_editor.cancel')}
          </button>
          <button
            type="submit"
            disabled={save.isPending}
            className="btn btn-primary flex-1 min-h-[44px] text-[14px] disabled:opacity-50"
          >
            <Check size={16} />
            {save.isPending
              ? t('menu_editor.saving')
              : t('menu_editor.save')}
          </button>
        </div>
      </form>
    </div>
  );
}

/* ── Toasts ────────────────────────────────────────────────────────── */

function ToastStack({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}) {
  if (toasts.length === 0) return null;
  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex flex-col gap-2 items-center">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={clsx(
            'rounded-md shadow-pop px-4 py-2.5 row gap-3 items-center text-[13.5px]',
            toast.tone === 'success'
              ? 'bg-sage-wash text-sage border border-sage/30'
              : 'bg-s-ink text-white',
          )}
        >
          <span>{toast.message}</span>
          {toast.action && (
            <button
              onClick={() => {
                toast.action?.onClick();
                onDismiss(toast.id);
              }}
              className="font-bold underline underline-offset-2"
            >
              {toast.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
