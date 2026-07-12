import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { QrCode, Camera, Sprout, Leaf, User as UserIcon } from 'lucide-react';
import { useAuthStore } from '../lib/auth';
import { api } from '../lib/api';
import { LangToggle } from '../components/LangToggle';

interface PublicStats {
  // `restaurants_active` used to live here + get rendered on Landing.
  // It's business-sensitive at pilot scale, so we removed it from
  // both the API response and the tile grid.
  k_anonymous: boolean;
  kg_food_saved: number | null;
  kg_co2e_saved: number | null;
  // `rewards_issued` powers the "Plates rewarded" tile — the third
  // hero card. Only surfaced when the k-anonymity gate is open, same
  // rule as the other two.
  rewards_issued: number | null;
}

/** Format kg → "1,240 kg" or tonnes "0.9 t" for very large values. */
function formatKg(kg: number | null): string {
  if (kg == null) return '—';
  if (kg >= 1000) return `${(kg / 1000).toFixed(1)} t`;
  return `${kg.toLocaleString(undefined, { maximumFractionDigits: 0 })} kg`;
}

/** Compact counter: 1,240 → "1.2k", 12,400 → "12k". Under 1000 renders
 *  the number as-is so a pilot restaurant with 87 rewards issued still
 *  sees "87" and not "0.1k". */
