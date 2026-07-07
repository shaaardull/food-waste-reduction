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
} from 'lucide-react';
import { clsx } from 'clsx';
import { useState } from 'react';
import { api } from '../lib/api';
import { useAuthStore } from '../lib/auth';
import { BillSendModal } from '../components/BillSendModal';

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
  | 'pending_staff_validation';

interface OrderItem {
  menu_item_id: string;
  name: string;
  quantity: number;
  portion_size: string | null;
  notes: string | null;
}

interface Order {
  session_id: string;
  table_code: string;
  status: OrderStatus;
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

  const orders = data?.orders ?? [];
  const byColumn: Record<Column, Order[]> = {
    new: [],
    preparing: [],
    eating: [],
    ready: [],
  };
  for (const o of orders) byColumn[classify(o)].push(o);

  return (
    <section className="flex flex-col gap-4">
      <header>
        <div className="text-[12px] font-semibold text-s-muted dev uppercase tracking-wide">
          {t('app.nav.orders')}
        </div>
        <h1 className="display text-[28px] text-s-ink leading-tight">
          {t('orders.title')}
        </h1>
        <p className="text-[13px] text-s-muted mt-1 max-w-[54ch]">
          {t('orders.blurb')}
        </p>
      </header>

      {error && (
        <p className="text-sm text-danger bg-danger-wash border border-danger/20 rounded-md px-3 py-2">
          {(error as Error).message}
        </p>
      )}

      {!isLoading && orders.length === 0 && (
        <div className="empty rounded-lg border border-s-line bg-s-paper">
          <div className="art">
            <Utensils size={32} />
          </div>
          <p className="text-[15px] font-semibold text-s-ink">
            {t('orders.empty_title')}
          </p>
          <p className="text-[13px] text-s-muted mt-1.5 max-w-[42ch]">
            {t('orders.empty_blurb')}
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
            t={t}
          />
          <Column
            tone="saffron"
            icon={<ChefHat size={14} />}
            label={t('orders.col_preparing')}
            count={byColumn.preparing.length}
            orders={byColumn.preparing}
            onSendBill={setBillModalFor}
            t={t}
          />
          <Column
            tone="sage"
            icon={<Utensils size={14} />}
            label={t('orders.col_eating')}
            count={byColumn.eating.length}
            orders={byColumn.eating}
            onSendBill={setBillModalFor}
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
    </section>
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
  t: ReturnType<typeof useTranslation>['t'];
}

function OrderCard({ order, action, onSendBill, t }: OrderCardProps) {
  return (
    <article className="rounded-lg border border-s-line bg-s-paper p-3 flex flex-col gap-2">
      <div className="row spread items-center">
        <span className="chip chip-brand">
          {t('queue.table', { code: order.table_code })}
        </span>
        <span className="row gap-1 items-center text-[11.5px] text-s-muted">
          <Timer size={11} />
          {elapsed(order.started_seconds_ago)}
        </span>
      </div>
      <ul className="flex flex-col gap-0.5 text-[13px] text-s-ink">
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
      <BillLine order={order} onSendBill={onSendBill} t={t} />
      {action && <div>{action}</div>}
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
  t,
}: {
  order: Order;
  onSendBill: (o: Order) => void;
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
  return (
    <div className="row spread gap-2 pt-1 border-t border-s-line/60">
      <span className={clsx('chip', chipClass)}>
        <Receipt size={11} />
        {label}
      </span>
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
