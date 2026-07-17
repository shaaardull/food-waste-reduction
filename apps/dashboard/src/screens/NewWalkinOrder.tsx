import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  ChevronLeft,
  ChevronRight,
  Search,
  Mail,
  Minus,
  Plus,
  Users as UsersIcon,
  QrCode,
  MessageSquare,
  Trash2,
} from 'lucide-react';
import { clsx } from 'clsx';
import { api } from '../lib/api';
import { useAuthStore } from '../lib/auth';
import { useToasts } from '../lib/toasts';

/**
 * New walk-in order — 3-step flow (Table → Menu → Contact).
 *
 * Step 1 picks a table from a 4×N grid computed from the active
 * sessions list (occupied tables are disabled + labeled).
 * Step 2 is a category-tabbed menu picker with a sticky bottom bar.
 * Step 3 offers optional email/phone for a paperless bill.
 *
 * Submission chain:
 *   POST /sessions/walkin       — creates the session
 *   POST /sessions/:id/items    — adds the picked items in one call
 * Then navigates back to /orders and opens the drawer for the new
 * session so staff can immediately act on it (add more items, print,
 * mark paid). Drawer opening is handled by Orders.tsx via query
 * param `?drawer=<session_id>`.
 */

interface MenuItem {
  id: string;
  name: string;
  price_minor: number;
  category: string | null;
  description: string | null;
  is_active: boolean;
}

interface ActiveSession {
  id: string;
  status: string;
  table_code: string;
}

interface CartLine {
  quantity: number;
  notes: string;
}

type CartMap = Record<string, CartLine>;

const NOTE_MAX = 140;

// A pilot restaurant has ~12 tables. Generate T-01..T-12 client-side;
// the tables endpoint isn't a thing yet and the spec explicitly
// permits a static grid for v1 (occupied ones come from live sessions).
const DEFAULT_TABLES = Array.from({ length: 12 }, (_, i) => `T-${String(i + 1).padStart(2, '0')}`);

export function NewWalkinOrder() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { token, restaurantId } = useAuthStore();
  const qc = useQueryClient();
  const pushToast = useToasts((s) => s.push);

  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [tableCode, setTableCode] = useState<string | null>(null);
  const [cart, setCart] = useState<CartMap>({});
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) navigate('/login');
  }, [token, navigate]);

  // Which tables are already occupied (any active session). Used to
  // grey them out on Step 1 so a walk-in can't be entered against a
  // seated diner's table.
  const activeQuery = useQuery<ActiveSession[]>({
    queryKey: ['active-sessions-for-tables', restaurantId],
    queryFn: () =>
      api.get<ActiveSession[]>(
        `/restaurants/${restaurantId}/dashboard/sessions?status=open`,
        token,
      ),
    enabled: Boolean(restaurantId && token),
    staleTime: 5_000,
  });

  const occupiedTableCodes = useMemo(() => {
    const set = new Set<string>();
    for (const s of activeQuery.data ?? []) set.add(s.table_code);
    return set;
  }, [activeQuery.data]);

  const menuQuery = useQuery<MenuItem[]>({
    queryKey: ['walkin-menu', restaurantId],
    queryFn: () =>
      api.get<MenuItem[]>(
        `/restaurants/${restaurantId}/menu-items?include_inactive=false`,
        token,
      ),
    enabled: Boolean(restaurantId && token) && step >= 2,
  });

  const categories = useMemo(() => {
    const cats = new Set<string>();
    for (const m of menuQuery.data ?? []) {
      if (m.category) cats.add(m.category);
    }
    return Array.from(cats).sort();
  }, [menuQuery.data]);

  const totalMinor = useMemo(() => {
    let sum = 0;
    for (const m of menuQuery.data ?? []) {
      sum += (cart[m.id]?.quantity ?? 0) * m.price_minor;
    }
    return sum;
  }, [menuQuery.data, cart]);
  const itemCount = useMemo(
    () => Object.values(cart).reduce((a, b) => a + b.quantity, 0),
    [cart],
  );

  const submit = useMutation({
    mutationFn: async () => {
      const created = await api.post<{ id: string }>(
        `/sessions/walkin`,
        {
          restaurant_id: restaurantId,
          table_code: tableCode,
          customer_email: email.trim() || null,
          customer_phone: phone.trim() ? `+91${phone.trim()}` : null,
        },
        token,
      );
      const items = Object.entries(cart)
        .filter(([, line]) => line.quantity > 0)
        .map(([menu_item_id, line]) => {
          const note = line.notes.trim();
          return {
            menu_item_id,
            quantity: line.quantity,
            portion_size: 'regular',
            ...(note ? { notes: note } : {}),
          };
        });
      if (items.length) {
        await api.post(`/sessions/${created.id}/items`, { items }, token);
      }
      return created;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['live-orders', restaurantId] });
      pushToast({
        tone: 'sage',
        title: t('walkin.toast_created_title'),
        body: t('walkin.toast_created_body', { table: tableCode ?? '' }),
      });
      navigate('/orders');
    },
    onError: (err: Error) => setError(err.message),
  });

  return (
    <div className="fixed inset-0 z-30 bg-s-bg flex flex-col">
      <FlowHeader
        step={step}
        tableCode={tableCode}
        onBack={() =>
          step === 1 ? navigate('/orders') : setStep(((step as number) - 1) as 1 | 2 | 3)
        }
        onCancel={() => navigate('/orders')}
      />
      {step === 1 && (
        <Step1TablePick
          tables={DEFAULT_TABLES}
          occupied={occupiedTableCodes}
          activeSessions={activeQuery.data ?? []}
          selected={tableCode}
          onSelect={setTableCode}
          onNext={() => setStep(2)}
        />
      )}
      {step === 2 && (
        <Step2Menu
          items={menuQuery.data ?? []}
          categories={categories}
          isLoading={menuQuery.isLoading}
          cart={cart}
          setCart={setCart}
          count={itemCount}
          totalMinor={totalMinor}
          onNext={() => setStep(3)}
        />
      )}
      {step === 3 && (
        <Step3Contact
          tableCode={tableCode!}
          totalMinor={totalMinor}
          email={email}
          phone={phone}
          setEmail={setEmail}
          setPhone={setPhone}
          error={error}
          isSubmitting={submit.isPending}
          onSkip={() => {
            setEmail('');
            setPhone('');
            submit.mutate();
          }}
          onConfirm={() => submit.mutate()}
        />
      )}
    </div>
  );
}

