import { useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  ClipboardList,
  ChefHat,
  Utensils,
  Timer,
  Check,
  ArrowRight,
  Receipt,
  Pencil,
  XCircle,
  Eye,
  Plus,
  QrCode,
  Users as UsersIcon,
  MessageSquare,
} from 'lucide-react';
import { clsx } from 'clsx';
import { useState } from 'react';
import { api } from '../lib/api';
import { useAuthStore } from '../lib/auth';
import { BillSendModal } from '../components/BillSendModal';
import { BillViewModal } from '../components/BillViewModal';
import { CancelOrderModal } from '../components/CancelOrderModal';
import { EditItemsModal } from '../components/EditItemsModal';
import { ChannelStrip } from '../components/ChannelStrip';
import { OrderDetailDrawer } from '../components/OrderDetailDrawer';
import { TakeawayPill } from '../components/TakeawayPill';

/**
 * Live orders — the kitchen visibility surface. Sits above Validation
 * queue in the left rail so servers hit it first when a diner sits
 * down and orders through the PWA.
 *
 * The board is a 4-column kanban derived client-side from the raw
 * session list the API returns. Kitchen ack is cosmetic (per sprint
 * kickoff): tapping "Mark sent" just moves a card from column 1 to
 * column 2. The diner flow never blocks on it.
 *
 * Poll interval: 3 s. TanStack Query handles the interval; no
 * SSE/WebSocket at pilot scale.
 */

type OrderStatus =
  | 'open'
  | 'before_captured'
  | 'eating'
  | 'after_submitted'
  | 'pending_staff_validation'
  | 'serving'
  | 'served'
  | 'billed';

export type EntryChannel = 'qr' | 'walkin';

interface OrderItem {
  menu_item_id: string;
  name: string;
  quantity: number;
  portion_size: string | null;
  notes: string | null;
}

export interface Order {
  session_id: string;
  table_code: string;
  status: OrderStatus;
  entry_channel: EntryChannel;
  // Sub-flavor of walk-in with no physical table. When true the
  // synthetic `table_code` is TAKEAWAY-XXXXXX; UI shows a saffron
  // TAKEAWAY pill instead of the code.
  is_takeaway: boolean;
  customer_email?: string | null;
  customer_phone?: string | null;
  items: OrderItem[];
  started_at: string;
  started_seconds_ago: number;
  kitchen_ack_at: string | null;
  // Bill status, joined from the bills table on the server.
  bill_id: string | null;
  bill_number: string | null;
  bill_delivery_status: 'pending' | 'sent' | 'failed' | null;
  bill_total_minor: number | null;
  bill_sent_at: string | null;
}

type ChannelFilter = 'all' | 'qr' | 'walkin';

interface OrdersResponse {
  orders: Order[];
}

type Column = 'new' | 'preparing' | 'eating' | 'ready';

function classify(o: Order): Column {
  if (o.status === 'open') {
    return o.kitchen_ack_at ? 'preparing' : 'new';
  }
  if (o.status === 'before_captured' || o.status === 'eating') return 'eating';
  return 'ready';
}

function elapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

