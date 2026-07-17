import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { X, Plus, Trash2, Pencil, AlertTriangle, MessageSquare } from 'lucide-react';
import { api } from '../lib/api';
import type { ApiException } from '../lib/api';
import { useAuthStore } from '../lib/auth';

/**
 * EditItemsModal — staff-side item editor for a pre-bill session.
 *
 * The API is full-replace: PATCH /sessions/:id/items with the new list.
 * We start the local edit state from whatever the session currently
 * has, let the staff add / remove / re-quantify, then send the full
 * list back.
 *
 * Server refuses if a bill is already issued (409 BILL_ALREADY_ISSUED)
 * or the session is terminal (cancelled / rewarded / expired). Both
 * surface as friendly errors.
 *
 * Warning banner up top: "kitchen may already be cooking" — the
 * staff should confirm with the kitchen before firing this off.
 */

interface MenuItem {
  id: string;
  name: string;
  price_minor: number;
  category: string | null;
  description: string | null;
  is_active: boolean;
}

interface EditRow {
  menu_item_id: string;
  name: string;
  quantity: number;
  portion_size: 'small' | 'regular' | 'large' | null;
  notes: string;
}

interface OrderItemFromApi {
  menu_item_id: string;
  name: string;
  quantity: number;
  portion_size: string | null;
  notes?: string | null;
}

const NOTE_MAX = 140;

interface Props {
  sessionId: string;
  tableCode: string;
  restaurantId: string;
  currentItems: OrderItemFromApi[];
  onClose: () => void;
  onSaved?: () => void;
}

