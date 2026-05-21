import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, ApiException } from '../lib/api';
import { useAuthStore } from '../lib/auth';
import type { MenuItem, PortionSize } from '@plate-clean/shared-types';

interface SessionDetail {
  session: { id: string; restaurant_id: string; status: string };
}

interface Line {
  menu_item_id: string;
  quantity: number;
  portion_size: PortionSize;
}

export function Order() {
  const { t } = useTranslation();
  const { id: sessionId = '' } = useParams();
  const navigate = useNavigate();
  const token = useAuthStore((s) => s.token);
  const [menu, setMenu] = useState<MenuItem[]>([]);
  const [lines, setLines] = useState<Record<string, Line>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const detail = await api.get<SessionDetail>(`/sessions/${sessionId}`, token);
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

  function toggle(item: MenuItem) {
    setLines((prev) => {
      if (prev[item.id]) {
        const next = { ...prev };
        delete next[item.id];
        return next;
      }
      // Ethics rule 2: default portion is "small".
      return {
        ...prev,
        [item.id]: { menu_item_id: item.id, quantity: 1, portion_size: 'small' },
      };
    });
  }

  function setPortion(itemId: string, size: PortionSize) {
    setLines((prev) =>
      prev[itemId] ? { ...prev, [itemId]: { ...prev[itemId], portion_size: size } } : prev,
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
      navigate(`/sessions/${sessionId}/before`);
    } catch (err) {
      if (err instanceof ApiException) setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-4">
      <h1 className="text-xl font-semibold">{t('order.title')}</h1>
      <p className="text-sm text-slate-600">{t('order.blurb')}</p>
      <ul className="space-y-2">
        {menu.map((item) => {
          const line = lines[item.id];
          return (
            <li
              key={item.id}
              className={`rounded-lg border px-3 py-2 ${
                line ? 'border-brand-600 bg-brand-50' : 'border-slate-200'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <button onClick={() => toggle(item)} className="text-left flex-1">
                  <div className="font-medium">{item.name}</div>
                  <div className="text-xs text-slate-500">
                    {(item.price_minor / 100).toFixed(2)} {item.category ? `· ${item.category}` : ''}
                  </div>
                </button>
              </div>
              {line && (
                <div className="mt-2 flex gap-2 text-xs">
                  {(['small', 'regular', 'large'] as PortionSize[]).map((p) => (
                    <button
                      key={p}
                      onClick={() => setPortion(item.id, p)}
                      className={`rounded-full px-3 py-1 border ${
                        line.portion_size === p
                          ? 'bg-brand-700 text-white border-brand-700'
                          : 'border-slate-300 text-slate-700'
                      }`}
                    >
                      {t(`order.portion.${p}`)}
                    </button>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {error && <p className="text-sm text-red-700">{error}</p>}
      <div className="flex items-center justify-between sticky bottom-2 bg-white border border-slate-200 rounded-lg px-3 py-2">
        <div className="text-sm">
          {t('order.total_label', { amount: total.toFixed(2) })}
        </div>
        <button
          onClick={submit}
          disabled={busy || Object.keys(lines).length === 0}
          className="rounded-md bg-brand-600 hover:bg-brand-700 text-white px-4 py-2 disabled:opacity-50"
        >
          {busy ? t('order.saving') : t('order.send_to_kitchen')}
        </button>
      </div>
    </section>
  );
}