function formatCount(n: number | null): string {
  if (n == null) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return n.toLocaleString();
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
  // Anonymous quick-start diners have a `token` but no `user` row —
  // we still want them to reach Profile (to see their rewards and
  // opt out of retention). Key the profile chip off token, not user.
  const token = useAuthStore((s) => s.token);

  const { data: stats } = useQuery({
    queryKey: ['public-stats-landing'],
    queryFn: () => api.get<PublicStats>('/public/stats?range=all'),
    staleTime: 5 * 60_000,
  });

  const foodSaved = formatKg(stats?.kg_food_saved ?? null);
  const co2Saved = formatKg(stats?.kg_co2e_saved ?? null);
  const rewardsIssued = formatCount(stats?.rewards_issued ?? null);

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

        {/* top strip: brand + lang + profile.

            The FRONT_DOOR_ROUTES gate in App.tsx hides the app header
            on `/`, so if we don't surface Profile / Sign in here a
            signed-in returning diner has no way to reach their
            rewards without re-scanning a QR. Chip sits next to the
            language toggle so it feels like part of the same control
            group. */}
        <div className="spread px-5 pt-4 relative z-10">
          <div className="row gap-2 text-ink">
            <div className="w-8 h-8 rounded-md bg-white/85 flex items-center justify-center">
              <Leaf size={16} className="text-brand" />
            </div>
            <span className="font-bold text-[15px]">Plate-Clean</span>
          </div>
          <div className="row gap-2">
            <LangToggle />
            {token ? (
              <Link
                to="/profile"
                aria-label={t('app.nav.profile')}
                className="row gap-1.5 h-8 pl-1 pr-2.5 rounded-full bg-paper border border-line text-ink/80 hover:text-ink font-semibold text-[12.5px] transition"
              >
                <span className="w-6 h-6 rounded-full bg-brand-wash text-brand flex items-center justify-center">
                  {user?.display_name || user?.email ? (
                    <span className="text-[11px] font-bold">
                      {(user.display_name ?? user.email ?? '?')
                        .slice(0, 2)
                        .toUpperCase()}
                    </span>
                  ) : (
                    <UserIcon size={12} />
                  )}
                </span>
                <span className="hidden xs:inline">
                  {t('app.nav.profile')}
                </span>
              </Link>
            ) : (
              <Link
                to="/login"
                className="row gap-1.5 h-8 px-3 rounded-full bg-paper border border-line text-ink/80 hover:text-ink font-semibold text-[12.5px] transition"
              >
                <UserIcon size={13} />
                {t('app.nav.sign_in')}
              </Link>
            )}
          </div>
        </div>

        {/* dish carousel — three plates on stage at once. Middle one
            is scaled up and centred; the flanking plates are smaller,
            faded, and pushed to the sides. Advances one slot every
            3.5s so the whole set cycles through in ~17s. */}
        <div className="relative z-10 flex justify-center pt-5 pb-1">
          <PlateCarousel
            savedSticker={
              stats?.kg_food_saved != null && stats.kg_food_saved > 0
                ? {
                    label: t('landing.sticker_saved', { value: foodSaved }),
                  }
                : null
            }
          />
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
        {/* Primary CTA reads the same way in both auth states — "Scan
            your table QR" is what the diner actually does next. The
            auth-vs-anonymous fork happens on the NEXT screen
            (OnboardChoice) so this button doesn't have to lie about
            "no account needed" when the follow-up asks for phone /
            email. */}
        {user ? (
          <Link to="/scan" className="btn btn-primary btn-lg btn-block">
            <QrCode size={19} />
            {t('landing.scan_qr')}
          </Link>
        ) : (
          <Link to="/onboard-choice" className="btn btn-primary btn-lg btn-block">
            <QrCode size={19} />
            {t('landing.scan_qr')}
          </Link>
        )}
      </div>

      {/* ── Impact tiles ── three-tile grid: food saved + CO₂e avoided
          + plates rewarded. The restaurant count used to sit here but
          was pulled — business-sensitive at pilot scale. Aggregate
          numbers still convey scale.

          Each tile carries a small "Live" pill (pulsing sage dot +
          label) so diners register these as real-time totals refreshed
          from the platform, not marketing round numbers. */}
      <div className="grid grid-cols-3 gap-2 px-4 py-4">
        <div
          className="impact boop relative"
          style={{ animationDelay: '0.05s' }}
        >
          <LivePill />
          <div className="big tnum">{foodSaved}</div>
          <div className="cap">{t('landing.proof_kg')}</div>
        </div>
        <div
          className="impact lime boop relative"
          style={{ animationDelay: '0.15s' }}
        >
          <LivePill />
          <div className="big tnum">{co2Saved}</div>
          <div className="cap">{t('landing.proof_co2')}</div>
        </div>
        <div
          className="impact saffron boop relative"
          style={{ animationDelay: '0.25s' }}
        >
          <LivePill />
          <div className="big tnum">{rewardsIssued}</div>
          <div className="cap">{t('landing.proof_rewards')}</div>
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

/**
 * LivePill — tiny sage badge with a pulsing dot that pins to the
 * top-right of each impact tile. Reads as "these are real numbers,
 * refreshing" rather than a static marketing figure.
 */
function LivePill() {
  const { t } = useTranslation();
  return (
    <span
      className="absolute top-2 right-2 inline-flex items-center gap-1 rounded-full bg-white/70 backdrop-blur-sm px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide text-sage border border-sage/25 shadow-sm"
      aria-label={t('landing.live_aria')}
    >
      <span className="relative flex h-1.5 w-1.5">
        <span className="absolute inline-flex h-full w-full rounded-full bg-sage/60 animate-ping" />
        <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-sage" />
      </span>
      {t('landing.live')}
    </span>
  );
}

/**
 * PlateCarousel — the animated hero.
 *
 * Five dish "plates" cycle through three visible slots (left → centre →
 * right). The centre plate is scaled up and fully opaque; the flanking
 * plates are ~65% size, faded, and pushed sideways. Every 3.5s the
 * indices advance one step, so the visual reads as a slow rotation.
 *
 * Each plate is a warm radial-gradient blob (matching the pilot's
 * North Indian + Konkan cuisine palette — no photo assets yet, so we
 * paint them). When we ship real dish photos, swap the inner
 * `<div>` for an `<img src=...>` and keep the wrapper's blob mask.
 *
 * Respects `prefers-reduced-motion` — cycling pauses for diners who've
 * asked their OS to calm animations down.
 */

/**
 * Each plate is either a real photo (`imageUrl`) or a generated
 * warm gradient (`radius` + `background`). Real photos are auto-
 * discovered from `src/assets/plates/*.{png,jpg,jpeg,webp}` — drop a
 * new file in that folder and Vite picks it up on the next reload.
 * No code edit needed.
 *
 * When zero photos are present, the carousel falls back to a set of
 * generated warm gradients so the landing page still looks alive
 * during dev / photography breaks.
 */
interface PlateRecipe {
  imageUrl?: string;
  radius?: string;
  background?: string;
  /** Alt text for a11y when using a real photo. Ignored for gradients. */
  alt?: string;
}

// A shared lopsided-blob radius so every photo shows up masked to the
// same silhouette — keeps the carousel feeling like one design system
// even when photos come from different shoots.
const PLATE_MASK = '62% 38% 55% 45% / 48% 52% 40% 60%';

// Vite glob import — resolves at build time to a {path: url} map. We
// only care about the URLs, sorted alphabetically so the rotation is
// deterministic (helpful for screenshots + Playwright smoke tests).
const PLATE_PHOTOS: string[] = Object.entries(
  import.meta.glob<string>(
    '../assets/plates/*.{png,jpg,jpeg,webp,PNG,JPG,JPEG,WEBP}',
    { eager: true, import: 'default', query: '?url' },
  ),
)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([, url]) => url);

