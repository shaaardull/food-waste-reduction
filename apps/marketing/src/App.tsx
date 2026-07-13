import {
  Leaf,
  ArrowRight,
  Sparkles,
  Camera,
  QrCode,
  Users,
  LayoutDashboard,
  BarChart3,
  Building2,
  Mail,
} from 'lucide-react';

/**
 * Marketing front door. Sits at the root of `plateclean.in` (or
 * `superpositionlabs.co.in/plate-clean` — deploy target is a config
 * decision, not a code one). Job:
 *
 *   1. Establish parent-company trust — Superposition Labs Pvt Ltd
 *      is the entity behind the product. Diners see it in the
 *      footer, restaurant partners see it prominently in the About
 *      section (they're onboarding a real corporate relationship,
 *      not a random side project).
 *   2. Route incoming traffic to the correct experience. Two big
 *      cards: "I'm a diner" → PWA, "I'm a restaurant partner" →
 *      dashboard. No third path — the copy keeps the choice clean.
 *   3. Optional third path: "Get in touch" for restaurants who
 *      aren't ready to self-serve.
 *
 * URLs are pulled from Vite env at build time so a prod build points
 * at the real subdomains without a code change.
 */

const DINER_URL = import.meta.env.VITE_DINER_URL ?? 'http://localhost:5173';
const DASHBOARD_URL =
  import.meta.env.VITE_DASHBOARD_URL ?? 'http://localhost:5174';
const CONTACT_EMAIL =
  import.meta.env.VITE_CONTACT_EMAIL ??
  'hello-platecleanrewards@superpositionlabs.co.in';

export function App() {
  return (
    <div className="min-h-full flex flex-col">
      <Header />
      <main className="flex-1">
        <Hero />
        <AudienceChooser />
        <HowItWorks />
        <ForPartners />
      </main>
      <Footer />
    </div>
  );
}

function Header() {
  return (
    <header className="border-b border-line/60 bg-paper/70 backdrop-blur">
      <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
        <a href="/" className="flex items-center gap-2.5 group">
          <span className="w-9 h-9 rounded-md bg-brand text-white flex items-center justify-center">
            <Leaf size={17} />
          </span>
          <span className="flex flex-col leading-none">
            <span className="font-bold text-[15px] text-ink">
              Plate-Clean Rewards
            </span>
            <span className="text-[11px] text-muted mt-0.5">
              a Superposition Labs product
            </span>
          </span>
        </a>
        <nav className="hidden md:flex items-center gap-6 text-[13.5px] font-semibold text-ink/70">
          <a href="#how-it-works" className="hover:text-ink">
            How it works
          </a>
          <a href="#partners" className="hover:text-ink">
            For restaurants
          </a>
          <a
            href={`mailto:${CONTACT_EMAIL}`}
            className="hover:text-ink"
          >
            Contact
          </a>
        </nav>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="max-w-6xl mx-auto px-6 pt-16 pb-10 md:pt-24 md:pb-14 text-center">
      <div className="eyebrow flex items-center justify-center gap-2">
        <Sparkles size={13} />
        <span>Eat happy, waste less</span>
      </div>
      <h1 className="display text-[42px] md:text-[68px] mt-4">
        Finish your plate,
        <br />
        <span className="display-italic text-brand">grow a reward.</span>
      </h1>
      <p className="mt-6 text-[15.5px] md:text-[17px] text-muted leading-[1.55] max-w-[52ch] mx-auto">
        Plate-Clean pairs vision AI with human review to reward diners for
        the food they actually finish — and gives restaurants a clean signal
        on where waste happens on the plate.
      </p>
      <div className="mt-8 inline-flex items-center gap-2 text-[12.5px] text-muted">
        <span
          className="w-2 h-2 rounded-full bg-brand"
          aria-hidden="true"
        />
        Pilot live in Mumbai · 2 restaurants · N. Indian + Konkan
      </div>
    </section>
  );
}

