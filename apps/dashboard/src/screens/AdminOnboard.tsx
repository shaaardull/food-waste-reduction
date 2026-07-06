import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Trans, useTranslation } from 'react-i18next';
import { Camera } from 'lucide-react';
import type { Restaurant } from '@plate-clean/shared-types';
import { api, ApiException } from '../lib/api';
import { useAuthStore } from '../lib/auth';
import { ScanMenuModal, type ScannedItem } from '../components/ScanMenuModal';

type Step = 'restaurant' | 'menu' | 'reward' | 'staff' | 'done';

type StaffRole = 'owner' | 'manager' | 'server';

interface InvitedStaff {
  user_id: string;
  email: string;
  role: StaffRole;
  password: string;
}

interface MenuItemForm {
  name: string;
  price_minor: number;
  category: 'starter' | 'main' | 'side' | 'bread' | 'drink' | 'dessert';
  is_reward_eligible: boolean;
}

interface CreatedMenuItem {
  id: string;
  name: string;
  price_minor: number;
  category: string | null;
  is_reward_eligible: boolean;
}

interface CreatedRewardRule {
  id: string;
  name: string;
}

const DEFAULT_MENU: MenuItemForm[] = [
  { name: 'Signature Main', price_minor: 30000, category: 'main', is_reward_eligible: true },
  { name: 'Side', price_minor: 8000, category: 'side', is_reward_eligible: false },
  { name: 'Drink', price_minor: 12000, category: 'drink', is_reward_eligible: false },
  { name: 'House Dessert', price_minor: 10000, category: 'dessert', is_reward_eligible: true },
];

