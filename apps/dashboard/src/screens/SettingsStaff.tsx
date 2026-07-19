import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  Crown,
  Mail,
  Plus,
  RefreshCw,
  Shield,
  Trash2,
  Users,
  X as CloseIcon,
} from 'lucide-react';
import { clsx } from 'clsx';
import { api } from '../lib/api';
import type { ApiException } from '../lib/api';
import { useAuthStore } from '../lib/auth';
import { useToasts } from '../lib/toasts';

/**
 * Settings → Staff — owner-facing crew management.
 *
 * Backend contract (see apps/api/app/routers/restaurant_staff.py):
 *   GET    /restaurants/:id/staff
 *   POST   /restaurants/:id/staff
 *   POST   /restaurants/:id/staff/:uid/resend-invitation
 *   DELETE /restaurants/:id/staff/:uid
 *
 * Auth is enforced server-side but mirrored client-side so the UI
 * doesn't tempt a manager into a 403: managers see the "+ Add staff"
 * button but the role picker locks Owner off, and Remove is only
 * shown for server-role rows when the caller is a manager. Servers
 * see no mutation controls at all.
 */

type StaffRole = 'owner' | 'manager' | 'server';

interface StaffMember {
  user_id: string;
  email: string;
  display_name: string | null;
  role: StaffRole;
  added_at: string;
  invitation_pending: boolean;
}

function nameOrLocalPart(row: StaffMember): { primary: string; secondary?: string } {
  if (row.display_name && row.display_name.trim()) {
    return { primary: row.display_name.trim(), secondary: row.email };
  }
  const at = row.email.indexOf('@');
  return {
    primary: at > 0 ? row.email.slice(0, at) : row.email,
    secondary: row.email,
  };
}

function relativeDate(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const now = Date.now();
  const days = Math.round((now - then) / (1000 * 60 * 60 * 24));
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
  const years = Math.round(days / 365);
  return `${years} year${years === 1 ? '' : 's'} ago`;
}

/** Which roles the caller is allowed to touch, mirroring the backend
 *  guard in restaurant_staff.py:_require_can_manage_role. */
function canManage(callerRole: StaffRole | null, targetRole: StaffRole): boolean {
  if (callerRole === 'owner') return true;
  if (callerRole === 'manager') return targetRole === 'server';
  return false;
}

