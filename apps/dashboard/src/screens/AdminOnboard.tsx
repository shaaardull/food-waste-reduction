import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Restaurant } from '@plate-clean/shared-types';
import { api, ApiException } from '../lib/api';
import { useAuthStore } from '../lib/auth';

type Step = 'restaurant' | 'menu' | 'reward' | 'done';

interface MenuItemForm {
  name: string;
  price_minor: number;
  category: 'main' | 'side' | 'drink' | 'dessert';
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
  const navigate = useNavigate();
  const { token, user } = useAuthStore();

  const [step, setStep] = useState<Step>('restaurant');
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

  // Step 2 state
  const [items, setItems] = useState<MenuItemForm[]>(DEFAULT_MENU);

  // Step 3 state
  const [thresholdPct, setThresholdPct] = useState(75);
  const [rewardMenuItemId, setRewardMenuItemId] = useState<string>('');

  // Derived state across steps
  const [restaurant, setRestaurant] = useState<Restaurant | null>(null);
  const [createdMenu, setCreatedMenu] = useState<CreatedMenuItem[]>([]);
  const [rewardRule, setRewardRule] = useState<CreatedRewardRule | null>(null);

  if (!user || user.role !== 'admin') {
    return (
      <section className="max-w-md mx-auto space-y-3">
        <h1 className="text-xl font-semibold">Admin-only</h1>
        <p className="text-sm text-slate-600">Only platform admins can onboard a new restaurant.</p>
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
      setStep('done');
    } catch (err) {
      if (err instanceof ApiException) setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="max-w-xl mx-auto space-y-5">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">Onboard a restaurant</h1>
        <ol className="text-xs text-slate-600 flex gap-2">
          <li className={step === 'restaurant' ? 'text-brand-700 font-medium' : ''}>1. Details</li>
          <li>›</li>
          <li className={step === 'menu' ? 'text-brand-700 font-medium' : ''}>2. Menu</li>
          <li>›</li>
          <li className={step === 'reward' ? 'text-brand-700 font-medium' : ''}>3. Reward rule</li>
          <li>›</li>
          <li className={step === 'done' ? 'text-brand-700 font-medium' : ''}>4. Done</li>
        </ol>
      </header>
      {error && (
        <p className="rounded-md bg-red-50 border border-red-200 text-red-700 text-sm px-3 py-2">
          {error}
        </p>
      )}

      {step === 'restaurant' && (
        <form onSubmit={createRestaurant} className="space-y-3 bg-white border border-slate-200 rounded-lg p-4">
          <Field label="Name">
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-md border border-slate-300 px-3 py-2"
            />
          </Field>
          <Field
            label="Slug"
            hint="lowercase letters, numbers, hyphens. Used in the URL: plate-clean.app/{slug}."
          >
            <input
              required
              pattern="[a-z0-9-]+"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              className="w-full rounded-md border border-slate-300 px-3 py-2 font-mono"
            />
          </Field>
          <Field label="Address">
            <input
              required
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              className="w-full rounded-md border border-slate-300 px-3 py-2"
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Latitude">
              <input
                required
                type="number"
                step="any"
                value={latitude}
                onChange={(e) => setLatitude(e.target.value)}
                className="w-full rounded-md border border-slate-300 px-3 py-2"
              />
            </Field>
            <Field label="Longitude">
              <input
                required
                type="number"
                step="any"
                value={longitude}
                onChange={(e) => setLongitude(e.target.value)}
                className="w-full rounded-md border border-slate-300 px-3 py-2"
              />
            </Field>
          </div>
          <Field label="Theme color">
            <div className="flex items-center gap-3">
              <input
                type="color"
                value={primaryColor}
                onChange={(e) => setPrimaryColor(e.target.value)}
                className="h-9 w-12 rounded border border-slate-300"
              />
              <input
                value={primaryColor}
                onChange={(e) => setPrimaryColor(e.target.value)}
                className="flex-1 rounded-md border border-slate-300 px-3 py-2 font-mono"
              />
            </div>
          </Field>
          <Field label="Logo URL (optional)">
            <input
              type="url"
              value={logoUrl}
              onChange={(e) => setLogoUrl(e.target.value)}
              className="w-full rounded-md border border-slate-300 px-3 py-2"
              placeholder="https://…"
            />
          </Field>
          <Field label="Tagline (optional)">
            <input
              value={tagline}
              onChange={(e) => setTagline(e.target.value)}
              maxLength={140}
              className="w-full rounded-md border border-slate-300 px-3 py-2"
            />
          </Field>
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-md bg-brand-600 hover:bg-brand-700 text-white py-2 disabled:opacity-50"
          >
            {busy ? 'Creating…' : 'Create restaurant'}
          </button>
        </form>
      )}

      {step === 'menu' && (
        <div className="space-y-3 bg-white border border-slate-200 rounded-lg p-4">
          <p className="text-sm text-slate-600">
            We pre-filled a starter menu. Adjust the names, prices (in minor units, e.g. paise), and
            categories, then add the whole list.
          </p>
          <div className="space-y-2">
            {items.map((it, idx) => (
              <div key={idx} className="grid grid-cols-12 gap-2 items-center">
                <input
                  value={it.name}
                  onChange={(e) => updateItem(items, idx, { name: e.target.value }, setItems)}
                  className="col-span-5 rounded-md border border-slate-300 px-2 py-1 text-sm"
                />
                <input
                  type="number"
                  value={it.price_minor}
                  onChange={(e) =>
                    updateItem(items, idx, { price_minor: Number(e.target.value) }, setItems)
                  }
                  className="col-span-3 rounded-md border border-slate-300 px-2 py-1 text-sm"
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
                  className="col-span-2 rounded-md border border-slate-300 px-2 py-1 text-sm"
                >
                  <option value="main">main</option>
                  <option value="side">side</option>
                  <option value="drink">drink</option>
                  <option value="dessert">dessert</option>
                </select>
                <label className="col-span-2 text-xs flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={it.is_reward_eligible}
                    onChange={(e) =>
                      updateItem(items, idx, { is_reward_eligible: e.target.checked }, setItems)
                    }
                  />
                  reward
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
              className="rounded-md border border-slate-300 px-3 py-1 text-sm"
            >
              + add row
            </button>
            <button
              onClick={bulkAddItems}
              disabled={busy || items.some((i) => !i.name)}
              className="rounded-md bg-brand-600 hover:bg-brand-700 text-white px-4 py-1 text-sm disabled:opacity-50"
            >
              {busy ? 'Saving…' : `Save ${items.length} items`}
            </button>
          </div>
        </div>
      )}

      {step === 'reward' && (
        <div className="space-y-3 bg-white border border-slate-200 rounded-lg p-4">
          <p className="text-sm text-slate-600">
            Pick which dish counts as the "free" reward. The bill-discount option uses the same value.
          </p>
          <Field label="Threshold (% consumed to qualify)">
            <input
              type="number"
              min={50}
              max={95}
              value={thresholdPct}
              onChange={(e) => setThresholdPct(Number(e.target.value))}
              className="w-full rounded-md border border-slate-300 px-3 py-2"
            />
            <p className="text-xs text-slate-500 mt-1">Allowed range: 50–95 (CLAUDE.md ethics rule 1).</p>
          </Field>
          <Field label="Reward dish">
            <select
              value={rewardMenuItemId}
              onChange={(e) => setRewardMenuItemId(e.target.value)}
              className="w-full rounded-md border border-slate-300 px-3 py-2"
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
            className="w-full rounded-md bg-brand-600 hover:bg-brand-700 text-white py-2 disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Create reward rule'}
          </button>
        </div>
      )}

      {step === 'done' && restaurant && rewardRule && (
        <div className="space-y-3 bg-brand-50 border border-brand-600/40 rounded-lg p-4">
          <p className="font-medium text-brand-700">All set.</p>
          <ul className="text-sm space-y-1">
            <li>
              <strong>{restaurant.name}</strong> created at slug{' '}
              <code className="text-xs">{restaurant.slug}</code>.
            </li>
            <li>
              {createdMenu.length} menu items added.
            </li>
            <li>
              Reward rule: <strong>{rewardRule.name}</strong> at {thresholdPct}% consumption.
            </li>
          </ul>
          <p className="text-xs text-slate-600">
            Next: invite a server / owner via{' '}
            <code className="text-xs">POST /restaurants/{restaurant.id}/staff</code> (a staff-invite UI
            is a fast-follow). For now, point owners at <code>/login</code> with their credentials.
          </p>
          <button
            onClick={() => navigate('/validations')}
            className="rounded-md bg-brand-600 hover:bg-brand-700 text-white px-4 py-2 text-sm"
          >
            Done
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
      <span className="text-slate-600">{label}</span>
      <div className="mt-1">{children}</div>
      {hint && <p className="text-xs text-slate-500 mt-1">{hint}</p>}
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