function AudienceChooser() {
  return (
    <section className="max-w-6xl mx-auto px-6 pb-16" id="audience">
      <div className="eyebrow text-center">Where do you want to go?</div>
      <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
        <AudienceCard
          href={DINER_URL}
          icon={<QrCode size={22} />}
          eyebrow="Diner"
          title="Open the diner app"
          blurb="Scan your table QR, order, and finish your meal to earn rewards you can spend at the restaurant."
          ctaLabel="Open the app"
          tone="brand"
        />
        <AudienceCard
          href={DASHBOARD_URL}
          icon={<LayoutDashboard size={22} />}
          eyebrow="Restaurant partner"
          title="Open the staff dashboard"
          blurb="Validation queue, live orders, past bills, disputes, analytics, and settings for your restaurant."
          ctaLabel="Sign in to dashboard"
          tone="sage"
        />
      </div>
      <p className="mt-6 text-center text-[13px] text-muted">
        Not a restaurant partner yet?{' '}
        <a
          href={`mailto:${CONTACT_EMAIL}?subject=Plate-Clean%20partner%20enquiry`}
          className="text-brand font-semibold hover:underline"
        >
          Talk to our team
        </a>{' '}
        — we onboard restaurants in under a week.
      </p>
    </section>
  );
}

function AudienceCard({
  href,
  icon,
  eyebrow,
  title,
  blurb,
  ctaLabel,
  tone,
}: {
  href: string;
  icon: React.ReactNode;
  eyebrow: string;
  title: string;
  blurb: string;
  ctaLabel: string;
  tone: 'brand' | 'sage';
}) {
  const iconBg = tone === 'brand' ? 'bg-brand-wash text-brand' : 'bg-sage-wash text-sage';
  const cta = tone === 'brand' ? 'text-brand' : 'text-sage';
  return (
    <a
      href={href}
      className="card card-hover p-7 md:p-8 flex flex-col gap-3 text-left group"
    >
      <div className="flex items-center gap-2.5">
        <span
          className={`w-11 h-11 rounded-md flex items-center justify-center ${iconBg}`}
        >
          {icon}
        </span>
        <span className="eyebrow" style={{ letterSpacing: '0.14em' }}>
          {eyebrow}
        </span>
      </div>
      <div className="display text-[24px] md:text-[28px] mt-1">{title}</div>
      <p className="text-[14px] text-muted leading-[1.55]">{blurb}</p>
      <div className={`mt-2 row inline-flex items-center gap-1.5 font-semibold text-[14px] ${cta}`}>
        {ctaLabel}
        <ArrowRight
          size={16}
          className="transition-transform group-hover:translate-x-0.5"
        />
      </div>
    </a>
  );
}