export function SettingsStaff() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { token, restaurantId, user } = useAuthStore();
  const qc = useQueryClient();
  const pushToast = useToasts((s) => s.push);

  useEffect(() => {
    if (!token) navigate('/login');
  }, [token, navigate]);

  const listKey = ['restaurant-staff', restaurantId];
  const { data, isLoading, error } = useQuery<StaffMember[]>({
    queryKey: listKey,
    queryFn: () =>
      api.get<StaffMember[]>(`/restaurants/${restaurantId}/staff`, token),
    enabled: Boolean(token && restaurantId),
  });

  const [addOpen, setAddOpen] = useState(false);
  const [removeFor, setRemoveFor] = useState<StaffMember | null>(null);

  // The current user's role at this restaurant. Falls back to null for
  // admins (platform-owner viewers) — they get owner-tier UI treatment.
  const callerRole: StaffRole | null = useMemo(() => {
    if (!user || !data) return null;
    const me = data.find((r) => r.user_id === user.id);
    if (me) return me.role;
    if (user.role === 'admin') return 'owner';
    return null;
  }, [user, data]);

  const canAdd = callerRole === 'owner' || callerRole === 'manager';

  const invalidate = () => qc.invalidateQueries({ queryKey: listKey });

  const resend = useMutation({
    mutationFn: (row: StaffMember) =>
      api.post(
        `/restaurants/${restaurantId}/staff/${row.user_id}/resend-invitation`,
        {},
        token,
      ),
    onSuccess: (_res, row) => {
      pushToast({
        tone: 'sage',
        title: t('settings.staff.toast_resent_title'),
        body: t('settings.staff.toast_resent_body', { email: row.email }),
      });
    },
    onError: (err: ApiException) =>
      pushToast({
        tone: 'alert',
        title: t('settings.staff.err_generic'),
        body: err.message,
      }),
  });

  if (!restaurantId) {
    return (
      <p className="text-s-muted text-sm">{t('summary.pick_restaurant')}</p>
    );
  }
  if (isLoading) {
    return <p className="text-s-muted text-sm">{t('settings.staff.loading')}</p>;
  }
  if (error) {
    return (
      <p className="text-sm text-danger bg-danger-wash border border-danger/20 rounded-md px-3 py-2">
        {(error as Error).message}
      </p>
    );
  }

  const rows = data ?? [];
  const onlyMe = rows.length === 1 && user && rows[0]!.user_id === user.id;

  return (
    <section className="flex flex-col gap-5 max-w-[860px]">
      <header className="row spread items-start gap-3">
        <div>
          <div className="text-[12px] font-semibold text-s-muted dev uppercase tracking-wide row gap-1.5 items-center">
            <Users size={12} />
            {t('settings.staff.eyebrow')}
          </div>
          <h1 className="display text-[28px] text-s-ink leading-tight">
            {t('settings.staff.title')}
          </h1>
          <p className="text-[13px] text-s-muted mt-1 max-w-[60ch]">
            {t('settings.staff.blurb')}
          </p>
        </div>
        {canAdd && (
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            className="row gap-1.5 items-center bg-brand text-white font-semibold text-[13.5px] rounded-md px-3.5 py-2 hover:bg-brand-press transition shrink-0"
          >
            <Plus size={14} />
            {t('settings.staff.add_cta')}
          </button>
        )}
      </header>

      {onlyMe ? (
        <EmptyState onAdd={canAdd ? () => setAddOpen(true) : undefined} />
      ) : (
        <div className="border border-s-line rounded-lg bg-s-paper overflow-hidden">
          <div className="hidden md:grid grid-cols-[minmax(0,1.4fr)_120px_120px_140px_180px] gap-3 px-4 py-2 text-[11px] font-semibold text-s-muted dev uppercase tracking-wide bg-s-bg/60 border-b border-s-line">
            <div>{t('settings.staff.col_name')}</div>
            <div>{t('settings.staff.col_role')}</div>
            <div>{t('settings.staff.col_added')}</div>
            <div>{t('settings.staff.col_status')}</div>
            <div className="text-right">{t('settings.staff.col_actions')}</div>
          </div>
          <ul className="divide-y divide-s-line/60">
            {rows.map((row) => (
              <StaffRow
                key={row.user_id}
                row={row}
                isMe={Boolean(user && row.user_id === user.id)}
                canResend={canManage(callerRole, row.role)}
                canRemove={canManage(callerRole, row.role)}
                onResend={() => resend.mutate(row)}
                onRemove={() => setRemoveFor(row)}
              />
            ))}
          </ul>
        </div>
      )}

      {addOpen && (
        <AddStaffModal
          callerRole={callerRole}
          onClose={() => setAddOpen(false)}
          onAdded={(added) => {
            setAddOpen(false);
            void invalidate();
            pushToast({
              tone: 'sage',
              title: added.invitation_pending
                ? t('settings.staff.toast_invited_title')
                : t('settings.staff.toast_added_title'),
              body: added.invitation_pending
                ? t('settings.staff.toast_invited_body', { email: added.email })
                : t('settings.staff.toast_added_body', { email: added.email }),
            });
          }}
        />
      )}
      {removeFor && (
        <RemoveStaffModal
          row={removeFor}
          onClose={() => setRemoveFor(null)}
          onDone={() => {
            const removedEmail = removeFor.email;
            setRemoveFor(null);
            void invalidate();
            pushToast({
              tone: 'sage',
              title: t('settings.staff.toast_removed_title'),
              body: t('settings.staff.toast_removed_body', { email: removedEmail }),
            });
          }}
        />
      )}
    </section>
  );
}