/**
 * Header shared across all three steps. Back-chevron goes to previous
 * step (or /orders on step 1). Step indicator highlights the current.
 */
function FlowHeader({
  step,
  tableCode,
  onBack,
  onCancel,
}: {
  step: 1 | 2 | 3;
  tableCode: string | null;
  onBack: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const labels = [t('walkin.step_table'), t('walkin.step_menu'), t('walkin.step_contact')];
  return (
    <header className="flex items-center justify-between px-6 py-4 border-b border-s-line bg-s-paper shrink-0">
      <div className="flex items-center gap-3 min-w-0">
        <button
          type="button"
          onClick={onBack}
          aria-label={t('walkin.back')}
          className="w-9 h-9 rounded-lg hover:bg-s-bg flex items-center justify-center text-s-muted"
        >
          <ChevronLeft size={20} />
        </button>
        <div className="min-w-0">
          <div className="text-[11px] font-bold tracking-widest uppercase text-s-faint">
            {tableCode
              ? t('walkin.header_eyebrow_with_table', { table: tableCode })
              : t('walkin.header_eyebrow')}
          </div>
          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
            {labels.map((label, i) => {
              const num = i + 1;
              const isCurrent = num === step;
              const isDone = num < step;
              return (
                <span
                  key={label}
                  className={clsx(
                    'text-sm font-semibold',
                    isCurrent
                      ? 'text-brand'
                      : isDone
                        ? 'text-s-ink'
                        : 'text-s-faint',
                  )}
                >
                  {num}. {label}
                  {i < labels.length - 1 && <span className="ml-2 text-s-faint">—</span>}
                </span>
              );
            })}
          </div>
        </div>
      </div>
      <button
        type="button"
        onClick={onCancel}
        className="text-sm font-semibold text-s-faint hover:text-danger transition"
      >
        {t('walkin.cancel_order')}
      </button>
    </header>
  );
}

/* ===== STEP 1 — table pick ===== */

function Step1TablePick({
  tables,
  occupied,
  activeSessions,
  selected,
  onSelect,
  onNext,
}: {
  tables: string[];
  occupied: Set<string>;
  activeSessions: ActiveSession[];
  selected: string | null;
  onSelect: (t: string) => void;
  onNext: () => void;
}) {
  const { t } = useTranslation();
  // Session → channel map (we can't tell from the sessions endpoint
  // yet — treat all occupied as QR for the badge since walk-ins in
  // 'open' also appear here. The badge is informational only.)
  const badgeFor = (code: string) => {
    if (!occupied.has(code)) return null;
    // Best-effort: if any active session for this table has 'walkin'
    // in the table_code prefix we display WALK-IN; otherwise QR. The
    // real data would flow via a joined tables endpoint.
    return activeSessions.find((s) => s.table_code === code) ? 'occupied' : null;
  };

  return (
    <>
      <div className="flex-1 overflow-auto p-8 flex flex-col items-center">
        <div className="w-full max-w-3xl">
          <h2 className="text-xl font-bold text-s-ink mb-1">
            {t('walkin.step1_heading')}
          </h2>
          <p className="text-sm text-s-muted mb-6">
            {t('walkin.step1_blurb')}
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
            {tables.map((code) => {
              const disabled = occupied.has(code);
              const isSelected = selected === code;
              const badge = badgeFor(code);
              return (
                <button
                  key={code}
                  type="button"
                  disabled={disabled}
                  onClick={() => onSelect(code)}
                  className={clsx(
                    'relative rounded-xl border-2 flex flex-col items-center justify-center gap-2 aspect-square transition min-h-[200px]',
                    disabled
                      ? 'bg-s-bg border-s-line cursor-not-allowed opacity-70'
                      : isSelected
                        ? 'bg-brand-wash border-brand shadow-sm'
                        : 'bg-s-paper border-s-line hover:border-brand-line',
                  )}
                >
                  {badge && (
                    <span className="absolute top-2 right-2 inline-flex items-center h-5 px-2 rounded-full bg-s-line text-s-muted font-mono text-[10px] font-bold tracking-wider">
                      OCCUPIED
                    </span>
                  )}
                  <span
                    className={clsx(
                      'font-mono text-3xl font-bold',
                      disabled
                        ? 'text-s-faint'
                        : isSelected
                          ? 'text-brand'
                          : 'text-s-ink',
                    )}
                  >
                    {code.replace('T-', '')}
                  </span>
                  <span className="flex items-center gap-1 text-xs text-s-muted">
                    <UsersIcon size={12} />
                    {t('walkin.seats', { count: 4 })}
                  </span>
                  {disabled && (
                    <span className="text-[11px] font-semibold text-s-faint">
                      {t('walkin.occupied')}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </div>
      <footer className="border-t border-s-line bg-s-paper px-8 py-4 flex justify-end shrink-0">
        <button
          type="button"
          onClick={onNext}
          disabled={!selected}
          className={clsx(
            'h-12 px-7 rounded-lg font-semibold text-sm inline-flex items-center gap-2 transition',
            selected
              ? 'bg-brand text-white hover:bg-brand-press active:scale-[.98]'
              : 'bg-s-line text-s-faint cursor-not-allowed',
          )}
        >
          {t('walkin.continue_to_menu')}
          <ChevronRight size={18} />
        </button>
      </footer>
    </>
  );
}

/* ===== STEP 2 — menu ===== */

function Step2Menu({
  items,
  categories,
  isLoading,
  cart,
  setCart,
  count,
  totalMinor,
  onNext,
}: {
  items: MenuItem[];
  categories: string[];
  isLoading: boolean;
  cart: CartMap;
  setCart: (fn: (prev: CartMap) => CartMap) => void;
  count: number;
  totalMinor: number;
  onNext: () => void;
}) {
  const { t } = useTranslation();
  const [activeCategory, setActiveCategory] = useState<string | null>(
    categories[0] ?? null,
  );
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (!activeCategory && categories.length > 0) {
      const first = categories[0];
      if (first) setActiveCategory(first);
    }
  }, [categories, activeCategory]);

  const filtered = useMemo(() => {
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      return items.filter((m) => m.name.toLowerCase().includes(q));
    }
    if (!activeCategory) return items;
    return items.filter((m) => m.category === activeCategory);
  }, [items, activeCategory, query]);

  const setQty = (id: string, qty: number) => {
    setCart((prev) => {
      const next = { ...prev };
      if (qty <= 0) delete next[id];
      else next[id] = { quantity: qty, notes: prev[id]?.notes ?? '' };
      return next;
    });
  };

  const setNote = (id: string, notes: string) => {
    setCart((prev) => {
      const line = prev[id];
      if (!line) return prev;
      return { ...prev, [id]: { ...line, notes } };
    });
  };

  return (
    <>
      <div className="px-6 pt-4 bg-s-paper border-b border-s-line shrink-0">
        <div className="relative mb-3">
          <Search
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-s-faint pointer-events-none"
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('walkin.search_menu_placeholder')}
            aria-label={t('walkin.search_menu_placeholder')}
            className="w-full h-10 pl-9 pr-3 rounded-lg border border-s-line text-sm focus:outline-none focus:border-brand-line focus:ring-2 focus:ring-brand-wash bg-s-paper"
          />
        </div>
        {!query && categories.length > 0 && (
          <div className="flex gap-1 overflow-x-auto pb-3">
            {categories.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setActiveCategory(c)}
                className={clsx(
                  'h-9 px-4 rounded-lg text-sm font-semibold whitespace-nowrap',
                  activeCategory === c
                    ? 'bg-brand text-white'
                    : 'bg-s-bg text-s-muted hover:text-s-ink',
                )}
              >
                {c}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-auto px-6 py-4">
        {isLoading ? (
          <p className="text-sm text-s-muted">{t('walkin.menu_loading')}</p>
        ) : filtered.length === 0 ? (
          <p className="text-sm text-s-muted">{t('walkin.menu_empty')}</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {filtered.map((m) => {
              const line = cart[m.id];
              const qty = line?.quantity ?? 0;
              const notes = line?.notes ?? '';
              const isInCart = qty > 0;
              return (
                <div
                  key={m.id}
                  className={clsx(
                    'flex flex-col gap-2 p-3 rounded-lg border',
                    isInCart
                      ? 'border-brand-line bg-brand-wash/40'
                      : 'border-s-line bg-s-paper',
                  )}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-semibold text-sm text-s-ink truncate">
                        {m.name}
                      </div>
                      {m.description && (
                        <div className="text-xs text-s-muted italic mt-0.5 line-clamp-2">
                          {m.description}
                        </div>
                      )}
                      <div className="text-xs text-s-muted">
                        ₹{(m.price_minor / 100).toFixed(2)}
                      </div>
                    </div>
                    <QtyStepper qty={qty} onChange={(v) => setQty(m.id, v)} />
                  </div>
                  {isInCart && (
                    <NoteField
                      value={notes}
                      onChange={(v) => setNote(m.id, v)}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <footer className="border-t border-s-line bg-s-paper px-6 py-4 flex items-center justify-between gap-4 shrink-0">
        {/* min-w + flex-shrink-0 + whitespace-nowrap — the QA note in the
            spec called this out; without it the price line collides with
            the button on narrow layouts. */}
        <div className="min-w-[140px] flex-shrink-0">
          <div className="text-sm text-s-muted whitespace-nowrap">
            {t('walkin.items_selected', { count })}
          </div>
          <div className="font-mono text-xl font-bold text-s-ink whitespace-nowrap">
            ₹{(totalMinor / 100).toFixed(2)}
          </div>
        </div>
        <button
          type="button"
          onClick={onNext}
          disabled={count === 0}
          className={clsx(
            'h-12 px-7 rounded-lg font-semibold text-sm inline-flex items-center gap-2 transition',
            count > 0
              ? 'bg-brand text-white hover:bg-brand-press active:scale-[.98]'
              : 'bg-s-line text-s-faint cursor-not-allowed',
          )}
        >
          {t('walkin.review_order')}
          <ChevronRight size={18} />
        </button>
      </footer>
    </>
  );
}

function QtyStepper({
  qty,
  onChange,
}: {
  qty: number;
  onChange: (v: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center border border-s-line rounded-lg overflow-hidden shrink-0">
      <button
        type="button"
        onClick={() => onChange(Math.max(0, qty - 1))}
        aria-label={t('walkin.qty_decrease')}
        className="w-9 h-9 flex items-center justify-center text-s-muted hover:bg-s-bg"
      >
        <Minus size={15} />
      </button>
      <span className="w-8 text-center font-mono font-bold text-s-ink">{qty}</span>
      <button
        type="button"
        onClick={() => onChange(qty + 1)}
        aria-label={t('walkin.qty_increase')}
        className="w-9 h-9 flex items-center justify-center bg-brand text-white hover:bg-brand-press"
      >
        <Plus size={15} />
      </button>
    </div>
  );
}

/**
 * Optional per-item note affordance. Same collapsed/expanded pattern
 * as the diner PWA — an inline text input so the staff never leaves
 * the menu picker context to jot down "half boiled" or "no onions".
 */
function NoteField({
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
        className="row gap-1.5 items-center text-xs font-semibold text-s-muted hover:text-brand transition self-start"
      >
        <MessageSquare size={12} />
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
        className="flex-1 h-9 px-3 rounded-md border border-s-line bg-s-paper text-[13px] focus:outline-none focus:border-brand-line focus:ring-2 focus:ring-brand-wash transition"
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

/* ===== STEP 3 — optional contact ===== */

function Step3Contact({
  tableCode,
  totalMinor,
  email,
  phone,
  setEmail,
  setPhone,
  error,
  isSubmitting,
  onSkip,
  onConfirm,
}: {
  tableCode: string;
  totalMinor: number;
  email: string;
  phone: string;
  setEmail: (v: string) => void;
  setPhone: (v: string) => void;
  error: string | null;
  isSubmitting: boolean;
  onSkip: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex-1 flex items-center justify-center p-8 overflow-auto">
      <div className="w-full max-w-md bg-s-paper border border-s-line rounded-xl p-7">
        <h2 className="text-xl font-bold text-s-ink mb-1">
          {t('walkin.step3_heading')}
        </h2>
        <p className="text-sm text-s-muted mb-6">{t('walkin.step3_blurb')}</p>

        <label
          htmlFor="walkin-email"
          className="block text-xs font-semibold text-s-muted mb-1.5"
        >
          {t('walkin.field_email')}
        </label>
        <div className="relative mb-4">
          <Mail
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-s-faint pointer-events-none"
          />
          <input
            id="walkin-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="guest@example.com"
            className="w-full h-11 pl-9 pr-3 rounded-lg border border-s-line text-sm focus:outline-none focus:border-brand-line focus:ring-2 focus:ring-brand-wash bg-s-paper"
          />
        </div>

        <label
          htmlFor="walkin-phone"
          className="block text-xs font-semibold text-s-muted mb-1.5"
        >
          {t('walkin.field_phone')}
        </label>
        <div className="relative mb-6">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-s-faint text-sm pointer-events-none">
            +91
          </span>
          <input
            id="walkin-phone"
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 10))}
            placeholder="98765 43210"
            inputMode="numeric"
            className="w-full h-11 pl-12 pr-3 rounded-lg border border-s-line text-sm focus:outline-none focus:border-brand-line focus:ring-2 focus:ring-brand-wash bg-s-paper"
          />
        </div>

        <div className="flex items-center justify-between bg-s-bg rounded-lg px-4 py-3 mb-6">
          <span className="text-sm text-s-muted">
            {t('walkin.order_total_for_table', { table: tableCode })}
          </span>
          <span className="font-mono text-lg font-bold text-s-ink">
            ₹{(totalMinor / 100).toFixed(2)}
          </span>
        </div>

        {error && (
          <p className="text-sm text-danger bg-danger-wash border border-danger/20 rounded-md px-3 py-2 mb-4">
            {error}
          </p>
        )}

        {/* Skip and Confirm are the same size / same row / 50-50. Skip
            is a secondary outlined button so the paperless-decline
            path isn't visually buried. */}
        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={onSkip}
            disabled={isSubmitting}
            className="h-12 rounded-lg font-semibold text-sm border-2 border-s-line text-s-ink hover:bg-s-bg active:scale-[.98] transition disabled:opacity-60"
          >
            {t('walkin.skip')}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isSubmitting}
            className="h-12 rounded-lg font-semibold text-sm bg-brand text-white hover:bg-brand-press active:scale-[.98] transition disabled:opacity-60"
          >
            {isSubmitting ? t('walkin.working') : t('walkin.confirm_order')}
          </button>
        </div>
      </div>
    </div>
  );
}