// Best-effort alt text — derives a human label from the filename by
// stripping vendor cruft (`-removebg-preview`, hash prefixes) and
// converting separators to spaces. Non-blocking for a11y; a curator
// can override later by editing the PLATES array by hand.
function altFromUrl(url: string): string {
  try {
    const fileName = url.split('/').pop() ?? '';
    return fileName
      .replace(/\.(png|jpe?g|webp)$/i, '')
      .replace(/-removebg-preview/gi, '')
      .replace(/-?\d[a-f0-9-]{10,}/gi, '')
      .replace(/[-_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  } catch {
    return 'Dish photo';
  }
}

// ── Fallback gradient plates ────────────────────────────────────────
// Used only when the assets/plates/ folder is empty — a design safety
// net so the hero never renders a blank stage.
const FALLBACK_GRADIENTS: PlateRecipe[] = [
  {
    radius: '62% 38% 55% 45% / 48% 52% 40% 60%',
    background:
      'radial-gradient(120% 80% at 26% 22%, hsl(34 64% 82%), transparent 58%),' +
      'radial-gradient(90% 80% at 82% 88%, hsl(8 56% 74%), transparent 52%),' +
      'radial-gradient(70% 60% at 64% 46%, hsl(150 30% 66%), transparent 66%),' +
      'hsl(30 38% 80%)',
  },
  {
    radius: '55% 45% 62% 38% / 52% 48% 60% 40%',
    background:
      'radial-gradient(110% 70% at 28% 20%, hsl(45 78% 86%), transparent 55%),' +
      'radial-gradient(95% 70% at 78% 82%, hsl(340 60% 82%), transparent 55%),' +
      'radial-gradient(80% 60% at 60% 50%, hsl(190 40% 72%), transparent 60%),' +
      'hsl(40 55% 84%)',
  },
  {
    radius: '48% 52% 40% 60% / 62% 38% 55% 45%',
    background:
      'radial-gradient(115% 75% at 30% 24%, hsl(75 60% 84%), transparent 58%),' +
      'radial-gradient(90% 75% at 82% 82%, hsl(150 40% 74%), transparent 55%),' +
      'radial-gradient(75% 65% at 62% 44%, hsl(45 65% 78%), transparent 60%),' +
      'hsl(90 30% 82%)',
  },
];

const PLATES: PlateRecipe[] =
  PLATE_PHOTOS.length > 0
    ? PLATE_PHOTOS.map((url) => ({ imageUrl: url, alt: altFromUrl(url) }))
    : FALLBACK_GRADIENTS;


function PlateCarousel({
  savedSticker,
}: {
  savedSticker: { label: string } | null;
}) {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    // Skip cycling if the user has requested reduced motion.
    if (typeof window !== 'undefined' && window.matchMedia) {
      const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
      if (mq.matches) return;
    }
    const id = window.setInterval(() => {
      setIndex((i) => (i + 1) % PLATES.length);
    }, 3500);
    return () => window.clearInterval(id);
  }, []);

  // Ring math: prev / centre / next with wrap-around. Any plate not
  // in these three slots is rendered off-stage (opacity 0, scaled to
  // 0.4) so the CSS transition on the way IN and OUT stays smooth.
  type Slot = 'left' | 'center' | 'right' | 'hidden';
  const positions: Slot[] = PLATES.map((_, i) => {
    if (i === index) return 'center';
    if (i === (index - 1 + PLATES.length) % PLATES.length) return 'left';
    if (i === (index + 1) % PLATES.length) return 'right';
    return 'hidden';
  });

  return (
    <div className="relative w-[320px] h-[220px] flex items-center justify-center select-none">
      {PLATES.map((plate, i) => {
        const pos: Slot = positions[i] ?? 'hidden';
        const styles = SLOT_STYLES[pos];
        const isPhoto = Boolean(plate.imageUrl);
        // Photos use a shared blob mask (so every dish reads as the
        // same "plate silhouette"); pure gradient plates carry their
        // own bespoke radius from PLATES config.
        const borderRadius = isPhoto
          ? PLATE_MASK
          : plate.radius ?? PLATE_MASK;
        // Photos float free on the green hero — no plate, no shadow
        // ring, no clipping mask. A soft drop-shadow on the img gives
        // the food just enough depth to read as a real object without
        // reintroducing the "circle behind everything" effect.
        // Gradient fallback plates keep their bespoke blob background.
        return (
          <div
            key={i}
            aria-hidden={pos !== 'center'}
            className="absolute top-1/2 left-1/2"
            style={{
              width: 196,
              height: 196,
              transform: `translate(-50%, -50%) ${styles.transform}`,
              opacity: styles.opacity,
              zIndex: styles.z,
              transition:
                'transform 700ms cubic-bezier(.4,.0,.2,1), opacity 700ms ease',
              pointerEvents: pos === 'center' ? 'auto' : 'none',
              borderRadius: isPhoto ? undefined : borderRadius,
              background: isPhoto ? undefined : plate.background,
              boxShadow: isPhoto
                ? undefined
                : pos === 'center'
                  ? '0 28px 50px -18px rgba(20,60,42,.38)'
                  : '0 18px 32px -16px rgba(20,60,42,.25)',
              overflow: isPhoto ? 'visible' : 'hidden',
              filter: pos === 'center' ? 'none' : 'saturate(.85)',
            }}
          >
            {isPhoto && (
              <img
                src={plate.imageUrl}
                alt={pos === 'center' ? plate.alt ?? '' : ''}
                loading={i <= 2 ? 'eager' : 'lazy'}
                decoding="async"
                draggable={false}
                className="w-full h-full object-contain"
                style={{
                  filter:
                    pos === 'center'
                      ? 'drop-shadow(0 18px 22px rgba(20,60,42,.28))'
                      : 'drop-shadow(0 10px 14px rgba(20,60,42,.18))',
                }}
              />
            )}
          </div>
        );
      })}
      {/* Kg-saved sticker — pinned to the centre plate. Sits above
          the plates via a higher z-index and doesn't animate with
          the carousel so the label stays legible. */}
      {savedSticker && (
        <div
          className="sticker sticker-saffron sticker-tilt absolute pointer-events-none"
          style={{
            top: 6,
            right: 32,
            zIndex: 5,
          }}
        >
          <Leaf size={12} />
          {savedSticker.label}
        </div>
      )}
      {/* Progress dots — one per plate, current one filled. Tiny,
          low-emphasis; helps the diner sense there are more dishes
          without stealing focus from the hero. */}
      <div
        className="absolute bottom-1 left-1/2 -translate-x-1/2 flex gap-1.5"
        aria-hidden
      >
        {PLATES.map((_, i) => (
          <span
            key={i}
            className="block rounded-full transition-all"
            style={{
              width: i === index ? 14 : 5,
              height: 5,
              background:
                i === index
                  ? 'hsl(145 50% 40%)'
                  : 'hsl(145 20% 70% / .55)',
            }}
          />
        ))}
      </div>
    </div>
  );
}

const SLOT_STYLES: Record<
  'left' | 'center' | 'right' | 'hidden',
  { transform: string; opacity: number; z: number }
> = {
  center: { transform: 'scale(1)', opacity: 1, z: 3 },
  // Flanking plates trimmed to .48 scale so the middle plate reads as
  // the clear focal point. Translate pulled slightly inward so the
  // smaller silhouettes don't drift into the sticker or the page edge.
  left: { transform: 'translateX(-96px) scale(.48)', opacity: 0.5, z: 1 },
  right: { transform: 'translateX(96px) scale(.48)', opacity: 0.5, z: 1 },
  hidden: { transform: 'scale(.32)', opacity: 0, z: 0 },
};
