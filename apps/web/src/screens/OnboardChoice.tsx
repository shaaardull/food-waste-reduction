import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Phone, Mail, Leaf, ArrowLeft, UserX } from 'lucide-react';
import { LangToggle } from '../components/LangToggle';
import { GoogleSignInButton } from '../components/GoogleSignInButton';

/**
 * OnboardChoice — the phone/email picker shown right after a QR scan
 * (or when the diner taps the primary CTA on Landing). Both paths land
 * back at the meal flow after auth; the API doesn't care which one was
 * used, sessions are keyed on the user id either way.
 *
 * We push diners toward the phone option (bigger button, saffron
 * eyebrow) because it's the faster path — no password, no account
 * creation, just an OTP. Email is the "I already have an account or
 * want a proper receipt" option.
 */
export function OnboardChoice() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <div className="d-screen min-h-full flex flex-col">
      {/* header — back + lang toggle */}
      <div className="spread px-5 pt-4 pb-1">
        <button
          onClick={() => navigate(-1)}
          className="row gap-1.5 items-center text-[13px] font-semibold text-muted hover:text-ink"
          aria-label={t('onboard_choice.back')}
        >
          <ArrowLeft size={14} />
          <span>{t('onboard_choice.back')}</span>
        </button>
        <LangToggle />
      </div>

      {/* eyebrow + heading */}
      <div className="px-6 pt-4 flex-1 flex flex-col gap-6">
        <div>
          <div className="row gap-2 items-center text-[12px] font-semibold text-sage dev uppercase tracking-wide">
            <Leaf size={13} />
            {t('onboard_choice.eyebrow')}
          </div>
          <h1 className="display text-[36px] leading-[1.02] mt-3">
            {t('onboard_choice.headline')}
          </h1>
          <p className="text-muted text-[14.5px] leading-[1.5] mt-3">
            {t('onboard_choice.subheadline')}
          </p>
        </div>

        {/* Google above the three cards. It's not just another
            equal card because the button widget is Google-owned
            styling — it looks out of place shoehorned into our card
            format. Above-the-fold placement respects that most
            Indian diners already have a Gmail account. */}
        <div className="flex flex-col gap-3 items-center">
          <GoogleSignInButton redirectTo="/scan" />
          <div className="row gap-2 items-center text-[11px] text-muted uppercase tracking-wide dev w-full">
            <span className="flex-1 h-px bg-line" />
            <span>{t('onboard_choice.or')}</span>
            <span className="flex-1 h-px bg-line" />
          </div>
        </div>

        {/* two big option cards */}
        <div className="flex flex-col gap-3">
          <Link
            to="/quick-start"
            className="card p-5 row gap-4 items-center hover:border-brand transition group"
          >
            <div className="w-14 h-14 rounded-md bg-brand text-white flex items-center justify-center flex-shrink-0">
              <Phone size={22} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="row gap-2 items-baseline">
                <div className="font-bold text-[17px] text-ink">
                  {t('onboard_choice.phone_title')}
                </div>
                <span className="chip chip-saffron">
                  {t('onboard_choice.phone_badge')}
                </span>
              </div>
              <p className="text-[13px] text-muted mt-1 leading-snug">
                {t('onboard_choice.phone_blurb')}
              </p>
            </div>
          </Link>

          <Link
            to="/login"
            className="card p-5 row gap-4 items-center hover:border-brand transition group"
          >
            <div className="w-14 h-14 rounded-md bg-brand-wash text-brand flex items-center justify-center flex-shrink-0">
              <Mail size={22} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="font-bold text-[17px] text-ink">
                {t('onboard_choice.email_title')}
              </div>
              <p className="text-[13px] text-muted mt-1 leading-snug">
                {t('onboard_choice.email_blurb')}
              </p>
            </div>
          </Link>

          {/* Third option: "no account needed" — routes to /quick-start
              with an ?anon=1 hint so QuickStart can show
              ephemerality-honest copy ("we won't save your details
              after this meal"). Deliberately visually lighter (muted
              border, no coloured icon square) so it reads as the
              fallback, not the recommended path. */}
          <Link
            to="/quick-start?anon=1"
            className="card p-5 row gap-4 items-center border-dashed hover:border-brand transition group"
          >
            <div className="w-14 h-14 rounded-md bg-cream text-muted flex items-center justify-center flex-shrink-0">
              <UserX size={22} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="font-bold text-[17px] text-ink">
                {t('onboard_choice.no_account_title')}
              </div>
              <p className="text-[13px] text-muted mt-1 leading-snug">
                {t('onboard_choice.no_account_blurb')}
              </p>
            </div>
          </Link>
        </div>
      </div>

      {/* footer — ethics disclaimer */}
      <div className="px-6 py-6 text-center">
        <p className="text-[11.5px] text-faint leading-[1.5]">
          {t('onboard_choice.ethics_note')}
        </p>
      </div>
    </div>
  );
}
