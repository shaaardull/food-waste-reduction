import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Leaf,
  Plus,
  Minus,
  Utensils,
  QrCode,
  ChevronDown,
  MessageSquare,
  Trash2,
} from 'lucide-react';
import { clsx } from 'clsx';
import type { MenuItem, PortionSize } from '@plate-clean/shared-types';
import { api, ApiException } from '../lib/api';
import { useAuthStore } from '../lib/auth';
import { LangToggle } from '../components/LangToggle';

interface SessionDetail {
  session: {
    id: string;
    restaurant_id: string;
    status: string;
    table_code: string;
  };
}

interface Line {
  menu_item_id: string;
  quantity: number;
  portion_size: PortionSize;
  notes?: string;
}

const NOTE_MAX = 140;

/**
 * Order screen — picks dishes + portion sizes for the meal session.
 *
 * Ethics rule 2 (CLAUDE.md §8 — "portion-size declaration"): "small" is
 * the default for every item *and* is the visually lightest segment in
 * the segmented control. Above the menu, a sage banner says it out
 * loud — making the nudge transparent rather than hidden.
 */
const PORTIONS: Array<{ value: PortionSize; key: string }> = [
  { value: 'small', key: 'order.portion.small' },
  { value: 'regular', key: 'order.portion.regular' },
  { value: 'large', key: 'order.portion.large' },
];

const PORTION_DOT_SIZE: Record<PortionSize, number> = {
  small: 7,
  regular: 11,
  large: 14,
};

// Seed categories in the canonical order the staff-side editor uses.
// Anything the restaurant added as a custom category (e.g. "Tandoor")
// is appended after these, alphabetically. Uncategorised (null) always
// goes last.
const SEED_ORDER = ['starter', 'main', 'side', 'bread', 'drink', 'dessert'];

const UNCAT_KEY = '__uncat__';

