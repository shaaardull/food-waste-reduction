import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { GoogleLogin } from '@react-oauth/google';
import type { User } from '@plate-clean/shared-types';
import { api, ApiException } from '../lib/api';
import { useAuthStore } from '../lib/auth';

/**
 * Google Identity Services button, styled to match the rest of the
 * diner PWA. Renders Google's official button widget (compliance
 * requirement — the button IS the "Sign in with Google" mark) and
 * forwards the credential to our backend.
 *
 * Behaviour:
 *   • On success — `credentialResponse.credential` is the raw Google
 *     ID token. We POST it to /auth/google, which finds-or-creates
 *     the user + returns our own JWT. Same setAuth call as every
 *     other auth path.
 *   • On failure — Google's own popup handles the user-facing error;
 *     we surface a light "couldn't sign you in" toast if the network
 *     round-trip to /auth/google itself fails.
 *   • On backend 503 (GOOGLE_NOT_CONFIGURED) — we render an inline
 *     "not set up yet" message rather than a scary error. That's the
 *     graceful-degradation path when the deployment hasn't been
 *     handed a client ID.
 *
 * Redirect target (`redirectTo`) is caller-supplied so the same
 * button works on Login (→ /scan) and on OnboardChoice (→ /scan
 * or the QR context if the diner just scanned a sticker).
 */

interface Props {
  /** Where to navigate after a successful sign-in. */
  redirectTo?: string;
  /** Optional label override — defaults to the i18n copy. */
  fullWidth?: boolean;
}

export function GoogleSignInButton({ redirectTo = '/scan' }: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const setAuth = useAuthStore((s) => s.setAuth);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleCredential(idToken: string) {
    setError(null);
    setBusy(true);
    try {
      const res = await api.post<{ user: User; token: string }>(
        '/auth/google',
        { id_token: idToken },
      );
      setAuth(res.user, res.token);
      navigate(redirectTo);
    } catch (err) {
      if (err instanceof ApiException) {
        const code =
          (err.details as { code?: string } | undefined)?.code ?? err.code;
        if (code === 'GOOGLE_NOT_CONFIGURED') {
          setError(t('google_signin.not_configured'));
        } else {
          setError(err.message ?? t('google_signin.error_generic'));
        }
      } else {
        setError(t('google_signin.error_generic'));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-center gap-2">
      <GoogleLogin
        onSuccess={(credentialResponse) => {
          if (credentialResponse.credential) {
            void handleCredential(credentialResponse.credential);
          }
        }}
        onError={() => setError(t('google_signin.error_generic'))}
        theme="outline"
        shape="pill"
        size="large"
        text="continue_with"
        // Google's widget handles the popup + the "one tap" prompt.
        // We deliberately don't opt into `useOneTap` on the login
        // screen — a diner staring at a sign-in form doesn't need
        // an autoprompt.
      />
      {busy && (
        <span className="text-[11.5px] text-muted">
          {t('google_signin.signing_in')}
        </span>
      )}
      {error && (
        <p className="text-[12px] text-danger max-w-[42ch] text-center">
          {error}
        </p>
      )}
    </div>
  );
}
