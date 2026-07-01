import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Leaf, Plus, Minus, Utensils, QrCode } from 'lucide-react';
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
}

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

  async function submit() {
    setError(null);
    setBusy(true);
    try {
      await api.post(
        `/sessions/${sessionId}/items`,
        { items: Object.values(lines) },
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

      {/* menu list */}
      <div className="px-4 pb-4 flex flex-col gap-3">
        {menu.map((item) => {
          const line = lines[item.id];
          const qty = line?.quantity ?? 0;
          const category = item.category as keyof Record<string, string> | null;
          return (
            <div key={item.id} className="card p-3">
              <div className="row gap-3 items-start">
                <div
                  className="dish dish-plate w-[74px] h-[74px] flex-shrink-0"
                  data-label=""
                />
                <div className="flex-1 min-w-0">
                  {category && (
                    <div className="chip chip-muted h-[22px] mb-1.5">
                      {t(`order.category.${category}`, {
                        defaultValue: category,
                      })}
                    </div>
                  )}
                  <div className="font-semibold text-base">{item.name}</div>
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
                    <Stepper qty={qty} onChange={(n) => setQty(item, n)} />
                  </div>
                </div>
              </div>
              {qty > 0 && (
                <div className="seg mt-3">
                  {PORTIONS.map(({ value, key }) => {
                    const active = (line?.portion_size ?? 'small') === value;
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
            </div>
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
