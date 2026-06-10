import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Trans, useTranslation } from 'react-i18next';
import { Zap, QrCode, Camera, Ticket, Leaf, Sparkles } from 'lucide-react';
import { useAuthStore } from '../lib/auth';
import { api } from '../lib/api';
import { LangToggle } from '../components/LangToggle';

interface PublicStats {
  restaurants_active: number;
  k_anonymous: boolean;
  kg_food_saved: number | null;
  kg_co2e_saved: number | null;
}

/** Format kg → "1,240 kg" or tonnes "0.9 t" for very large values. */
function formatKg(kg: number | null): string {
  if (kg == null) return '—';
  if (kg >= 1000) return `${(kg / 1000).toFixed(1)} t`;
  return `${kg.toLocaleString(undefined, { maximumFractionDigits: 0 })} kg`;
}

/**
 * Landing — front door of the diner PWA. Full-bleed dish hero, single
 * primary CTA (anonymous phone flow), tertiary sign-in link, social
 * proof wired to /public/stats, "how it works" strip, ethics note.
 *
 * Sustainability is the only scoreboard — see CLAUDE.md ethics rule 3.
 * No body-image vocabulary; copy-lint enforces this.
 */
export function Landing() {
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);

  const { data: stats } = useQuery({
    queryKey: ['public-stats-landing'],
    queryFn: () => api.get<PublicStats>('/public/stats?range=all'),
    staleTime: 5 * 60_000,
  });

  return (
    <div className="d-screen pb-7">
      {/* full-bleed hero */}
      <div className="relative h-[430px] overflow-hidden">
        <div
          className="dish absolute inset-0 rounded-none"
          data-label=""
          style={{
            background:
              'radial-gradient(120% 80% at 26% 22%, hsl(34 64% 80%), transparent 58%),' +
              'radial-gradient(90% 80% at 82% 88%, hsl(8 56% 70%), transparent 52%),' +
              'radial-gradient(70% 60% at 64% 46%, hsl(150 30% 62%), transparent 66%),' +
              'hsl(30 38% 78%)',
          }}
        />
        <div
          className="absolute inset-0"
          style={{
            background:
              'linear-gradient(180deg, rgba(20,30,28,.30) 0%, transparent 26%,' +
              ' rgba(20,30,28,.04) 50%, hsl(40 36% 97%) 99%)',
          }}
        />
        <div className="spread absolute top-4 left-4 right-4">
          <div className="row gap-2 text-white">
            <div className="w-[30px] h-[30px] rounded-[9px] bg-white/90 flex items-center justify-center">
              <Leaf size={18} className="text-brand" />
            </div>
            <span
              className="font-bold text-[15px]"
              style={{ textShadow: '0 1px 8px rgba(0,0,0,.3)' }}
            >
              Plate-Clean
            </span>
          </div>
          <LangToggle dark />
        </div>
        <div className="absolute left-[22px] right-[22px] bottom-[26px]">
          <span className="chip bg-white/90 text-brand mb-3">
            <Sparkles size={14} /> {t('landing.badge')}
          </span>
          <h1 className="display text-[46px] text-ink m-0">
            <Trans
              i18nKey="landing.headline"
              components={{ br: <br /> }}
              defaults="Finish your plate.<br/>Unlock a reward."
            />
          </h1>
        </div>
      </div>

      {/* CTAs */}
      <div className="px-[22px] pt-1 pb-2">
        <p className="text-muted text-[15.5px] leading-[1.5] mt-2 mb-[18px]">
          {t('landing.description')}
        </p>
        {user ? (
          <Link to="/scan" className="btn btn-primary btn-lg btn-block">
            <Zap size={19} />
            {t('landing.scan_qr')}
          </Link>
        ) : (
          <>
            <Link to="/quick-start" className="btn btn-primary btn-lg btn-block">
              <Zap size={19} />
              {t('landing.quick_start')}
            </Link>
            <div className="text-center mt-3">
              <Link to="/login" className="btn-tertiary">
                <Trans
                  i18nKey="landing.have_account"
                  components={{ b: <span className="text-brand" /> }}
                  defaults="Have an account? <b>Sign in</b>"
                />
              </Link>
            </div>
          </>
        )}
      </div>

      {/* social proof — wired to /public/stats */}
      <div className="grid grid-cols-3 gap-2.5 px-[18px] py-3.5">
        {[
          [formatKg(stats?.kg_food_saved ?? null), t('landing.proof_kg')],
          [formatKg(stats?.kg_co2e_saved ?? null), t('landing.proof_co2')],
          [
            stats?.restaurants_active != null
              ? String(stats.restaurants_active)
              : '—',
            t('landing.proof_restaurants'),
          ],
        ].map(([a, b]) => (
          <div
            key={b}
            className="card-flat py-3.5 px-2.5 text-center"
          >
            <div className="tnum font-bold text-[22px] text-sage">{a}</div>
            <div className="text-[12px] text-muted mt-0.5">{b}</div>
          </div>
        ))}
      </div>

      {/* how it works — 30s strip */}
      <div className="px-[22px] pt-3.5 pb-1.5">
        <div className="eyebrow mb-3.5">{t('landing.how_title')}</div>
        {(
          [
            ['qr', QrCode, t('landing.how_scan_t'), t('landing.how_scan_d')],
            ['camera', Camera, t('landing.how_snap_t'), t('landing.how_snap_d')],
            ['ticket', Ticket, t('landing.how_approve_t'), t('landing.how_approve_d')],
          ] as const
        ).map(([key, Icon, title, desc], i) => (
          <div
            key={key}
            className={`row gap-3.5 py-2.5 ${i < 2 ? 'border-b border-line' : ''}`}
          >
            <div className="w-11 h-11 rounded-[13px] bg-brand-wash text-brand flex items-center justify-center flex-shrink-0">
              <Icon size={21} />
            </div>
            <div>
              <div className="font-semibold text-[15px]">{title}</div>
              <div className="text-[13px] text-muted">{desc}</div>
            </div>
          </div>
        ))}
      </div>

      {/* footer */}
      <div className="px-[22px] pt-[18px] pb-1 text-center">
        <Link to="/stats" className="btn-ghost inline-flex items-center gap-2">
          <Leaf size={17} /> {t('landing.see_impact')}
        </Link>
        <p className="text-[11.5px] text-faint leading-[1.5] mt-2.5">
          {t('landing.ethics_note')}
        </p>
      </div>
    </div>
  );
}