function HowItWorks() {
  const steps = [
    {
      icon: <QrCode size={18} />,
      title: 'Scan your table',
      body:
        'Every table has a Plate-Clean sticker. Point your camera, land on your restaurant.',
    },
    {
      icon: <Camera size={18} />,
      title: 'Snap before & after',
      body:
        "Quick photo when your plate arrives, another when you're done. Vision AI + a staff review handles the scoring.",
    },
    {
      icon: <Sparkles size={18} />,
      title: 'Reward unlocks',
      body:
        'Finish enough of what you ordered and a reward lands — a free dish or a discount at the same restaurant.',
    },
  ];
  return (
    <section
      id="how-it-works"
      className="max-w-6xl mx-auto px-6 py-16 border-t border-line/60"
    >
      <div className="eyebrow text-center">How it works</div>
      <h2 className="display text-[30px] md:text-[40px] text-center mt-3">
        Three taps between you and a
        <br />
        <span className="display-italic text-brand">smaller carbon footprint.</span>
      </h2>
      <div className="mt-10 grid grid-cols-1 md:grid-cols-3 gap-4">
        {steps.map((s, i) => (
          <div key={i} className="card p-6 flex flex-col gap-2">
            <span className="w-10 h-10 rounded-md bg-brand-wash text-brand flex items-center justify-center">
              {s.icon}
            </span>
            <div className="font-bold text-[16px] text-ink mt-2">
              {i + 1}. {s.title}
            </div>
            <p className="text-[13.5px] text-muted leading-[1.55]">{s.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function ForPartners() {
  const perks = [
    {
      icon: <BarChart3 size={16} />,
      title: 'Waste analytics per dish',
      body:
        'See exactly which items get left half-eaten. Portion smarter, procure better.',
    },
    {
      icon: <Users size={16} />,
      title: 'Loyalty that aligns incentives',
      body:
        'Diners come back for the reward, and your plate-clearance rate goes up either way.',
    },
    {
      icon: <LayoutDashboard size={16} />,
      title: 'Kitchen + validation dashboard',
      body:
        'Live orders board, staff validation queue, past bills, disputes, GST-compliant invoices — all in one place.',
    },
  ];
  return (
    <section
      id="partners"
      className="max-w-6xl mx-auto px-6 py-16 border-t border-line/60"
    >
      <div className="grid md:grid-cols-2 gap-10 items-start">
        <div>
          <div className="eyebrow">For restaurants</div>
          <h2 className="display text-[30px] md:text-[42px] mt-3">
            A sustainability
            <br />
            <span className="display-italic text-brand">story</span>{' '}
            you can measure.
          </h2>
          <p className="mt-5 text-[15px] text-muted leading-[1.6] max-w-[46ch]">
            Plate-Clean is additive — sits alongside whatever POS you run. Set
            your reward rule, print your QR stickers, watch waste drop.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <a
              href={`mailto:${CONTACT_EMAIL}?subject=Plate-Clean%20partner%20enquiry`}
              className="inline-flex items-center gap-2 h-11 px-5 rounded-full bg-brand text-white font-semibold text-[14px] hover:bg-brand/90 transition"
            >
              <Mail size={15} /> Talk to us
            </a>
            <a
              href={DASHBOARD_URL}
              className="inline-flex items-center gap-2 h-11 px-5 rounded-full bg-paper border border-line text-ink font-semibold text-[14px] hover:border-brand transition"
            >
              <LayoutDashboard size={15} /> Already onboarded? Sign in
            </a>
          </div>
        </div>
        <div className="flex flex-col gap-3">
          {perks.map((p, i) => (
            <div key={i} className="card p-5 flex gap-3">
              <span className="w-8 h-8 rounded-md bg-sage-wash text-sage flex items-center justify-center shrink-0">
                {p.icon}
              </span>
              <div>
                <div className="font-bold text-[14.5px] text-ink">
                  {p.title}
                </div>
                <p className="text-[13px] text-muted mt-0.5 leading-[1.5]">
                  {p.body}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t border-line/60 bg-paper/70 mt-8">
      <div className="max-w-6xl mx-auto px-6 py-10 grid md:grid-cols-3 gap-8">
        <div>
          <div className="flex items-center gap-2.5">
            <span className="w-9 h-9 rounded-md bg-ink text-white flex items-center justify-center">
              <Building2 size={17} />
            </span>
            <div className="leading-tight">
              <div className="font-bold text-[14px] text-ink">
                Superposition Labs Pvt Ltd
              </div>
              <div className="text-[11.5px] text-muted mt-0.5">
                Parent company · Mumbai, India
              </div>
            </div>
          </div>
          <p className="mt-4 text-[12.5px] text-muted leading-[1.6] max-w-[38ch]">
            Plate-Clean Rewards is built and operated by Superposition Labs.
            We build tools that keep incentives aligned with outcomes.
          </p>
        </div>

        <div>
          <div className="eyebrow">Product</div>
          <ul className="mt-3 space-y-2 text-[13px]">
            <li>
              <a href={DINER_URL} className="text-ink hover:text-brand">
                Diner app
              </a>
            </li>
            <li>
              <a href={DASHBOARD_URL} className="text-ink hover:text-brand">
                Restaurant dashboard
              </a>
            </li>
            <li>
              <a href="#how-it-works" className="text-ink hover:text-brand">
                How it works
              </a>
            </li>
          </ul>
        </div>

        <div>
          <div className="eyebrow">Get in touch</div>
          <ul className="mt-3 space-y-2 text-[13px]">
            <li>
              <a
                href={`mailto:${CONTACT_EMAIL}`}
                className="inline-flex items-center gap-1.5 text-ink hover:text-brand"
              >
                <Mail size={13} /> {CONTACT_EMAIL}
              </a>
            </li>
            <li>
              <a
                href="https://superpositionlabs.co.in"
                className="inline-flex items-center gap-1.5 text-ink hover:text-brand"
                target="_blank"
                rel="noreferrer"
              >
                superpositionlabs.co.in
              </a>
            </li>
          </ul>
        </div>
      </div>
      <div className="border-t border-line/60">
        <div className="max-w-6xl mx-auto px-6 py-4 text-[11.5px] text-muted flex flex-wrap items-center justify-between gap-2">
          <span>
            © {new Date().getFullYear()} Superposition Labs Pvt Ltd. All rights
            reserved.
          </span>
          <span>DPDP Act compliant · India-first</span>
        </div>
      </div>
    </footer>
  );
}
