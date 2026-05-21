import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, ApiException } from '../lib/api';
import { useAuthStore } from '../lib/auth';
import { LANGUAGE_LABELS, SUPPORTED_LANGUAGES, type Language } from '../lib/i18n';

export function Profile() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { user, token, clearAuth } = useAuthStore();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function signOut() {
    try {
      await api.post('/auth/logout', undefined, token);
    } catch {
      /* ignore */
    }
    clearAuth();
    navigate('/');
  }

  async function deleteAccount() {
    if (!confirm(t('profile.delete_confirm'))) return;
    setBusy(true);
    setError(null);
    try {
      await api.del('/auth/me', token);
      clearAuth();
      navigate('/');
    } catch (err) {
      if (err instanceof ApiException) setError(err.message);
      setBusy(false);
    }
  }

  if (!user) return <p className="text-slate-600">{t('profile.sign_in_first')}</p>;

  const currentLang = (i18n.resolvedLanguage ?? 'en') as Language;

  return (
    <section className="space-y-5">
      <h1 className="text-xl font-semibold">{t('profile.title')}</h1>
      <div className="rounded-lg border border-slate-200 p-3 text-sm">
        <p>
          <span className="text-slate-500">{t('profile.email_label')}:</span> {user.email}
        </p>
        <p>
          <span className="text-slate-500">{t('profile.role_label')}:</span> {user.role}
        </p>
      </div>

      <div className="rounded-lg border border-slate-200 p-3 space-y-2">
        <p className="text-sm text-slate-600">{t('profile.language_label')}</p>
        <div className="flex gap-2 flex-wrap">
          {SUPPORTED_LANGUAGES.map((lang) => (
            <button
              key={lang}
              onClick={() => void i18n.changeLanguage(lang)}
              className={`rounded-full px-3 py-1 text-sm border ${
                currentLang === lang
                  ? 'bg-brand-700 text-white border-brand-700'
                  : 'border-slate-300 text-slate-700'
              }`}
            >
              {LANGUAGE_LABELS[lang]}
            </button>
          ))}
        </div>
      </div>

      {error && <p className="text-sm text-red-700">{error}</p>}
      <button onClick={signOut} className="w-full rounded-md border border-slate-300 py-2">
        {t('profile.sign_out')}
      </button>
      <button
        onClick={deleteAccount}
        disabled={busy}
        className="w-full rounded-md border border-red-300 text-red-700 py-2 disabled:opacity-50"
      >
        {t('profile.delete_account')}
      </button>
      <p className="text-xs text-slate-500">{t('profile.delete_blurb')}</p>
    </section>
  );
}