function EmptyState({ onAdd }: { onAdd?: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center gap-3 py-14 border border-dashed border-s-line rounded-lg bg-s-paper text-center">
      <div className="w-14 h-14 rounded-lg bg-brand-wash flex items-center justify-center text-brand">
        <Users size={22} />
      </div>
      <div>
        <div className="font-semibold text-[15px] text-s-ink">
          {t('settings.staff.empty_title')}
        </div>
        <p className="text-[13px] text-s-muted mt-1 max-w-[46ch]">
          {t('settings.staff.empty_blurb')}
        </p>
      </div>
      {onAdd && (
        <button
          type="button"
          onClick={onAdd}
          className="row gap-1.5 items-center bg-brand text-white font-semibold text-[14px] rounded-md px-4 py-2 hover:bg-brand-press transition"
        >
          <Plus size={14} />
          {t('settings.staff.empty_cta')}
        </button>
      )}
    </div>
  );
}

function StaffRow({
  row,
  isMe,
  canResend,
  canRemove,
  onResend,
  onRemove,
}: {
  row: StaffMember;
  isMe: boolean;
  canResend: boolean;
  canRemove: boolean;
  onResend: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const { primary, secondary } = nameOrLocalPart(row);
  return (
    <li className="grid grid-cols-1 md:grid-cols-[minmax(0,1.4fr)_120px_120px_140px_180px] gap-3 px-4 py-3 items-center">
      <div className="min-w-0">
        <div className="row gap-1.5 items-center">
          <span className="font-semibold text-[14px] text-s-ink truncate">
            {primary}
          </span>
          {isMe && (
            <span className="text-[10.5px] font-semibold text-s-muted bg-s-line/60 rounded px-1.5 py-0.5 uppercase tracking-wide shrink-0">
              {t('settings.staff.you_pill')}
            </span>
          )}
        </div>
        {secondary && (
          <div className="text-[12px] text-s-muted truncate">{secondary}</div>
        )}
      </div>
      <div>
        <RoleChip role={row.role} />
      </div>
      <div className="text-[12.5px] text-s-muted">{relativeDate(row.added_at)}</div>
      <div>
        <StatusPill pending={row.invitation_pending} />
      </div>
      <div className="row gap-3 justify-end">
        {row.invitation_pending && canResend && (
          <button
            type="button"
            onClick={onResend}
            className="row gap-1 items-center text-[12.5px] font-semibold text-brand hover:text-brand-press transition"
          >
            <RefreshCw size={12} />
            {t('settings.staff.action_resend')}
          </button>
        )}
        {canRemove && !isMe && (
          <button
            type="button"
            onClick={onRemove}
            className="row gap-1 items-center text-[12.5px] font-semibold text-danger hover:opacity-80 transition"
          >
            <Trash2 size={12} />
            {t('settings.staff.action_remove')}
          </button>
        )}
      </div>
    </li>
  );
}

function RoleChip({ role }: { role: StaffRole }) {
  const { t } = useTranslation();
  if (role === 'owner') {
    return (
      <span className="row gap-1 items-center text-[12px] font-semibold text-brand bg-brand-wash border border-brand/20 rounded-full px-2 py-0.5">
        <Crown size={11} />
        {t('settings.staff.role_owner')}
      </span>
    );
  }
  if (role === 'manager') {
    return (
      <span className="row gap-1 items-center text-[12px] font-semibold text-sage-deep bg-sage/15 border border-sage/30 rounded-full px-2 py-0.5">
        <Shield size={11} />
        {t('settings.staff.role_manager')}
      </span>
    );
  }
  return (
    <span className="row gap-1 items-center text-[12px] font-semibold text-s-muted bg-s-line/60 border border-s-line rounded-full px-2 py-0.5">
      <Users size={11} />
      {t('settings.staff.role_server')}
    </span>
  );
}

function StatusPill({ pending }: { pending: boolean }) {
  const { t } = useTranslation();
  if (pending) {
    return (
      <span className="row gap-1 items-center text-[12px] font-semibold text-saffron bg-saffron/15 border border-saffron/30 rounded-full px-2 py-0.5">
        <Mail size={11} />
        {t('settings.staff.status_pending')}
      </span>
    );
  }
  return (
    <span className="row gap-1 items-center text-[12px] font-semibold text-sage-deep bg-sage/15 border border-sage/30 rounded-full px-2 py-0.5">
      <span className="w-1.5 h-1.5 rounded-full bg-sage-deep" />
      {t('settings.staff.status_active')}
    </span>
  );
}

/* ─────────── Add modal ─────────── */

function AddStaffModal({
  callerRole,
  onClose,
  onAdded,
}: {
  callerRole: StaffRole | null;
  onClose: () => void;
  onAdded: (out: {
    email: string;
    role: StaffRole;
    invitation_pending: boolean;
  }) => void;
}) {
  const { t } = useTranslation();
  const { token, restaurantId } = useAuthStore();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<StaffRole>('server');
  const [sendInvitation, setSendInvitation] = useState(true);
  const [tempPassword, setTempPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      return api.post<{
        user_id: string;
        email: string;
        role: StaffRole;
        invitation_pending: boolean;
      }>(
        `/restaurants/${restaurantId}/staff`,
        {
          email: email.trim().toLowerCase(),
          role,
          send_invitation: sendInvitation,
          ...(sendInvitation
            ? {}
            : { temp_password: tempPassword }),
        },
        token,
      );
    },
    onSuccess: (res) => onAdded(res),
    onError: (e: ApiException) => setErr(e.message),
  });

  const canPickOwner = callerRole === 'owner';

  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-center justify-center p-4">
      <div className="w-full max-w-[480px] bg-s-paper border border-s-line rounded-lg shadow-pop flex flex-col overflow-hidden">
        <div className="px-5 py-4 border-b border-s-line row spread items-start">
          <div>
            <div className="text-[12px] font-semibold text-brand dev uppercase tracking-wide">
              {t('settings.staff.modal_add_eyebrow')}
            </div>
            <h2 className="display text-[22px] text-s-ink leading-tight">
              {t('settings.staff.modal_add_title')}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('settings.staff.close_modal')}
            className="w-8 h-8 rounded-md hover:bg-s-bg flex items-center justify-center text-s-muted"
          >
            <CloseIcon size={16} />
          </button>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setErr(null);
            if (!email.trim()) {
              setErr(t('settings.staff.err_email_required'));
              return;
            }
            if (!sendInvitation && !tempPassword) {
              setErr(t('settings.staff.err_temp_password_required'));
              return;
            }
            save.mutate();
          }}
          className="flex flex-col gap-4 p-5"
        >
          <label className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-semibold text-s-ink">
              {t('settings.staff.field_email')}
            </span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              maxLength={254}
              placeholder="name@example.com"
              className="input mt-0"
              autoFocus
              required
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-semibold text-s-ink">
              {t('settings.staff.field_role')}
            </span>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as StaffRole)}
              className="input mt-0"
            >
              <option value="server">{t('settings.staff.role_server')}</option>
              <option value="manager">{t('settings.staff.role_manager')}</option>
              <option value="owner" disabled={!canPickOwner}>
                {t('settings.staff.role_owner')}
                {!canPickOwner ? ` — ${t('settings.staff.role_owner_locked')}` : ''}
              </option>
            </select>
          </label>

          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={sendInvitation}
              onChange={(e) => setSendInvitation(e.target.checked)}
              className="mt-1 w-4 h-4 accent-brand"
            />
            <div className="flex-1">
              <div className="font-semibold text-[13.5px] text-s-ink">
                {t('settings.staff.field_send_invitation')}
              </div>
              <p className="text-[12px] text-s-muted leading-snug mt-0.5">
                {t('settings.staff.field_send_invitation_hint')}
              </p>
            </div>
          </label>

          {!sendInvitation && (
            <label className="flex flex-col gap-1.5">
              <span className="text-[12.5px] font-semibold text-s-ink">
                {t('settings.staff.field_temp_password')}
              </span>
              <input
                type="text"
                value={tempPassword}
                onChange={(e) => setTempPassword(e.target.value)}
                minLength={8}
                maxLength={128}
                placeholder={t('settings.staff.field_temp_password_placeholder')}
                className="input mt-0 font-mono"
              />
              <span className="text-[11.5px] text-s-muted leading-snug">
                {t('settings.staff.field_temp_password_hint')}
              </span>
            </label>
          )}

          {err && (
            <p className="text-sm text-danger bg-danger-wash border border-danger/20 rounded-md px-3 py-2">
              {err}
            </p>
          )}

          <div className="row gap-2 justify-end pt-2 border-t border-s-line/60">
            <button
              type="button"
              onClick={onClose}
              className="h-10 px-4 rounded-md border border-s-line text-s-ink font-semibold text-[13.5px] hover:bg-s-bg transition"
            >
              {t('settings.staff.cancel')}
            </button>
            <button
              type="submit"
              disabled={save.isPending}
              className={clsx(
                'h-10 px-5 rounded-md bg-brand text-white font-semibold text-[13.5px] transition disabled:opacity-60',
                'hover:bg-brand-press',
              )}
            >
              {save.isPending
                ? t('settings.staff.saving')
                : sendInvitation
                  ? t('settings.staff.add_confirm_invite')
                  : t('settings.staff.add_confirm_inline')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ─────────── Remove modal ─────────── */

function RemoveStaffModal({
  row,
  onClose,
  onDone,
}: {
  row: StaffMember;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const { token, restaurantId } = useAuthStore();
  const [err, setErr] = useState<string | null>(null);
  const mut = useMutation({
    mutationFn: () =>
      api.del(`/restaurants/${restaurantId}/staff/${row.user_id}`, token),
    onSuccess: () => onDone(),
    onError: (e: ApiException) => setErr(e.message),
  });
  const displayName = nameOrLocalPart(row).primary;
  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-center justify-center p-4">
      <div className="w-full max-w-[440px] bg-s-paper border border-s-line rounded-lg shadow-pop flex flex-col overflow-hidden">
        <div className="px-5 py-4 border-b border-s-line">
          <div className="text-[12px] font-semibold text-s-muted dev uppercase tracking-wide">
            {t('settings.staff.remove_eyebrow')}
          </div>
          <h2 className="display text-[20px] text-s-ink leading-tight">
            {t('settings.staff.remove_title', { name: displayName })}
          </h2>
        </div>
        <div className="p-5 flex flex-col gap-4">
          <p className="text-[13.5px] text-s-muted leading-normal">
            {t('settings.staff.remove_body')}
          </p>
          {err && (
            <p className="text-sm text-danger bg-danger-wash border border-danger/20 rounded-md px-3 py-2">
              {err}
            </p>
          )}
          <div className="row gap-2 justify-end pt-2 border-t border-s-line/60">
            <button
              type="button"
              onClick={onClose}
              className="h-10 px-4 rounded-md border border-s-line text-s-ink font-semibold text-[13.5px] hover:bg-s-bg transition"
            >
              {t('settings.staff.cancel')}
            </button>
            <button
              type="button"
              onClick={() => mut.mutate()}
              disabled={mut.isPending}
              className="h-10 px-5 rounded-md font-semibold text-[13.5px] transition disabled:opacity-60 bg-danger text-white hover:bg-danger/90"
            >
              {mut.isPending
                ? t('settings.staff.working')
                : t('settings.staff.remove_confirm')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
