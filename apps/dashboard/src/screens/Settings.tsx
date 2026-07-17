import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Settings as SettingsIcon, Check, Receipt, Gift } from 'lucide-react';
import { clsx } from 'clsx';
import type { Restaurant } from '@plate-clean/shared-types';
import { api, ApiException } from '../lib/api';
import { useAuthStore } from '../lib/auth';

/**
 * Settings — restaurant-level configuration surface.
 *
 * Only the "billing / GST" section for now. Rate + prefix + HSN already
 * live on the AdminOnboard wizard; this screen lets an existing owner
 * change them without going through the wizard again.
 *
 * The `gst_enabled` toggle is the headline addition — restaurants
 * under the ₹20L threshold, or on composition schemes, flip this off
 * so newly-issued bills skip the CGST/SGST split. Past bills are
 * immutable and keep the rate that was snapshotted at issue time.
 *
 * Access: owner or admin. The API enforces this via
 * `_require_owner_or_admin`; we surface a friendly banner if it fails
 * rather than silently 403-ing.
 */

interface GstForm {
  gst_enabled: boolean;
  gst_rate_pct: string;
  gstin: string;
  hsn_code: string;
  bill_prefix: string;
}

function toForm(r: Restaurant): GstForm {
  const rate = typeof r.gst_rate === 'string' ? parseFloat(r.gst_rate) : (r.gst_rate ?? 0.05);
  return {
    gst_enabled: r.gst_enabled ?? true,
    gst_rate_pct: (rate * 100).toFixed(2),
    gstin: r.gstin ?? '',
    hsn_code: r.hsn_code ?? '9963',
    bill_prefix: r.bill_prefix ?? '',
  };
}

