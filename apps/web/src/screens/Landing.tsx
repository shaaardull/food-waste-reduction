import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Zap, QrCode, Camera, Sprout, Leaf } from 'lucide-react';
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
 * Landing — front door of the diner PWA (v2 "Sprout").
 *
 * The v1 full-bleed photo + dark scrim is replaced with a green-gradient
 * header band (sage-wash + brand-wash → cream). Drifting blobs sit
 * behind a blob-masked dish tile with a "0.4kg saved" sticker pinned
 * to it. Headline is two lines — bold Hanken for the action, Fraunces
 * italic brand-green for the payoff.
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

  const foodSaved = formatKg(stats?.kg_food_saved ?? null);
  const co2Saved = formatKg(stats?.kg_co2e_saved ?? null);
  const restaurantsCount =
    stats?.restaurants_active != null ? String(stats.restaurants_active) : '—';

  return (
    <div className="d-screen pb-8">
      {/* ── HERO ── green-gradient band with drifting blobs + blob-masked
          dish tile + saffron "kg saved" sticker */}
      <div
        className="relative overflow-hidden"
        style={{
          background:
            'radial-gradient(120% 90% at 30% 12%, hsl(145 50% 90%), transparent 62%),' +
            'radial-gradient(100% 80% at 85% 22%, hsl(153 40% 92%), transparent 60%),' +
            'linear-gradient(180deg, hsl(145 50% 94%) 0%, hsl(140 24% 97%) 96%)',
        }}
      >
        {/* drifting blob field */}
        <div
          className="blob blob-anim"
          style={{ left: '-40px', top: '20px', width: '190px', height: '160px' }}
        />
        <div
          className="blob blob-2 blob-anim"
          style={{
            right: '-50px',
            top: '90px',
            width: '220px',
            height: '180px',
            animationDelay: '-4s',
          }}
        />

        {/* top strip: brand + lang */}
        <div className="spread px-5 pt-4 relative z-10">
          <div className="row gap-2 text-ink">
            <div className="w-8 h-8 rounded-md bg-white/85 flex items-center justify-center">
              <Leaf size={16} className="text-brand" />
            </div>
            <span className="font-bold text-[15px]">Plate-Clean</span>
          </div>
          <LangToggle />
        </div>

        {/* dish tile — the "photo" is a warm gradient rendered inside a
            lopsided border-radius (matches the .blob curl). "kg saved"
            sticker is pinned to the top-right, tilted, saffron-toned. */}
        <div className="relative z-10 flex justify-center pt-5 pb-1">
          <div className="relative">
            <div
              className="w-[196px] h-[196px]"
              style={{
                borderRadius: '62% 38% 55% 45% / 48% 52% 40% 60%',
                background:
                  'radial-gradient(120% 80% at 26% 22%, hsl(34 64% 82%), transparent 58%),' +
                  'radial-gradient(90% 80% at 82% 88%, hsl(8 56% 74%), transparent 52%),' +
                  'radial-gradient(70% 60% at 64% 46%, hsl(150 30% 66%), transparent 66%),' +
                  'hsl(30 38% 80%)',
                boxShadow: '0 24px 44px -18px rgba(20,60,42,.34)',
              }}
            />
            {stats?.kg_food_saved != null && stats.kg_food_saved > 0 && (
              <div
                className="sticker sticker-saffron sticker-tilt absolute"
                style={{ right: '-16px', top: '-6px' }}
              >
                <Leaf size={12} />
                {t('landing.sticker_saved', { value: foodSaved })}
              </div>
            )}
          </div>
        </div>

        {/* headline + eyebrow sticker */}
        <div className="relative z-10 px-6 pt-4 pb-6 text-center">
          <div className="mb-4 flex justify-center">
            <span className="sticker sticker-sage sticker-tilt">
              <Sprout size={12} />
              {t('landing.sticker_headline')}
            </span>
          </div>
          <h1 className="m-0 leading-[0.98]">
            <span className="block font-extrabold text-ink text-[38px] tracking-[-0.02em]">
              {t('landing.headline_line1')}
            </span>
            <span
              className="display block text-brand"
              style={{ fontSize: '46px', lineHeight: 1.02 }}
            >
              {t('landing.headline_line2')}
            </span>
          </h1>
        </div>
      </div>

      {/* ── CTAs + description ── */}
      <div className="px-6 pt-5 pb-2">
        <p className="text-muted text-[15.5px] leading-[1.5] mb-4">
          {t('landing.description')}
        </p>
        {user ? (
          <Link to="/scan" className="btn btn-primary btn-lg btn-block">
            <Zap size={19} />
            {t('landing.scan_qr')}
          </Link>
        ) : (
          <>
            <Link to="/onboard-choice" className="btn btn-primary btn-lg btn-block">
              <Zap size={19} />
              {t('landing.quick_start')}
            </Link>
            <div className="text-center mt-3">
              <Link to="/login" className="btn-tertiary">
                {t('landing.have_account')
                  .replace(/<\/?b>/g, '')
                  .replace('Sign in', '')}
                <span className="text-brand font-semibold">Sign in</span>
              </Link>
            </div>
          </>
        )}
      </div>

      {/* ── Impact tiles ── replaces the old flat stat cards. boop in
          on mount; sage / lime / saffron accents matched to what's
          being counted. */}
      <div className="grid grid-cols-3 gap-2.5 px-5 py-4">
        <div className="impact boop" style={{ animationDelay: '0.05s' }}>
          <div className="big tnum">{foodSaved}</div>
          <div className="cap">{t('landing.proof_kg')}</div>
        </div>
        <div className="impact lime boop" style={{ animationDelay: '0.15s' }}>
          <div className="big tnum">{co2Saved}</div>
          <div className="cap">{t('landing.proof_co2')}</div>
        </div>
        <div
          className="impact saffron boop"
          style={{ animationDelay: '0.25s' }}
        >
          <div className="big tnum">{restaurantsCount}</div>
          <div className="cap">{t('landing.proof_restaurants')}</div>
        </div>
      </div>

      {/* ── How it works ── dashed dividers + alternating tinted icon
          tiles with a small rotation. Step 3 is "Reward grows" instead
          of "Staff approves" — same domain outcome, warmer framing. */}
      <div className="px-6 pt-4 pb-2">
        <div className="row gap-2 mb-4">
          <div className="eyebrow">{t('landing.how_title')}</div>
          <span className="sticker sticker-sage" style={{ padding: '3px 8px', fontSize: '11.5px' }}>
            {t('landing.sticker_how_time')}
          </span>
        </div>
        {(
          [
            [
              'qr',
              QrCode,
              t('landing.how_scan_t'),
              t('landing.how_scan_d'),
              'bg-brand-wash text-brand',
              '-3deg',
            ],
            [
              'camera',
              Camera,
              t('landing.how_snap_t'),
              t('landing.how_snap_d'),
              'bg-saffron-wash text-saffron-deep',
              '3deg',
            ],
            [
              'sprout',
              Sprout,
              t('landing.how_approve_t'),
              t('landing.how_approve_d'),
              'bg-sage-wash text-sage',
              '-2deg',
            ],
          ] as const
        ).map(([key, Icon, title, desc, tone, rot], i) => (
          <div key={key}>
            <div className="row gap-3.5 py-3">
              <div
                className={`w-12 h-12 rounded-md flex items-center justify-center flex-shrink-0 ${tone}`}
                style={{ transform: `rotate(${rot})` }}
              >
                <Icon size={22} />
              </div>
              <div>
                <div className="font-bold text-[15px]">{title}</div>
                <div className="text-[13px] text-muted">{desc}</div>
              </div>
            </div>
            {i < 2 && <div className="leafline my-1" />}
          </div>
        ))}
      </div>

      {/* ── Footer ── impact link + ethics note ── */}
      <div className="px-6 pt-5 pb-1 text-center">
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