export function Orders() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { token, restaurantId } = useAuthStore();
  const qc = useQueryClient();
  const [billModalFor, setBillModalFor] = useState<Order | null>(null);
  const [viewBillFor, setViewBillFor] = useState<Order | null>(null);
  const [cancelFor, setCancelFor] = useState<Order | null>(null);
  const [editFor, setEditFor] = useState<Order | null>(null);
  const [drawerFor, setDrawerFor] = useState<Order | null>(null);
  const [channelFilter, setChannelFilter] = useState<ChannelFilter>('all');

  useEffect(() => {
    if (!token) navigate('/login');
  }, [token, navigate]);

  const { data, isLoading, error } = useQuery({
    queryKey: ['live-orders', restaurantId],
    queryFn: () =>
      api.get<OrdersResponse>(
        `/restaurants/${restaurantId}/dashboard/orders`,
        token,
      ),
    enabled: Boolean(restaurantId && token),
    // Poll every 3 s. Kitchen displays get left open on wall-mounted
    // tablets — the refetch is cheap and keeps table cards moving as
    // orders progress through the flow.
    refetchInterval: 3_000,
  });

  const ack = useMutation({
    mutationFn: (sessionId: string) =>
      api.post(`/sessions/${sessionId}/kitchen-ack`, undefined, token),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['live-orders', restaurantId] });
    },
  });

  if (!restaurantId) {
    return (
      <p className="text-s-muted text-sm">
        {t('summary.pick_restaurant')}
      </p>
    );
  }

  const allOrders = data?.orders ?? [];
  const orders = allOrders.filter(
    (o) => channelFilter === 'all' || o.entry_channel === channelFilter,
  );
  const byColumn: Record<Column, Order[]> = {
    new: [],
    preparing: [],
    eating: [],
    ready: [],
  };
  for (const o of orders) byColumn[classify(o)].push(o);

  return (
    <section className="flex flex-col gap-4">
      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="text-[12px] font-semibold text-s-muted dev uppercase tracking-wide">
            {t('app.nav.orders')}
          </div>
          <h1 className="display text-[28px] text-s-ink leading-tight">
            {t('orders.title')}
          </h1>
          <p className="text-[13px] text-s-muted mt-1 max-w-[54ch]">
            {t('orders.blurb')}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <ChannelFilterPill value={channelFilter} onChange={setChannelFilter} />
          <Link
            to="/orders/new-walkin"
            className="h-11 px-5 rounded-lg bg-brand text-white font-semibold text-sm inline-flex items-center gap-2 shadow-sm hover:bg-brand-press active:scale-[.98] transition"
          >
            <Plus size={18} />
            {t('walkin.new_order_cta')}
          </Link>
        </div>
      </header>

      {error && (
        <p className="text-sm text-danger bg-danger-wash border border-danger/20 rounded-md px-3 py-2">
          {(error as Error).message}
        </p>
      )}

      {!isLoading && orders.length === 0 && (
        <div className="empty rounded-lg border border-s-line bg-s-paper flex flex-col items-center justify-center text-center py-20">
          <div className="w-16 h-16 rounded-2xl bg-brand-wash text-brand flex items-center justify-center mb-4">
            <Utensils size={28} />
          </div>
          <p className="text-[15px] font-semibold text-s-ink">
            {t('walkin.empty_title')}
          </p>
          <p className="text-[13px] text-s-muted mt-1.5 max-w-[42ch]">
            {t('walkin.empty_blurb')}
          </p>
        </div>
      )}

      {orders.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
          <Column
            tone="brand"
            icon={<ClipboardList size={14} />}
            label={t('orders.col_new')}
            count={byColumn.new.length}
            orders={byColumn.new}
            renderAction={(o) => (
              <button
                onClick={() => ack.mutate(o.session_id)}
                disabled={ack.isPending}
                className="btn btn-primary min-h-[36px] text-[13px] w-full"
              >
                <Check size={14} />
                {t('orders.mark_sent')}
              </button>
            )}
            onSendBill={setBillModalFor}
            onViewBill={setViewBillFor}
            onCancel={setCancelFor}
            onEdit={setEditFor}
            onOpenDrawer={setDrawerFor}
            t={t}
          />
          <Column
            tone="saffron"
            icon={<ChefHat size={14} />}
            label={t('orders.col_preparing')}
            count={byColumn.preparing.length}
            orders={byColumn.preparing}
            onSendBill={setBillModalFor}
            onViewBill={setViewBillFor}
            onCancel={setCancelFor}
            onEdit={setEditFor}
            onOpenDrawer={setDrawerFor}
            t={t}
          />
          <Column
            tone="sage"
            icon={<Utensils size={14} />}
            label={t('orders.col_eating')}
            count={byColumn.eating.length}
            orders={byColumn.eating}
            onSendBill={setBillModalFor}
            onViewBill={setViewBillFor}
            onCancel={setCancelFor}
            onEdit={setEditFor}
            onOpenDrawer={setDrawerFor}
            t={t}
          />
          <Column
            tone="info"
            icon={<ArrowRight size={14} />}
            label={t('orders.col_ready')}
            count={byColumn.ready.length}
            orders={byColumn.ready}
            renderAction={(o) => (
              <Link
                to={`/validations/${o.session_id}`}
                className="btn btn-outline min-h-[36px] text-[13px] w-full"
              >
                {t('orders.review_in_queue')}
                <ArrowRight size={14} />
              </Link>
            )}
            onSendBill={setBillModalFor}
            onViewBill={setViewBillFor}
            onCancel={setCancelFor}
            onEdit={setEditFor}
            onOpenDrawer={setDrawerFor}
            t={t}
          />
        </div>
      )}

      {billModalFor && (
        <BillSendModal
          sessionId={billModalFor.session_id}
          tableCode={billModalFor.table_code}
          onClose={() => setBillModalFor(null)}
        />
      )}
      {viewBillFor && (
        <BillViewModal
          sessionId={viewBillFor.session_id}
          tableCode={viewBillFor.table_code}
          onClose={() => setViewBillFor(null)}
        />
      )}
      {cancelFor && (
        <CancelOrderModal
          sessionId={cancelFor.session_id}
          tableCode={cancelFor.table_code}
          onClose={() => setCancelFor(null)}
        />
      )}
      {editFor && (
        <EditItemsModal
          sessionId={editFor.session_id}
          tableCode={editFor.table_code}
          restaurantId={restaurantId!}
          currentItems={editFor.items}
          onClose={() => setEditFor(null)}
        />
      )}
      {drawerFor && (
        <OrderDetailDrawer
          order={drawerFor}
          onClose={() => setDrawerFor(null)}
        />
      )}
    </section>
  );
}