export function Settings() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { token, restaurantId, activeRestaurant, setActiveRestaurant } = useAuthStore();
  const qc = useQueryClient();

  useEffect(() => {
    if (!token) navigate('/login');
  }, [token, navigate]);

  // Re-fetch by slug on mount — the cached activeRestaurant in
  // localStorage may pre-date the gst_enabled column being added, so
  // we lean on the server to be the source of truth. Slug is the only
  // read endpoint we have for a single restaurant right now.
  const { data: restaurant, isLoading, error } = useQuery<Restaurant>({
    queryKey: ['restaurant-detail', restaurantId, activeRestaurant?.slug],
    queryFn: () =>
      api.get<Restaurant>(`/restaurants/${activeRestaurant!.slug}`, token),
    enabled: Boolean(restaurantId && token && activeRestaurant?.slug),
    initialData: activeRestaurant ?? undefined,
  });

  const initial = useMemo(
    () => (restaurant ? toForm(restaurant) : null),
    [restaurant],
  );
  const [form, setForm] = useState<GstForm | null>(initial);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    // The very first render before the query resolves has form=null.
    // Once the restaurant lands, hydrate the local edit state.
    if (initial && form === null) setForm(initial);
  }, [initial, form]);

  const save = useMutation({
    mutationFn: async (next: GstForm) => {
      const rate = parseFloat(next.gst_rate_pct);
      if (Number.isNaN(rate) || rate < 0 || rate > 28) {
        throw new ApiException(400, 'INVALID_RATE', t('settings.err_rate_range'));
      }
      const payload: Record<string, unknown> = {
        gst_enabled: next.gst_enabled,
        gst_rate: (rate / 100).toFixed(3),
        hsn_code: next.hsn_code.trim() || null,
        bill_prefix: next.bill_prefix.trim() || null,
      };
      if (next.gstin.trim()) payload.gstin = next.gstin.trim().toUpperCase();
      const updated = await api.patch<Restaurant>(
        `/restaurants/${restaurantId}`,
        payload,
        token,
      );
      return updated;
    },
    onSuccess: (updated) => {
      setActiveRestaurant(updated);
      void qc.invalidateQueries({ queryKey: ['restaurant-detail', restaurantId] });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    },
    onError: (err: ApiException) => {
      const msg =
        (err.details as { message?: string } | undefined)?.message ??
        err.message ??
        t('settings.err_generic');
      setSaveError(msg);
    },
  });

  if (!restaurantId) {
    return (
      <p className="text-s-muted text-sm">{t('summary.pick_restaurant')}</p>
    );
  }
  if (isLoading || !form) {
    return <p className="text-s-muted text-sm">{t('settings.loading')}</p>;
  }
  if (error) {
    return (
      <p className="text-sm text-danger bg-danger-wash border border-danger/20 rounded-md px-3 py-2">
        {(error as Error).message}
      </p>
    );
  }

  return (
    <section className="flex flex-col gap-5 max-w-[720px]">
      <header>
        <div className="text-[12px] font-semibold text-s-muted dev uppercase tracking-wide row gap-1.5 items-center">
          <SettingsIcon size={12} />
          {t('app.nav.settings')}
        </div>
        <h1 className="display text-[28px] text-s-ink leading-tight">
          {t('settings.title')}
        </h1>
        <p className="text-[13px] text-s-muted mt-1 max-w-[54ch]">
          {t('settings.blurb')}
        </p>
      </header>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          setSaveError(null);
          save.mutate(form);
        }}
        className="flex flex-col gap-5 rounded-lg border border-s-line bg-s-paper p-5"
      >
        <div className="row gap-2 items-center pb-3 border-b border-s-line/60">
          <Receipt size={16} className="text-brand" />
          <h2 className="display text-[18px] text-s-ink">
            {t('settings.billing_section')}
          </h2>
        </div>

        {/* GST enable toggle */}
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={form.gst_enabled}
            onChange={(e) => setForm({ ...form, gst_enabled: e.target.checked })}
            className="mt-1 w-4 h-4 accent-brand"
          />
          <div className="flex-1">
            <div className="font-semibold text-[14px] text-s-ink">
              {t('settings.gst_enabled_label')}
            </div>
            <p className="text-[12.5px] text-s-muted leading-snug mt-0.5">
              {t('settings.gst_enabled_hint')}
            </p>
          </div>
        </label>

        {/* GST rate — dim when disabled but still editable so a future
            re-enable finds the previously-saved value. */}
        <label className={clsx('flex flex-col gap-1.5', !form.gst_enabled && 'opacity-55')}>
          <span className="text-[12.5px] font-semibold text-s-ink">
            {t('settings.gst_rate_label')}
          </span>
          <input
            type="number"
            step="0.01"
            min="0"
            max="28"
            value={form.gst_rate_pct}
            onChange={(e) => setForm({ ...form, gst_rate_pct: e.target.value })}
            className="input mt-0 max-w-[180px]"
          />
          <span className="text-[11.5px] text-s-muted">
            {t('settings.gst_rate_hint')}
          </span>
        </label>

        {/* GSTIN */}
        <label className="flex flex-col gap-1.5">
          <span className="text-[12.5px] font-semibold text-s-ink">
            {t('settings.gstin_label')}
          </span>
          <input
            type="text"
            maxLength={15}
            value={form.gstin}
            onChange={(e) => setForm({ ...form, gstin: e.target.value.toUpperCase() })}
            placeholder="27ABCDE1234F1Z5"
            className="input mt-0 font-mono tracking-wide"
          />
          <span className="text-[11.5px] text-s-muted">
            {t('settings.gstin_hint')}
          </span>
        </label>

        {/* Bill prefix */}
        <label className="flex flex-col gap-1.5">
          <span className="text-[12.5px] font-semibold text-s-ink">
            {t('settings.bill_prefix_label')}
          </span>
          <input
            type="text"
            maxLength={32}
            value={form.bill_prefix}
            onChange={(e) => setForm({ ...form, bill_prefix: e.target.value })}
            placeholder="SPT/"
            className="input mt-0 max-w-[240px]"
          />
          <span className="text-[11.5px] text-s-muted">
            {t('settings.bill_prefix_hint')}
          </span>
        </label>

        {/* HSN */}
        <label className="flex flex-col gap-1.5">
          <span className="text-[12.5px] font-semibold text-s-ink">
            {t('settings.hsn_label')}
          </span>
          <input
            type="text"
            maxLength={8}
            value={form.hsn_code}
            onChange={(e) => setForm({ ...form, hsn_code: e.target.value })}
            className="input mt-0 max-w-[180px]"
          />
          <span className="text-[11.5px] text-s-muted">
            {t('settings.hsn_hint')}
          </span>
        </label>

        {saveError && (
          <p className="text-sm text-danger bg-danger-wash border border-danger/20 rounded-md px-3 py-2">
            {saveError}
          </p>
        )}

        <div className="row gap-2 pt-2 border-t border-s-line/60">
          <button
            type="submit"
            disabled={save.isPending}
            className="btn btn-primary min-h-[42px] text-[14px] px-6 disabled:opacity-55"
          >
            {save.isPending ? t('settings.saving') : t('settings.save')}
          </button>
          {saved && (
            <span className="row gap-1.5 items-center text-[13px] text-sage font-semibold">
              <Check size={14} />
              {t('settings.saved')}
            </span>
          )}
        </div>
      </form>

      <RewardRulesSection />
    </section>
  );
}

interface RewardRuleRow {
  id: string;
  restaurant_id: string;
  name: string;
  consumption_threshold: string | number;
  reward_menu_item_id: string;
  daily_redemption_cap_per_user: number;
  is_active: boolean;
  allowed_reward_types: string[];
  bill_discount_minor: number | null;
  reward_value_minor: number | null;
}

interface MenuItemRow {
  id: string;
  name: string;
  price_minor: number;
}

/**
 * RewardRulesSection — lets the restaurant override the rupee value
 * for each of its reward rules. Blank input clears the override
 * (falls back to the linked menu item's price); a positive integer
 * sets it. Existing reward codes are unaffected — the value is
 * snapshotted at issuance time.
 */
