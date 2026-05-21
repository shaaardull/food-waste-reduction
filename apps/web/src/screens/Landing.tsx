import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '../lib/auth';

export function Landing() {
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);
  return (
    <section className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold text-brand-700">{t('landing.headline')}</h1>
        <p className="text-slate-600">{t('landing.description')}</p>
      </header>
      <div className="flex flex-col gap-3">
        {user ? (
          <Link
            to="/scan"
            className="block text-center bg-brand-600 hover:bg-brand-700 text-white rounded-lg py-3 font-medium"
          >
            {t('landing.scan_qr')}
          </Link>
        ) : (
          <Link
            to="/login"
            className="block text-center bg-brand-600 hover:bg-brand-700 text-white rounded-lg py-3 font-medium"
          >
            {t('landing.sign_in_to_start')}
          </Link>
        )}
      </div>
      <p className="text-xs text-slate-500">{t('landing.tagline_disclaimer')}</p>
    </section>
  );
}