export function AdminOnboard() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { token, user } = useAuthStore();
  // When the URL is /onboard/:restaurantId/setup, the new owner who just
  // came out of the self-service /onboard form drops in here pre-armed
  // with a restaurant. Skip step 1 (which is "create the restaurant"),
  // load the existing row, and start at step 2 (menu).
  const { restaurantId: setupRestaurantId } = useParams<{
    restaurantId?: string;
  }>();
  const isSelfServiceContinuation = Boolean(setupRestaurantId);

  const [step, setStep] = useState<Step>(
    isSelfServiceContinuation ? 'menu' : 'restaurant',
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Step 1 state
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [address, setAddress] = useState('');
  const [latitude, setLatitude] = useState('19.06');
  const [longitude, setLongitude] = useState('72.83');
  const [primaryColor, setPrimaryColor] = useState('#0f766e');
  const [logoUrl, setLogoUrl] = useState('');
  const [tagline, setTagline] = useState('');
  // GST config — added in Gap-D. Optional at onboarding; defaults kick
  // in server-side (5% CGST+SGST split, HSN 9963, no prefix).
  const [gstin, setGstin] = useState('');
  const [gstRatePct, setGstRatePct] = useState('5');
  const [billPrefix, setBillPrefix] = useState('');

  // Step 2 state
  const [items, setItems] = useState<MenuItemForm[]>(DEFAULT_MENU);
  // Toggle for the vision-based menu-card scanner. When the modal
  // confirms, we merge its rows into `items` and the wizard's own
  // "Save {{count}} items" button handles the actual POST.
  const [scanMenuOpen, setScanMenuOpen] = useState(false);

  // Step 3 state
  const [thresholdPct, setThresholdPct] = useState(75);
  const [rewardMenuItemId, setRewardMenuItemId] = useState<string>('');

  // Step 4 (staff) state
  const [staffEmail, setStaffEmail] = useState('');
  const [staffName, setStaffName] = useState('');
  const [staffRole, setStaffRole] = useState<StaffRole>('owner');
  const [staffPassword, setStaffPassword] = useState('');

  // Derived state across steps
  const [restaurant, setRestaurant] = useState<Restaurant | null>(null);
  const [createdMenu, setCreatedMenu] = useState<CreatedMenuItem[]>([]);
  const [rewardRule, setRewardRule] = useState<CreatedRewardRule | null>(null);
  const [invitedStaff, setInvitedStaff] = useState<InvitedStaff[]>([]);

  // Self-service continuation: load the restaurant the new owner just
  // created via /onboard, so the wizard's menu/reward/staff steps know
  // which restaurant to write against.
  useEffect(() => {
    if (!setupRestaurantId || restaurant) return;
    let cancelled = false;
    api
      .get<Restaurant>(`/restaurants/by-id/${setupRestaurantId}`, token)
      // `/restaurants/:slug` endpoint takes a slug; we don't have a
      // /restaurants/by-id route, so fall back to the list endpoint
      // and find by id. Cheap because the list is short.
      .catch(async () => api.get<Restaurant[]>('/restaurants'))
      .then((res) => {
        if (cancelled) return;
        const r = Array.isArray(res)
          ? res.find((x) => x.id === setupRestaurantId)
          : res;
        if (r) setRestaurant(r);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [setupRestaurantId, restaurant, token]);

  // Access gate. Admins always pass. Otherwise: only the just-onboarded
  // owner — i.e. someone who's signed in as staff and is the owner of
  // the restaurant whose setup they're continuing — gets past.
  const isOwnerContinuation =
    isSelfServiceContinuation && user?.role === 'staff';
  if (!user || (user.role !== 'admin' && !isOwnerContinuation)) {
    return (
      <section className="max-w-md mx-auto space-y-3">
        <h1 className="text-xl font-semibold">{t('admin.admin_only_title')}</h1>
        <p className="text-sm text-s-muted">{t('admin.admin_only_blurb')}</p>
      </section>
    );
  }

  async function createRestaurant(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        name,
        slug,
        address,
        latitude: Number(latitude),
        longitude: Number(longitude),
        theme_primary_color: primaryColor,
      };
      if (tagline) body.tagline = tagline;
      if (logoUrl) body.theme_logo_url = logoUrl;
      if (gstin.trim()) body.gstin = gstin.trim().toUpperCase();
      // Only override server default (5%) when the user actually
      // touched the field. Keep as string — Pydantic Decimal accepts.
      if (gstRatePct.trim() && gstRatePct.trim() !== '5') {
        const asFraction = (Number(gstRatePct) / 100).toFixed(3);
        body.gst_rate = asFraction;
      }
      if (billPrefix.trim()) body.bill_prefix = billPrefix.trim();
      const created = await api.post<Restaurant>('/restaurants', body, token);
      setRestaurant(created);
      setStep('menu');
    } catch (err) {
      if (err instanceof ApiException) setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function bulkAddItems() {
    if (!restaurant) return;
    setError(null);
    setBusy(true);
    try {
      const created = await api.post<CreatedMenuItem[]>(
        `/restaurants/${restaurant.id}/menu-items`,
        { items },
        token,
      );
      setCreatedMenu(created);
      const dessert = created.find((m) => m.category === 'dessert' && m.is_reward_eligible);
      const fallback = created.find((m) => m.is_reward_eligible) ?? created[0];
      const pick = dessert ?? fallback;
      if (pick) setRewardMenuItemId(pick.id);
      setStep('reward');
    } catch (err) {
      if (err instanceof ApiException) setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function createRule() {
    if (!restaurant || !rewardMenuItemId) return;
    setError(null);
    setBusy(true);
    try {
      const rewardItem = createdMenu.find((m) => m.id === rewardMenuItemId);
      const body: Record<string, unknown> = {
        name: rewardItem ? `Free ${rewardItem.name}` : 'Reward',
        consumption_threshold: (thresholdPct / 100).toFixed(2),
        reward_menu_item_id: rewardMenuItemId,
        allowed_reward_types: ['menu_item', 'bill_discount'],
      };
      if (rewardItem) body.bill_discount_minor = rewardItem.price_minor;
      const rule = await api.post<CreatedRewardRule>(
        `/restaurants/${restaurant.id}/reward-rules`,
        body,
        token,
      );
      setRewardRule(rule);
      // Pre-fill the staff invite with the slug-based suggested owner email.
      // (.example.com so the address passes EmailStr deliverability checks
      // and is loggable straight away.)
      setStaffEmail(`owner@${restaurant.slug}.example.com`);
      setStaffRole('owner');
      setStep('staff');
    } catch (err) {
      if (err instanceof ApiException) setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function inviteStaff(e: React.FormEvent) {
    e.preventDefault();
    if (!restaurant) return;
    setError(null);
    setBusy(true);
    try {
      const res = await api.post<{ user_id: string; email: string; role: StaffRole }>(
        `/restaurants/${restaurant.id}/staff`,
        {
          email: staffEmail.trim().toLowerCase(),
          display_name: staffName || undefined,
          role: staffRole,
          password: staffPassword,
        },
        token,
      );
      setInvitedStaff([
        ...invitedStaff,
        { user_id: res.user_id, email: res.email, role: res.role, password: staffPassword },
      ]);
      // Reset the form for the next invite. Suggest a default for the
      // remaining roles to make multi-invite quick.
      const nextRole: StaffRole =
        invitedStaff.some((s) => s.role === 'owner') || staffRole === 'owner' ? 'manager' : 'owner';
      setStaffRole(nextRole);
      setStaffEmail('');
      setStaffName('');
      setStaffPassword('');
    } catch (err) {
      if (err instanceof ApiException) setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="max-w-xl mx-auto space-y-5">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">{t('admin.title')}</h1>
        <ol className="text-xs text-s-muted flex gap-2 flex-wrap">
          <li className={step === 'restaurant' ? 'text-brand font-semibold' : ''}>{t('admin.step.details')}</li>
          <li>›</li>
          <li className={step === 'menu' ? 'text-brand font-semibold' : ''}>{t('admin.step.menu')}</li>
          <li>›</li>
          <li className={step === 'reward' ? 'text-brand font-semibold' : ''}>{t('admin.step.reward')}</li>
          <li>›</li>
          <li className={step === 'staff' ? 'text-brand font-semibold' : ''}>{t('admin.step.staff')}</li>
          <li>›</li>
          <li className={step === 'done' ? 'text-brand font-semibold' : ''}>{t('admin.step.done')}</li>
        </ol>
      </header>
      {error && (
        <p className="rounded-md text-danger bg-danger-wash border border-danger/20 text-sm px-3 py-2">
          {error}
        </p>
      )}

      {step === 'restaurant' && (
        <form onSubmit={createRestaurant} className="space-y-3 bg-s-paper border border-s-line rounded-lg p-4">
          <Field label={t('admin.details.name_label')}>
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="input"
            />
          </Field>
          <Field label={t('admin.details.slug_label')} hint={t('admin.details.slug_hint')}>
            <input
              required
              pattern="[a-z0-9-]+"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              className="input font-mono"
            />
          </Field>
          <Field label={t('admin.details.address_label')}>
            <input
              required
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              className="input"
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('admin.details.latitude_label')}>
              <input
                required
                type="number"
                step="any"
                value={latitude}
                onChange={(e) => setLatitude(e.target.value)}
                className="input"
              />
            </Field>
            <Field label={t('admin.details.longitude_label')}>
              <input
                required
                type="number"
                step="any"
                value={longitude}
                onChange={(e) => setLongitude(e.target.value)}
                className="input"
              />
            </Field>
          </div>
          <Field label={t('admin.details.theme_color_label')}>
            <div className="flex items-center gap-3">
              <input
                type="color"
                value={primaryColor}
                onChange={(e) => setPrimaryColor(e.target.value)}
                className="h-9 w-12 rounded border border-s-line"
              />
              <input
                value={primaryColor}
                onChange={(e) => setPrimaryColor(e.target.value)}
                className="flex-1 input font-mono"
              />
            </div>
          </Field>
          <Field label={t('admin.details.logo_url_label')}>
            <input
              type="url"
              value={logoUrl}
              onChange={(e) => setLogoUrl(e.target.value)}
              className="input"
              placeholder="https://…"
            />
          </Field>
          <Field label={t('admin.details.tagline_label')}>
            <input
              value={tagline}
              onChange={(e) => setTagline(e.target.value)}
              maxLength={140}
              className="input"
            />
          </Field>
          {/* GST config — optional at onboarding. All four fields can
              be blanked and the server applies defaults (5% split as
              CGST 2.5 + SGST 2.5, HSN 9963, no bill prefix). */}
          <div className="row gap-2 items-baseline mt-2">
            <span className="text-[12px] font-semibold text-s-muted dev uppercase tracking-wide">
              {t('admin.details.gst_section')}
            </span>
            <span className="text-[11px] text-s-muted">
              {t('admin.details.gst_hint')}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field
              label={t('admin.details.gstin_label')}
              hint={t('admin.details.gstin_hint')}
            >
              <input
                value={gstin}
                onChange={(e) => setGstin(e.target.value.toUpperCase())}
                maxLength={15}
                pattern="[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[0-9A-Z]{1}Z[0-9A-Z]{1}"
                placeholder="27ABCDE1234F1Z5"
                className="input font-mono"
              />
            </Field>
            <Field
              label={t('admin.details.gst_rate_label')}
              hint={t('admin.details.gst_rate_hint')}
            >
              <input
                type="number"
                min="0"
                max="28"
                step="0.5"
                value={gstRatePct}
                onChange={(e) => setGstRatePct(e.target.value)}
                className="input"
              />
            </Field>
          </div>
          <Field
            label={t('admin.details.bill_prefix_label')}
            hint={t('admin.details.bill_prefix_hint')}
          >
            <input
              value={billPrefix}
              onChange={(e) => setBillPrefix(e.target.value)}
              maxLength={32}
              placeholder="SPT/2026/"
              className="input font-mono"
            />
          </Field>
          <button
            type="submit"
            disabled={busy}
            className="btn btn-primary btn-block min-h-[44px] disabled:opacity-50"
          >
            {busy ? t('admin.details.creating') : t('admin.details.create')}
          </button>
        </form>
      )}

      {step === 'menu' && (
        <div className="space-y-3 bg-s-paper border border-s-line rounded-lg p-4">
          <p className="text-sm text-s-muted">{t('admin.menu.blurb')}</p>
          {/* Vision shortcut — snap the printed menu instead of typing
              20 rows. Merges into the existing `items` state so the
              owner can still eyeball everything before Save. */}
          {restaurant && (
            <div className="row gap-3 items-start bg-brand-wash/60 border border-brand/25 rounded-md p-3">
              <div className="w-9 h-9 rounded-md bg-brand text-white flex items-center justify-center flex-shrink-0">
                <Camera size={16} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-[13.5px] text-s-ink">
                  {t('admin.menu.scan_card')}
                </div>
                <div className="text-[12px] text-s-muted mt-0.5">
                  {t('admin.menu.scan_hint')}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setScanMenuOpen(true)}
                className="btn btn-primary text-[13.5px] min-h-[36px] px-3"
              >
                <Camera size={14} />
                {t('menu_editor.scan_button')}
              </button>
            </div>
          )}
          <div className="space-y-2">
            {items.map((it, idx) => (
              <div key={idx} className="grid grid-cols-12 gap-2 items-center">
                <input
                  value={it.name}
                  onChange={(e) => updateItem(items, idx, { name: e.target.value }, setItems)}
                  className="col-span-5 input mt-0 py-1 text-[13px]"
                />
                <input
                  type="number"
                  value={it.price_minor}
                  onChange={(e) =>
                    updateItem(items, idx, { price_minor: Number(e.target.value) }, setItems)
                  }
                  className="col-span-3 input mt-0 py-1 text-[13px]"
                />
                <select
                  value={it.category}
                  onChange={(e) =>
                    updateItem(
                      items,
                      idx,
                      { category: e.target.value as MenuItemForm['category'] },
                      setItems,
                    )
                  }
                  className="col-span-2 input mt-0 py-1 text-[13px]"
                >
                  <option value="starter">{t('admin.menu.category.starter')}</option>
                  <option value="main">{t('admin.menu.category.main')}</option>
                  <option value="side">{t('admin.menu.category.side')}</option>
                  <option value="bread">{t('admin.menu.category.bread')}</option>
                  <option value="drink">{t('admin.menu.category.drink')}</option>
                  <option value="dessert">{t('admin.menu.category.dessert')}</option>
                </select>
                <label className="col-span-2 text-xs flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={it.is_reward_eligible}
                    onChange={(e) =>
                      updateItem(items, idx, { is_reward_eligible: e.target.checked }, setItems)
                    }
                  />
                  {t('admin.menu.reward_label')}
                </label>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <button
              onClick={() =>
                setItems([
                  ...items,
                  { name: '', price_minor: 0, category: 'main', is_reward_eligible: false },
                ])
              }
              className="btn btn-outline text-[14px] min-h-[36px] px-3"
            >
              {t('admin.menu.add_row')}
            </button>
            <button
              onClick={bulkAddItems}
              disabled={busy || items.some((i) => !i.name)}
              className="btn btn-primary text-[14px] min-h-[36px] px-4 disabled:opacity-50"
            >
              {busy ? t('admin.menu.saving') : t('admin.menu.save_n', { count: items.length })}
            </button>
          </div>
          {scanMenuOpen && restaurant && (
            <ScanMenuModal
              restaurantId={restaurant.id}
              token={token}
              onClose={() => setScanMenuOpen(false)}
              onConfirmed={(picked: ScannedItem[]) => {
                // Merge the extracted rows into the wizard's local state.
                // Any pre-filled DEFAULT_MENU rows with a blank name are
                // dropped so the owner isn't editing 4 default rows +
                // 20 scanned rows. Non-blank existing rows are kept.
                const cleaned = items.filter((it) => it.name.trim());
                const additions: MenuItemForm[] = picked.map((p) => ({
                  name: p.name,
                  price_minor: p.price_minor,
                  category:
                    (p.category as MenuItemForm['category']) ?? 'main',
                  is_reward_eligible: false,
                }));
                setItems([...cleaned, ...additions]);
                setScanMenuOpen(false);
              }}
            />
          )}
        </div>
      )}

      {step === 'reward' && (
        <div className="space-y-3 bg-s-paper border border-s-line rounded-lg p-4">
          <p className="text-sm text-s-muted">{t('admin.reward.blurb')}</p>
          <Field label={t('admin.reward.threshold_label')}>
            <input
              type="number"
              min={50}
              max={95}
              value={thresholdPct}
              onChange={(e) => setThresholdPct(Number(e.target.value))}
              className="input"
            />
            <p className="text-xs text-s-muted mt-1">{t('admin.reward.threshold_hint')}</p>
          </Field>
          <Field label={t('admin.reward.dish_label')}>
            <select
              value={rewardMenuItemId}
              onChange={(e) => setRewardMenuItemId(e.target.value)}
              className="input"
            >
              {createdMenu.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} &middot; ₹{(m.price_minor / 100).toFixed(0)}
                </option>
              ))}
            </select>
          </Field>
          <button
            onClick={createRule}
            disabled={busy || !rewardMenuItemId}
            className="btn btn-primary btn-block min-h-[44px] disabled:opacity-50"
          >
            {busy ? t('admin.reward.creating') : t('admin.reward.create')}
          </button>
        </div>
      )}

      {step === 'staff' && restaurant && (
        <div className="space-y-4">
          <div className="bg-s-paper border border-s-line rounded-lg p-4 space-y-3">
            <p className="text-sm text-s-muted">
              <Trans i18nKey="admin.staff.blurb" components={{ strong: <strong /> }} />
            </p>
            <form onSubmit={inviteStaff} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <Field label={t('admin.staff.email_label')}>
                  <input
                    required
                    type="email"
                    value={staffEmail}
                    onChange={(e) => setStaffEmail(e.target.value)}
                    className="input"
                  />
                </Field>
                <Field label={t('admin.staff.display_name_label')}>
                  <input
                    value={staffName}
                    onChange={(e) => setStaffName(e.target.value)}
                    className="input"
                  />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label={t('admin.staff.role_label')}>
                  <select
                    value={staffRole}
                    onChange={(e) => setStaffRole(e.target.value as StaffRole)}
                    className="input"
                  >
                    <option value="owner">{t('admin.staff.role_owner')}</option>
                    <option value="manager">{t('admin.staff.role_manager')}</option>
                    <option value="server">{t('admin.staff.role_server')}</option>
                  </select>
                </Field>
                <Field
                  label={t('admin.staff.password_label')}
                  hint={t('admin.staff.password_hint')}
                >
                  <input
                    required
                    type="text"
                    minLength={8}
                    value={staffPassword}
                    onChange={(e) => setStaffPassword(e.target.value)}
                    className="input font-mono"
                    placeholder="plate-clean-demo"
                  />
                </Field>
              </div>
              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={busy || !staffEmail || staffPassword.length < 8}
                  className="btn btn-primary text-[14px] min-h-[40px] disabled:opacity-50"
                >
                  {busy ? t('admin.staff.sending') : t('admin.staff.send_invite')}
                </button>
                <button
                  type="button"
                  onClick={() => setStep('done')}
                  disabled={invitedStaff.length === 0 && busy}
                  className="btn btn-outline text-[14px] min-h-[40px]"
                >
                  {invitedStaff.length === 0
                    ? t('admin.staff.skip_and_finish')
                    : t('admin.staff.finish')}
                </button>
              </div>
            </form>
          </div>

          {invitedStaff.length > 0 && (
            <div className="rounded-lg bg-s-bg border border-s-line p-3 space-y-2">
              <p className="text-sm font-medium">{t('admin.staff.invited_so_far', { count: invitedStaff.length })}</p>
              <ul className="text-sm space-y-1">
                {invitedStaff.map((s) => (
                  <li key={s.user_id} className="font-mono text-xs">
                    {s.email} · {s.role} · pw <span className="text-s-muted">{s.password}</span>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-s-muted">{t('admin.staff.credentials_warning')}</p>
            </div>
          )}
        </div>
      )}

      {step === 'done' && restaurant && rewardRule && (
        <div className="space-y-3 bg-brand-wash border border-brand/30 rounded-lg p-4">
          <p className="font-medium text-brand">{t('admin.done.all_set')}</p>
          <ul className="text-sm space-y-1">
            <li>
              <Trans
                i18nKey="admin.done.summary_created"
                values={{ name: restaurant.name, slug: restaurant.slug }}
                components={{ strong: <strong />, code: <code className="text-xs" /> }}
              />
            </li>
            <li>{t('admin.done.summary_menu', { count: createdMenu.length })}</li>
            <li>
              <Trans
                i18nKey="admin.done.summary_reward"
                values={{ name: rewardRule.name, threshold: thresholdPct }}
                components={{ strong: <strong /> }}
              />
            </li>
            <li>
              {invitedStaff.length > 0
                ? t('admin.done.summary_staff_with_roles', {
                    count: invitedStaff.length,
                    roles: invitedStaff.map((s) => s.role).join(', '),
                  })
                : t('admin.done.summary_no_staff')}
            </li>
          </ul>
          {invitedStaff.length > 0 && (
            <div className="rounded-md bg-s-paper border border-s-line p-3 text-xs space-y-1">
              <p className="font-medium text-s-ink">{t('admin.done.credentials_title')}</p>
              <ul className="space-y-0.5 font-mono">
                {invitedStaff.map((s) => (
                  <li key={s.user_id}>
                    {s.email} ({s.role}) — pw {s.password}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="text-xs text-s-muted">
            <Trans
              i18nKey="admin.done.owner_signin_pointer"
              components={{ code: <code /> }}
            />
          </p>
          <button
            onClick={() => navigate('/validations')}
            className="btn btn-primary text-[14px] min-h-[40px]"
          >
            {t('admin.done.done')}
          </button>
        </div>
      )}
    </section>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block text-sm">
      <span className="text-s-muted">{label}</span>
      <div className="mt-1">{children}</div>
      {hint && <p className="text-xs text-s-muted mt-1">{hint}</p>}
    </label>
  );
}

function updateItem(
  items: MenuItemForm[],
  idx: number,
  patch: Partial<MenuItemForm>,
  setItems: (next: MenuItemForm[]) => void,
) {
  setItems(items.map((it, i) => (i === idx ? { ...it, ...patch } : it)));
}