function RewardRulesSection() {
  const { t } = useTranslation();
  const { token, restaurantId } = useAuthStore();
  const qc = useQueryClient();

  const { data: rules, isLoading: rulesLoading } = useQuery<RewardRuleRow[]>({
    queryKey: ['reward-rules', restaurantId],
    queryFn: () =>
      api.get<RewardRuleRow[]>(
        `/restaurants/${restaurantId}/reward-rules`,
        token,
      ),
    enabled: Boolean(restaurantId && token),
  });

  // The menu is the source of truth for the fallback price rendered in
  // the helper text. GET /restaurants/:id/menu is public — fine to
  // fetch without a token, but we pass it anyway for consistency.
  const { data: menu } = useQuery<MenuItemRow[]>({
    queryKey: ['restaurant-menu', restaurantId],
    queryFn: () =>
      api.get<MenuItemRow[]>(`/restaurants/${restaurantId}/menu`, token),
    enabled: Boolean(restaurantId),
  });

  if (rulesLoading) {
    return (
      <div className="rounded-lg border border-s-line bg-s-paper p-5 text-sm text-s-muted">
        {t('reward_rules_settings.loading')}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-s-line bg-s-paper p-5 flex flex-col gap-4">
      <div className="row gap-2 items-center pb-3 border-b border-s-line/60">
        <Gift size={16} className="text-brand" />
        <h2 className="display text-[18px] text-s-ink">
          {t('reward_rules_settings.section_heading')}
        </h2>
      </div>

      {(!rules || rules.length === 0) && (
        <p className="text-sm text-s-muted">
          {t('reward_rules_settings.no_rules')}
        </p>
      )}

      {rules?.map((rule) => (
        <RewardRuleRowForm
          key={rule.id}
          rule={rule}
          menuItem={menu?.find((m) => m.id === rule.reward_menu_item_id)}
          onSaved={() =>
            qc.invalidateQueries({ queryKey: ['reward-rules', restaurantId] })
          }
        />
      ))}
    </div>
  );
}

function RewardRuleRowForm({
  rule,
  menuItem,
  onSaved,
}: {
  rule: RewardRuleRow;
  menuItem: MenuItemRow | undefined;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const { token, restaurantId } = useAuthStore();
  // Rupee-denominated input string. Empty string means "clear the
  // override"; a numeric string is multiplied by 100 to get paise
  // before send.
  const initialValue =
    rule.reward_value_minor != null ? String(rule.reward_value_minor / 100) : '';
  const [input, setInput] = useState<string>(initialValue);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const save = useMutation({
    mutationFn: async () => {
      const trimmed = input.trim();
      let reward_value_minor: number | null;
      if (trimmed === '') {
        reward_value_minor = null;
      } else {
        const rupees = Number(trimmed);
        if (!Number.isFinite(rupees) || rupees <= 0) {
          throw new ApiException(400, 'INVALID_VALUE', 'Enter a positive rupee value.');
        }
        reward_value_minor = Math.round(rupees * 100);
      }
      return await api.patch<RewardRuleRow>(
        `/restaurants/${restaurantId}/reward-rules/${rule.id}`,
        { reward_value_minor },
        token,
      );
    },
    onSuccess: () => {
      onSaved();
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    },
    onError: (err: ApiException) => {
      const msg =
        (err.details as { message?: string } | undefined)?.message ??
        err.message ??
        'Save failed';
      setSaveError(msg);
    },
  });

  const helper =
    menuItem != null
      ? t('reward_rules_settings.value_helper_menu', {
          price: (menuItem.price_minor / 100).toFixed(2),
          name: menuItem.name,
        })
      : t('reward_rules_settings.value_helper_none');

  return (
    <div className="flex flex-col gap-2">
      <div className="text-[13px] font-semibold text-s-ink">
        {t('reward_rules_settings.rule_row_label', {
          name: rule.name,
          menu_name: menuItem?.name ?? '—',
        })}
      </div>
      <label className="flex flex-col gap-1.5">
        <span className="text-[12.5px] font-semibold text-s-ink">
          {t('reward_rules_settings.value_label')}
        </span>
        <div className="row gap-2 items-center">
          <span className="text-sm text-s-muted">₹</span>
          <input
            type="number"
            min="1"
            step="1"
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setSaveError(null);
            }}
            placeholder={t('reward_rules_settings.value_placeholder')}
            className="input mt-0 max-w-[180px]"
          />
        </div>
        <span className="text-[11.5px] text-s-muted leading-snug">{helper}</span>
      </label>
      {saveError && (
        <p className="text-xs text-danger bg-danger-wash border border-danger/20 rounded-md px-2 py-1.5">
          {saveError}
        </p>
      )}
      <div className="row gap-2 items-center">
        <button
          type="button"
          onClick={() => {
            setSaveError(null);
            save.mutate();
          }}
          disabled={save.isPending}
          className="btn btn-outline min-h-[38px] text-[13px] px-4 disabled:opacity-55"
        >
          {save.isPending
            ? t('reward_rules_settings.saving')
            : t('reward_rules_settings.save')}
        </button>
        {saved && (
          <span className="row gap-1.5 items-center text-[13px] text-sage font-semibold">
            <Check size={14} />
            {t('reward_rules_settings.saved')}
          </span>
        )}
      </div>
    </div>
  );
}