export function Order() {
  const { t } = useTranslation();
  const { id: sessionId = '' } = useParams();
  const navigate = useNavigate();
  const token = useAuthStore((s) => s.token);
  const activeRestaurant = useAuthStore((s) => s.activeRestaurant);
  const [menu, setMenu] = useState<MenuItem[]>([]);
  const [tableCode, setTableCode] = useState<string>('');
  const [lines, setLines] = useState<Record<string, Line>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const detail = await api.get<SessionDetail>(`/sessions/${sessionId}`, token);
        setTableCode(detail.session.table_code);
        const m = await api.get<MenuItem[]>(
          `/restaurants/${detail.session.restaurant_id}/menu`,
          token,
        );
        setMenu(m);
      } catch (err) {
        if (err instanceof ApiException) setError(err.message);
      }
    })();
  }, [sessionId, token]);

  const total = useMemo(
    () =>
      Object.values(lines).reduce((sum, line) => {
        const item = menu.find((m) => m.id === line.menu_item_id);
        return sum + (item ? (item.price_minor * line.quantity) / 100 : 0);
      }, 0),
    [lines, menu],
  );

  const itemCount = useMemo(
    () => Object.values(lines).reduce((n, l) => n + l.quantity, 0),
    [lines],
  );

  // Group the menu by category, respecting the same ordering the
  // staff editor uses: seed categories first (canonical order),
  // then custom categories alphabetically, uncategorised last.
  const grouped = useMemo(() => {
    const map = new Map<string, MenuItem[]>();
    for (const m of menu) {
      const key = m.category?.trim() || UNCAT_KEY;
      const arr = map.get(key) ?? [];
      arr.push(m);
      map.set(key, arr);
    }
    const seed = SEED_ORDER.filter((k) => map.has(k));
    const custom = [...map.keys()]
      .filter(
        (k) => k !== UNCAT_KEY && !SEED_ORDER.includes(k),
      )
      .sort((a, b) => a.localeCompare(b));
    const keys = [
      ...seed,
      ...custom,
      ...(map.has(UNCAT_KEY) ? [UNCAT_KEY] : []),
    ];
    return keys.map((k) => ({ key: k, items: map.get(k) ?? [] }));
  }, [menu]);

  // Collapse state per section — everything open by default so a
  // diner scrolling the menu doesn't have to tap five times before
  // they can see any dishes. Tap a header to collapse a section.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  function toggleSection(key: string) {
    setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));
  }
  // Count how many items in each section the diner has already added,
  // so the header can show a small "(2 added)" hint — useful once a
  // section is collapsed.
  const addedPerSection = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const g of grouped) {
      let n = 0;
      for (const it of g.items) {
        n += lines[it.id]?.quantity ?? 0;
      }
      counts[g.key] = n;
    }
    return counts;
  }, [grouped, lines]);

  function setQty(item: MenuItem, qty: number) {
    setLines((prev) => {
      if (qty <= 0) {
        const next = { ...prev };
        delete next[item.id];
        return next;
      }
      const existing = prev[item.id];
      return {
        ...prev,
        [item.id]: {
          menu_item_id: item.id,
          quantity: qty,
          // Ethics rule 2: default portion is "small".
          portion_size: existing?.portion_size ?? 'small',
        },
      };
    });
  }

  function setPortion(itemId: string, size: PortionSize) {
    setLines((prev) =>
      prev[itemId]
        ? { ...prev, [itemId]: { ...prev[itemId], portion_size: size } }
        : prev,
    );
  }

  function setNote(itemId: string, note: string) {
    setLines((prev) =>
      prev[itemId]
        ? { ...prev, [itemId]: { ...prev[itemId], notes: note } }
        : prev,
    );
  }

  async function submit() {
    setError(null);
    setBusy(true);
    try {
      // Trim whitespace + omit empty notes so the server sees a real
      // string or null. The schema allows null/omitted.
      const payloadItems = Object.values(lines).map((line) => {
        const note = line.notes?.trim();
        return {
          menu_item_id: line.menu_item_id,
          quantity: line.quantity,
          portion_size: line.portion_size,
          ...(note ? { notes: note } : {}),
        };
      });
      await api.post(
        `/sessions/${sessionId}/items`,
        { items: payloadItems },
        token,
      );
      // Don't force the camera open — the diner hasn't eaten yet.
      // Land on the session-status page which shows a "food is on
      // the way" state with a voluntary "Take before photo" CTA they
      // tap when the plates arrive.
      navigate(`/sessions/${sessionId}`);
    } catch (err) {
      if (err instanceof ApiException) setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="d-screen flex flex-col min-h-full">
      {/* header — table chip + lang toggle */}
      <div className="px-5 pt-4 pb-1.5">
        <div className="spread">
          <span className="chip chip-brand">
            <QrCode size={14} />
            {tableCode
              ? t('order.table', {
                  code: tableCode,
                  name: activeRestaurant?.name ?? '',
                })
              : t('order.table_fallback')}
          </span>
          <LangToggle />
        </div>
        <h1 className="display text-[26px] mt-3.5">{t('order.title')}</h1>
      </div>

      {/* sage default-portion nudge (ethics rule 2) */}
      <div className="row gap-2.5 mx-5 my-2.5 py-2.5 px-3.5 rounded-md bg-sage-wash text-sage">
        <Leaf size={18} className="flex-shrink-0" />
        <span className="font-semibold text-[13px] leading-snug">
          {t('order.banner_default')}
        </span>
      </div>

      {/* menu list, grouped by category with collapsible sections */}
      <div className="px-4 pb-4 flex flex-col gap-4">
        {grouped.map((section) => {
          const isCollapsed = Boolean(collapsed[section.key]);
          const added = addedPerSection[section.key] ?? 0;
          const isSeed = SEED_ORDER.includes(section.key);
          const isUncat = section.key === UNCAT_KEY;
          const label = isUncat
            ? t('order.category_uncategorised', { defaultValue: 'Other' })
            : isSeed
              ? t(`order.category.${section.key}`, {
                  defaultValue: section.key,
                })
              : section.key;
          return (
            <section key={section.key} className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() => toggleSection(section.key)}
                className="row spread items-center px-2 py-1.5 rounded-md hover:bg-cream transition text-left"
                aria-expanded={!isCollapsed}
              >
                <div className="row gap-2 items-baseline">
                  <span className="dev uppercase tracking-wide text-[12px] font-bold text-brand">
                    {label}
                  </span>
                  <span className="text-[11.5px] text-muted">
                    · {section.items.length}
                    {added > 0 && (
                      <>
                        {' '}
                        ·{' '}
                        {t('order.added_count', {
                          count: added,
                          defaultValue: '{{count}} added',
                        })}
                      </>
                    )}
                  </span>
                </div>
                <ChevronDown
                  size={16}
                  className={clsx(
                    'transition-transform text-muted',
                    isCollapsed && '-rotate-90',
                  )}
                />
              </button>
              {!isCollapsed && (
                <div className="flex flex-col gap-3">
                  {section.items.map((item) => {
                    const line = lines[item.id];
                    const qty = line?.quantity ?? 0;
                    return (
                      <div key={item.id} className="card p-3">
                        <div className="row gap-3 items-start">
                          <div
                            className="dish dish-plate w-[74px] h-[74px] flex-shrink-0"
                            data-label=""
                          />
                          <div className="flex-1 min-w-0">
                            <div className="font-semibold text-base">
                              {item.name}
                            </div>
                            {item.description && (
                              <div className="dev text-sm text-muted line-clamp-2">
                                {item.description}
                              </div>
                            )}
                          </div>
                          <div className="text-right">
                            <div className="price">
                              ₹{(item.price_minor / 100).toFixed(0)}
                            </div>
                            <div className="mt-2">
                              <Stepper
                                qty={qty}
                                onChange={(n) => setQty(item, n)}
                              />
                            </div>
                          </div>
                        </div>
                        {qty > 0 && (
                          <div className="seg mt-3">
                            {PORTIONS.map(({ value, key }) => {
                              const active =
                                (line?.portion_size ?? 'small') === value;
                              return (
                                <button
                                  key={value}
                                  onClick={() => setPortion(item.id, value)}
                                  className={`seg-item ${value === 'small' ? 'small' : ''} ${
                                    active ? 'active' : ''
                                  }`}
                                  aria-pressed={active}
                                >
                                  <span
                                    className="dot"
                                    style={{
                                      width: PORTION_DOT_SIZE[value],
                                      height: PORTION_DOT_SIZE[value],
                                    }}
                                  />
                                  {t(key)}
                                </button>
                              );
                            })}
                          </div>
                        )}
                        {qty > 0 && (
                          <NoteField
                            value={line?.notes ?? ''}
                            onChange={(v) => setNote(item.id, v)}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          );
        })}

        {menu.length === 0 && !error && (
          <p className="text-muted text-sm text-center py-8">
            {t('order.loading')}
          </p>
        )}

        {error && (
          <p className="text-sm text-danger bg-danger-wash border border-danger/20 rounded-md px-3 py-2">
            {error}
          </p>
        )}
      </div>

      {/* sticky total bar */}
      <div className="sticky-bar mt-auto">
        <div className="spread mb-2.5 px-0.5">
          <span className="text-muted text-sm">
            {t('order.total_items', { count: itemCount })}
          </span>
          <span className="tnum font-bold text-[22px]">
            ₹{total.toFixed(0)}
          </span>
        </div>
        <button
          onClick={submit}
          disabled={busy || itemCount === 0}
          className="btn btn-primary btn-lg btn-block disabled:opacity-50"
        >
          <Utensils size={18} />
          {busy ? t('order.saving') : t('order.send_to_kitchen')}
        </button>
      </div>
    </div>
  );
}

interface StepperProps {
  qty: number;
  onChange: (n: number) => void;
}

/**
 * Two-state stepper: when qty=0, shows a single "+" button to add the
 * first item; when qty>0, shows -/n/+ controls. Matches the design's
 * compact one-handed feel.
 */
function Stepper({ qty, onChange }: StepperProps) {
  if (qty === 0) {
    return (
      <button
        onClick={() => onChange(1)}
        className="w-10 h-10 rounded-md bg-brand text-white flex items-center justify-center hover:bg-brand-press transition"
        aria-label="Add"
      >
        <Plus size={18} />
      </button>
    );
  }
  return (
    <div className="row gap-0 border-2 border-line rounded-md overflow-hidden">
      <button
        onClick={() => onChange(qty - 1)}
        className="w-10 h-10 flex items-center justify-center bg-paper text-brand hover:bg-brand-wash transition"
        aria-label="Remove"
      >
        <Minus size={16} />
      </button>
      <span className="tnum w-[34px] text-center font-bold text-base leading-[40px]">
        {qty}
      </span>
      <button
        onClick={() => onChange(qty + 1)}
        className="w-10 h-10 flex items-center justify-center bg-brand text-white hover:bg-brand-press transition"
        aria-label="Add"
      >
        <Plus size={16} />
      </button>
    </div>
  );
}

interface NoteFieldProps {
  value: string;
  onChange: (v: string) => void;
}

/**
 * Optional per-item note. Collapsed to a chip-style "Add a note" link
 * until tapped; expands inline into a text input so the diner never
 * leaves the menu context. Ethics-neutral copy (no "special
 * instructions" ambiguity that could nudge upsells).
 */
function NoteField({ value, onChange }: NoteFieldProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(Boolean(value));
  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="mt-2.5 row gap-1.5 items-center text-[12.5px] font-semibold text-muted hover:text-brand transition self-start"
      >
        <MessageSquare size={12} />
        {t('notes.add_cta')}
      </button>
    );
  }
  return (
    <div className="mt-2.5 flex flex-col gap-1">
      <div className="row gap-2 items-start">
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          maxLength={NOTE_MAX}
          placeholder={t('notes.placeholder')}
          aria-label={t('notes.label')}
          className="flex-1 h-10 px-3 rounded-md border-2 border-line bg-paper text-[13.5px] focus:outline-none focus:border-brand transition"
        />
        <button
          type="button"
          onClick={() => {
            onChange('');
            setExpanded(false);
          }}
          className="w-10 h-10 rounded-md border-2 border-line text-muted hover:text-danger hover:border-danger transition flex items-center justify-center flex-shrink-0"
          aria-label={t('notes.clear')}
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
}