export function EditItemsModal({
  sessionId,
  tableCode,
  restaurantId,
  currentItems,
  onClose,
  onSaved,
}: Props) {
  const { t } = useTranslation();
  const { token } = useAuthStore();
  const qc = useQueryClient();

  const [rows, setRows] = useState<EditRow[]>(
    currentItems.map((it) => ({
      menu_item_id: it.menu_item_id,
      name: it.name,
      quantity: it.quantity,
      portion_size:
        it.portion_size === 'small' ||
        it.portion_size === 'regular' ||
        it.portion_size === 'large'
          ? it.portion_size
          : null,
      notes: it.notes ?? '',
    })),
  );
  const [addingOpen, setAddingOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: menu } = useQuery<MenuItem[]>({
    queryKey: ['staff-menu', restaurantId],
    queryFn: () =>
      api.get<MenuItem[]>(
        `/restaurants/${restaurantId}/menu-items`,
        token,
      ),
    enabled: Boolean(restaurantId && token && addingOpen),
  });

  useEffect(() => {
    if (!addingOpen) return;
    // Auto-close the picker when it becomes empty (all items already
    // added and no more to pick from) — nothing to browse.
  }, [addingOpen]);

  const save = useMutation({
    mutationFn: () =>
      api.patch(
        `/sessions/${sessionId}/items`,
        {
          items: rows.map((r) => {
            const note = r.notes.trim();
            return {
              menu_item_id: r.menu_item_id,
              quantity: r.quantity,
              portion_size: r.portion_size,
              ...(note ? { notes: note } : {}),
            };
          }),
        },
        token,
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['live-orders', restaurantId] });
      onSaved?.();
      onClose();
    },
    onError: (err: ApiException) => {
      const msg =
        (err.details as { message?: string } | undefined)?.message ??
        err.message ??
        t('edit_items.err_generic');
      setError(msg);
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (rows.length === 0) {
      setError(t('edit_items.err_empty'));
      return;
    }
    save.mutate();
  }

  function updateQty(i: number, delta: number) {
    setRows((prev) =>
      prev.map((r, idx) =>
        idx === i
          ? { ...r, quantity: Math.max(1, Math.min(20, r.quantity + delta)) }
          : r,
      ),
    );
  }

  function removeRow(i: number) {
    setRows((prev) => prev.filter((_, idx) => idx !== i));
  }

  function addFromMenu(m: MenuItem) {
    // If already in the list, bump the quantity; otherwise append.
    setRows((prev) => {
      const existing = prev.findIndex((r) => r.menu_item_id === m.id);
      if (existing >= 0) {
        return prev.map((r, idx) =>
          idx === existing
            ? { ...r, quantity: Math.min(20, r.quantity + 1) }
            : r,
        );
      }
      return [
        ...prev,
        {
          menu_item_id: m.id,
          name: m.name,
          quantity: 1,
          portion_size: 'regular' as const,
          notes: '',
        },
      ];
    });
    setAddingOpen(false);
  }

  function setNote(i: number, notes: string) {
    setRows((prev) =>
      prev.map((r, idx) => (idx === i ? { ...r, notes } : r)),
    );
  }

  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-center justify-center p-4">
      <div className="w-full max-w-[560px] max-h-[92vh] bg-s-paper border border-s-line rounded-lg shadow-pop flex flex-col overflow-hidden">
        <div className="px-5 py-4 border-b border-s-line row spread items-start">
          <div>
            <div className="text-[12px] font-semibold text-s-muted dev uppercase tracking-wide row gap-1.5 items-center">
              <Pencil size={12} />
              {t('edit_items.eyebrow')} · {tableCode}
            </div>
            <h2 className="display text-[22px] text-s-ink leading-tight">
              {t('edit_items.title')}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-md hover:bg-s-bg flex items-center justify-center text-s-muted"
          >
            <X size={16} />
          </button>
        </div>

        <form onSubmit={submit} className="flex-1 flex flex-col overflow-hidden">
          <div className="px-5 py-4 flex-1 overflow-auto flex flex-col gap-4">
            <div className="row gap-3 items-start bg-saffron-wash/60 border border-saffron-deep/20 rounded-md p-3">
              <AlertTriangle
                size={18}
                className="text-saffron-deep mt-0.5 flex-shrink-0"
              />
              <div className="text-[12.5px] text-s-ink leading-snug">
                {t('edit_items.warn_kitchen')}
              </div>
            </div>

            <div className="flex flex-col gap-2">
              {rows.length === 0 && (
                <p className="text-[13px] text-s-muted text-center py-4">
                  {t('edit_items.empty')}
                </p>
              )}
              {rows.map((r, i) => (
                <div
                  key={`${r.menu_item_id}-${i}`}
                  className="flex flex-col gap-2 rounded-md border border-s-line bg-s-paper px-3 py-2"
                >
                  <div className="row gap-3 items-center">
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold text-[13.5px] text-s-ink truncate">
                        {r.name}
                      </div>
                      {r.portion_size && r.portion_size !== 'regular' && (
                        <div className="text-[11px] text-s-muted capitalize">
                          {r.portion_size}
                        </div>
                      )}
                    </div>
                    <div className="row gap-0 items-center border border-s-line rounded-md overflow-hidden">
                      <button
                        type="button"
                        onClick={() => updateQty(i, -1)}
                        className="px-2 py-1 text-s-muted hover:bg-s-bg font-bold"
                        aria-label="−"
                      >
                        −
                      </button>
                      <span className="tnum w-8 text-center font-semibold text-[13px]">
                        {r.quantity}
                      </span>
                      <button
                        type="button"
                        onClick={() => updateQty(i, 1)}
                        className="px-2 py-1 text-s-muted hover:bg-s-bg font-bold"
                        aria-label="+"
                      >
                        +
                      </button>
                    </div>
                    <button
                      type="button"
                      onClick={() => removeRow(i)}
                      className="w-8 h-8 rounded-md hover:bg-danger-wash text-s-muted hover:text-danger flex items-center justify-center transition"
                      aria-label={t('edit_items.remove')}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                  <EditNoteField
                    value={r.notes}
                    onChange={(v) => setNote(i, v)}
                  />
                </div>
              ))}
            </div>

            {addingOpen ? (
              <div className="rounded-md border border-s-line bg-s-bg p-3 flex flex-col gap-2">
                <div className="row spread items-center">
                  <span className="text-[12.5px] font-semibold text-s-ink">
                    {t('edit_items.pick_dish')}
                  </span>
                  <button
                    type="button"
                    onClick={() => setAddingOpen(false)}
                    className="text-[12px] text-s-muted hover:text-s-ink"
                  >
                    {t('edit_items.cancel_pick')}
                  </button>
                </div>
                <div className="max-h-[220px] overflow-auto flex flex-col gap-1">
                  {(menu ?? [])
                    .filter((m) => m.is_active)
                    .map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => addFromMenu(m)}
                        className="row spread items-start px-2 py-1.5 rounded-md hover:bg-s-paper text-left gap-2"
                      >
                        <span className="flex-1 min-w-0">
                          <span className="block text-[13px] text-s-ink truncate">
                            {m.name}
                          </span>
                          {m.description && (
                            <span className="block text-[11px] text-s-muted italic mt-0.5 line-clamp-2">
                              {m.description}
                            </span>
                          )}
                        </span>
                        <span className="tnum text-[12px] text-s-muted shrink-0 mt-0.5">
                          ₹{(m.price_minor / 100).toFixed(0)}
                        </span>
                      </button>
                    ))}
                  {menu && menu.length === 0 && (
                    <p className="text-[12px] text-s-muted text-center py-2">
                      {t('edit_items.no_menu')}
                    </p>
                  )}
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setAddingOpen(true)}
                className="btn btn-outline min-h-[40px] text-[13px] self-start"
              >
                <Plus size={14} />
                {t('edit_items.add_dish')}
              </button>
            )}

            {error && (
              <p className="text-sm text-danger bg-danger-wash border border-danger/20 rounded-md px-3 py-2">
                {error}
              </p>
            )}
          </div>

          <div className="row gap-2 px-5 py-3 border-t border-s-line">
            <button
              type="button"
              onClick={onClose}
              className="btn btn-outline flex-1 min-h-[44px] text-[14px]"
            >
              {t('edit_items.discard')}
            </button>
            <button
              type="submit"
              disabled={save.isPending}
              className="btn btn-primary flex-1 min-h-[44px] text-[14px] disabled:opacity-55"
            >
              {save.isPending ? t('edit_items.saving') : t('edit_items.save')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/**
 * Optional per-item note. Collapsed by default until staff taps
 * "Add note"; expands to an inline input (140 char cap).
 */
function EditNoteField({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(Boolean(value));
  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="row gap-1.5 items-center text-[11.5px] font-semibold text-s-muted hover:text-brand transition self-start"
      >
        <MessageSquare size={11} />
        {t('notes.add_cta')}
      </button>
    );
  }
  return (
    <div className="row gap-2 items-start">
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        maxLength={NOTE_MAX}
        placeholder={t('notes.placeholder')}
        aria-label={t('notes.label')}
        className="flex-1 h-9 px-3 rounded-md border border-s-line bg-s-paper text-[12.5px] focus:outline-none focus:border-brand-line focus:ring-2 focus:ring-brand-wash transition"
      />
      <button
        type="button"
        onClick={() => {
          onChange('');
          setExpanded(false);
        }}
        className="w-9 h-9 rounded-md border border-s-line text-s-muted hover:text-danger hover:border-danger transition flex items-center justify-center flex-shrink-0"
        aria-label={t('notes.clear')}
      >
        <Trash2 size={13} />
      </button>
    </div>
  );
}