/**
 * Segmented All/QR/Walk-in filter chip. Pill visual (white/press for
 * active, transparent for inactive) matches the design prototype.
 * Local component so Orders.tsx doesn't leak a filter primitive.
 */
function ChannelFilterPill({
  value,
  onChange,
}: {
  value: ChannelFilter;
  onChange: (v: ChannelFilter) => void;
}) {
  const { t } = useTranslation();
  const opts: Array<{ key: ChannelFilter; label: string }> = [
    { key: 'all', label: t('walkin.filter_all') },
    { key: 'qr', label: t('walkin.filter_qr') },
    { key: 'walkin', label: t('walkin.filter_walkin') },
  ];
  return (
    <div
      role="tablist"
      className="inline-flex gap-0.5 bg-s-line/70 p-1 rounded-lg"
    >
      {opts.map((o) => {
        const active = value === o.key;
        return (
          <button
            key={o.key}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(o.key)}
            className={clsx(
              'h-9 px-4 rounded-md text-sm font-semibold transition-colors',
              active
                ? 'bg-s-paper text-s-ink shadow-sm'
                : 'text-s-muted hover:text-s-ink',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

interface ColumnProps {
  tone: 'brand' | 'saffron' | 'sage' | 'info';
  icon: React.ReactNode;
  label: string;
  count: number;
  orders: Order[];
  renderAction?: (o: Order) => React.ReactNode;
  onSendBill: (o: Order) => void;
  onViewBill: (o: Order) => void;
  onCancel: (o: Order) => void;
  onEdit: (o: Order) => void;
  onOpenDrawer: (o: Order) => void;
  t: ReturnType<typeof useTranslation>['t'];
}

function Column({
  tone,
  icon,
  label,
  count,
  orders,
  renderAction,
  onSendBill,
  onViewBill,
  onCancel,
  onEdit,
  onOpenDrawer,
  t,
}: ColumnProps) {
  const accentText =
    tone === 'brand'
      ? 'text-brand'
      : tone === 'saffron'
        ? 'text-saffron-deep'
        : tone === 'sage'
          ? 'text-sage'
          : 'text-info';
  const chipClass =
    tone === 'brand'
      ? 'chip-brand'
      : tone === 'saffron'
        ? 'chip-saffron'
        : tone === 'sage'
          ? 'chip-sage'
          : 'chip-info';
  return (
    <div className="flex flex-col gap-2">
      <header className="row spread items-center px-1">
        <div className={clsx('row gap-1.5 items-center', accentText)}>
          {icon}
          <span className="font-semibold text-[12px] dev uppercase tracking-wide">
            {label}
          </span>
        </div>
        <span className={clsx('chip', chipClass)}>{count}</span>
      </header>
      {orders.length === 0 ? (
        <div className="rounded-lg border border-dashed border-s-line py-8 text-center text-[12px] text-s-muted">
          {t('orders.column_empty')}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {orders.map((o) => (
            <OrderCard
              key={o.session_id}
              order={o}
              action={renderAction?.(o)}
              onSendBill={onSendBill}
              onViewBill={onViewBill}
              onCancel={onCancel}
              onEdit={onEdit}
              onOpenDrawer={onOpenDrawer}
              t={t}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface OrderCardProps {
  order: Order;
  action: React.ReactNode;
  onSendBill: (o: Order) => void;
  onViewBill: (o: Order) => void;
  onCancel: (o: Order) => void;
  onEdit: (o: Order) => void;
  onOpenDrawer: (o: Order) => void;
  t: ReturnType<typeof useTranslation>['t'];
}

function OrderCard({
  order,
  action,
  onSendBill,
  onViewBill,
  onCancel,
  onEdit,
  onOpenDrawer,
  t,
}: OrderCardProps) {
  const hasBill = order.bill_id !== null;
  // Both cancel and edit are blocked once a bill exists — server refuses.
  // Rather than surface a 409, hide the buttons; staff who need to void
  // an issued bill do that out-of-band.
  const canModify = !hasBill;
  const isWalkin = order.entry_channel === 'walkin';

  return (
    <article
      // relative + pl-4 so the absolutely-positioned ChannelStrip has
      // room to sit flush on the left edge without overlapping the
      // header. Card body itself remains the existing shape.
      className="relative rounded-lg border border-s-line bg-s-paper p-3 pl-4 flex flex-col gap-2 hover:shadow-sh-sm transition-shadow"
    >
      <ChannelStrip channel={order.entry_channel} />
      <button
        type="button"
        onClick={() => onOpenDrawer(order)}
        // Overlay that swallows clicks on the card background so
        // tapping anywhere on the card opens the drawer, but the
        // per-action buttons below still receive their own clicks
        // (they sit above via z-index).
        aria-label={t('walkin.open_order_details')}
        className="absolute inset-0 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand"
      />
      <div className="row spread items-center relative z-10 pointer-events-none">
        {order.is_takeaway ? (
          <TakeawayPill />
        ) : (
          <span className="font-mono text-[15px] font-bold text-s-ink tabular-nums">
            {order.table_code}
          </span>
        )}
        <span className="row gap-1 items-center text-[11.5px] text-s-muted">
          <Timer size={11} />
          {elapsed(order.started_seconds_ago)}
        </span>
      </div>
      <div className="row spread gap-1.5 items-center text-[11px] font-semibold text-s-faint uppercase tracking-wide relative z-10 pointer-events-none">
        <span className="row gap-1.5 items-center">
          {isWalkin ? <UsersIcon size={12} /> : <QrCode size={12} />}
          {isWalkin ? t('walkin.channel_walkin') : t('walkin.channel_qr')}
        </span>
        {order.items.some((it) => it.notes && it.notes.trim()) && (
          <span
            className="row gap-1 items-center text-s-muted normal-case tracking-normal"
            title={t('notes.has_notes_aria')}
          >
            <MessageSquare size={12} />
          </span>
        )}
      </div>
      <ul className="flex flex-col gap-0.5 text-[13px] text-s-ink relative z-10 pointer-events-none">
        {order.items.map((it) => (
          <li key={it.menu_item_id} className="row gap-2 items-baseline">
            <span className="tnum font-bold w-6 text-right">
              {it.quantity}×
            </span>
            <span className="flex-1">{it.name}</span>
            {it.portion_size && it.portion_size !== 'regular' && (
              <span className="chip chip-muted">{it.portion_size}</span>
            )}
          </li>
        ))}
      </ul>
      <div className="relative z-10">
        <BillLine
          order={order}
          onSendBill={onSendBill}
          onViewBill={onViewBill}
          t={t}
        />
      </div>
      {canModify && (
        <div className="row gap-1 pt-1 border-t border-s-line/60 relative z-10">
          <button
            type="button"
            onClick={() => onEdit(order)}
            className="row gap-1 items-center text-[11.5px] font-semibold text-s-muted hover:text-s-ink px-1.5 py-0.5"
          >
            <Pencil size={11} />
            {t('orders.edit')}
          </button>
          <span className="text-s-muted/40">·</span>
          <button
            type="button"
            onClick={() => onCancel(order)}
            className="row gap-1 items-center text-[11.5px] font-semibold text-s-muted hover:text-danger px-1.5 py-0.5"
          >
            <XCircle size={11} />
            {t('orders.cancel')}
          </button>
        </div>
      )}
      {action && <div className="relative z-10">{action}</div>}
    </article>
  );
}

/**
 * BillLine — per-card bill state summary + click-to-send.
 * Sits between the item list and the column action button so a staff
 * member always sees whether the bill went out without having to
 * drill into the session.
 */
function BillLine({
  order,
  onSendBill,
  onViewBill,
  t,
}: {
  order: Order;
  onSendBill: (o: Order) => void;
  onViewBill: (o: Order) => void;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  const status = order.bill_delivery_status;
  const label =
    status === 'sent'
      ? t('orders.bill_sent')
      : status === 'pending'
        ? t('orders.bill_pending')
        : status === 'failed'
          ? t('orders.bill_failed')
          : t('orders.bill_none');
  const chipClass =
    status === 'sent'
      ? 'chip-sage'
      : status === 'pending'
        ? 'chip-amber'
        : status === 'failed'
          ? 'chip-danger'
          : 'chip-muted';
  const canSend = order.items.length > 0;
  const hasBill = order.bill_id !== null;
  return (
    <div className="row spread gap-2 pt-1 border-t border-s-line/60">
      {hasBill ? (
        <button
          type="button"
          onClick={() => onViewBill(order)}
          className={clsx('chip hover:opacity-80 transition', chipClass)}
          aria-label={t('orders.bill_view')}
          title={t('orders.bill_view')}
        >
          <Receipt size={11} />
          {label}
          <Eye size={10} className="opacity-70" />
        </button>
      ) : (
        <span className={clsx('chip', chipClass)}>
          <Receipt size={11} />
          {label}
        </span>
      )}
      {canSend && (
        <button
          onClick={() => onSendBill(order)}
          className="text-[12px] font-semibold text-brand hover:underline"
        >
          {status === 'sent'
            ? t('orders.bill_resend')
            : t('orders.bill_send')}
        </button>
      )}
    </div>
  );
}
