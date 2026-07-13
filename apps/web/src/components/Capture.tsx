import { useCallback, useEffect, useRef, useState } from 'react';
import Webcam from 'react-webcam';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { X, Zap, Check, RotateCcw } from 'lucide-react';
import { api, ApiException } from '../lib/api';
import { useAuthStore } from '../lib/auth';
import { useOptimisticStore } from '../lib/optimistic';

interface Props {
  sessionId: string;
  phase: 'before' | 'after';
  step: 1 | 2;
  title: string;
  blurb: string;
  cta: string;
  nextPath: string;
}

interface Geo {
  lat: number;
  lng: number;
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [meta = '', b64 = ''] = dataUrl.split(',');
  const mime = meta.match(/data:(.*?);/)?.[1] ?? 'image/jpeg';
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

/**
 * Capture screen — full-screen camera takeover for before/after plate
 * photos. Escapes the App container via `fixed inset-0 z-50` so the
 * design has edge-to-edge real estate.
 *
 * The dashed plate-guide circle is decorative — it gives the diner a
 * frame to aim at, but we don't enforce it server-side. Geo + device
 * fingerprint go alongside the image for the table-binding check
 * (CLAUDE.md §6 — anti-cheat).
 */
export function Capture({
  sessionId,
  phase,
  step,
  title,
  blurb,
  cta,
  nextPath,
}: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const token = useAuthStore((s) => s.token);
  const queryClient = useQueryClient();
  const { markBeforePending, markBeforeDone, markBeforeError } =
    useOptimisticStore();
  const webcamRef = useRef<Webcam>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [geo, setGeo] = useState<Geo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(false);

  useEffect(() => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => setGeo({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => setGeo(null),
      { enableHighAccuracy: true, timeout: 5_000 },
    );
  }, []);

  const snap = useCallback(() => {
    const src = webcamRef.current?.getScreenshot();
    if (src) {
      // Quick white flash hint that a frame was taken — purely cosmetic.
      setFlash(true);
      window.setTimeout(() => setFlash(false), 120);
      setPreview(src);
    }
  }, []);

  /**
   * Build the multipart body once — same shape for both phases. Kept
   * as a nested helper so both the fire-and-forget (before) and the
   * awaited (after) code paths can share it.
   */
  function buildForm(nonce: string): FormData | null {
    if (!preview) return null;
    const blob = dataUrlToBlob(preview);
    const form = new FormData();
    form.append('image', blob, `${phase}.jpg`);
    form.append('nonce', nonce);
    if (geo) {
      form.append('client_lat', String(geo.lat));
      form.append('client_lng', String(geo.lng));
    }
    form.append('device_fingerprint', navigator.userAgent.slice(0, 200));
    return form;
  }

  async function send() {
    if (!preview) return;
    let nonce = sessionStorage.getItem(`nonce-${phase}-${sessionId}`);

    // Race window for the `after` phase: the diner just finished the
    // before-photo flow, which we made optimistic — they can arrive
    // on the after-camera screen and tap Submit before the
    // fire-and-forget before-upload has landed (and therefore before
    // the after_capture_nonce has been stashed). Poll for up to ~8s
    // so we don't false-negative on slow networks. If the before
    // upload errored, the SessionStatus retry banner catches them
    // instead of them ever reaching here — but as a safety net we
    // still bail if the wait times out.
    if (!nonce && phase === 'after') {
      setBusy(true);
      const deadline = Date.now() + 8_000;
      while (!nonce && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 250));
        nonce = sessionStorage.getItem(`nonce-${phase}-${sessionId}`);
      }
      setBusy(false);
    }

    if (!nonce) {
      setError(t('capture.missing_nonce'));
      window.setTimeout(() => navigate('/scan'), 2500);
      return;
    }
    const form = buildForm(nonce);
    if (!form) return;

    if (phase === 'before') {
      // ── Optimistic path ───────────────────────────────────────
      // The moment the diner taps Submit we:
      //   1. Consume the before-nonce so the fire-and-forget upload
      //      is the only pending call for it (defensive against a
      //      double-tap).
      //   2. Pre-flip the /sessions/:id cache so SessionStatus
      //      immediately renders the "Claim after" CTA — no
      //      round-trip latency on the visible transition.
      //   3. Mark the session as `pending` in the optimistic store
      //      so SessionStatus keeps rendering "Claim after" even if
      //      the 3-s poll fetches an outdated status='open' before
      //      the upload completes.
      //   4. Navigate immediately.
      //   5. Fire the upload in the background — on success stash
      //      the after-nonce and clear the flag; on failure record
      //      the error so SessionStatus can render a retry banner.
      sessionStorage.removeItem(`nonce-${phase}-${sessionId}`);

      // Optimistic cache write — the shape mirrors SessionDetail's
      // top-level `session.status`. We use setQueryData rather than
      // invalidate so the next poll doesn't overwrite our optimistic
      // value; the store flag guards subsequent polls too.
      queryClient.setQueryData(
        ['session', sessionId],
        (
          old:
            | { session?: { status?: string } }
            | undefined,
        ) =>
          old
            ? {
                ...old,
                session: { ...old.session, status: 'before_captured' },
              }
            : old,
      );
      markBeforePending(sessionId);

      api
        .post<{ after_capture_nonce?: string; processing_status?: string }>(
          `/sessions/${sessionId}/captures/${phase}`,
          form,
          token,
        )
        .then((res) => {
          if (res.after_capture_nonce) {
            sessionStorage.setItem(
              `nonce-after-${sessionId}`,
              res.after_capture_nonce,
            );
          }
          markBeforeDone(sessionId);
          // Sync with server truth in case anything else changed
          // (e.g. staff cancellation mid-upload).
          void queryClient.invalidateQueries({
            queryKey: ['session', sessionId],
          });
        })
        .catch((err) => {
          const message =
            err instanceof ApiException
              ? err.message
              : t('capture.generic_error');
          markBeforeError(sessionId, message);
          void queryClient.invalidateQueries({
            queryKey: ['session', sessionId],
          });
        });

      navigate(nextPath);
      return;
    }

    // ── After phase — awaited path ───────────────────────────────
    // The diner is already on the after-camera screen; the button
    // shows a spinner while we upload. There's no follow-on nonce
    // to worry about — the score task fires server-side and the
    // diner falls back to SessionStatus polling.
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{
        after_capture_nonce?: string;
        processing_status?: string;
      }>(`/sessions/${sessionId}/captures/${phase}`, form, token);
      sessionStorage.removeItem(`nonce-${phase}-${sessionId}`);
      if (res.after_capture_nonce) {
        sessionStorage.setItem(
          `nonce-after-${sessionId}`,
          res.after_capture_nonce,
        );
      }
      navigate(nextPath);
    } catch (err) {
      if (err instanceof ApiException) setError(err.message);
      else setError(t('capture.generic_error'));
    } finally {
      setBusy(false);
    }
  }

  function close() {
    navigate(`/sessions/${sessionId}`);
  }

  const guideText =
    phase === 'before' ? t('capture.guide_before') : t('capture.guide_after');

  return (
    <div className="fixed inset-0 z-50 bg-[#0c1413] text-white flex flex-col">
      {/* live camera or preview fills the surface */}
      <div className="absolute inset-0">
        {preview ? (
          <img
            src={preview}
            alt={title}
            className="w-full h-full object-cover"
          />
        ) : (
          <Webcam
            ref={webcamRef}
            audio={false}
            screenshotFormat="image/jpeg"
            videoConstraints={{ facingMode: { ideal: 'environment' } }}
            className="w-full h-full object-cover"
          />
        )}
        {/* shutter flash */}
        {flash && (
          <div className="absolute inset-0 bg-white opacity-60 pointer-events-none" />
        )}
        {/* dim vignette so overlay reads against any scene */}
        <div className="absolute inset-0 bg-gradient-to-b from-black/30 via-transparent to-black/55 pointer-events-none" />
      </div>

      {/* top bar — close, step, cosmetic flash */}
      <div className="relative z-10 px-4 pt-[max(env(safe-area-inset-top),16px)] pb-3 row spread">
        <button
          onClick={close}
          aria-label={t('capture.close')}
          className="w-10 h-10 rounded-full bg-black/45 backdrop-blur flex items-center justify-center hover:bg-black/60 transition"
        >
          <X size={20} />
        </button>
        <div className="chip bg-black/45 backdrop-blur text-white border border-white/15">
          <span className="font-semibold text-[13px] tnum">
            {t('capture.step', { n: step })}
          </span>
        </div>
        <button
          aria-label="Flash"
          className="w-10 h-10 rounded-full bg-black/45 backdrop-blur flex items-center justify-center text-white/70"
          disabled
        >
          <Zap size={18} />
        </button>
      </div>

      {/* title + blurb */}
      {!preview && (
        <div className="relative z-10 px-5 mt-1">
          <h1 className="display text-[24px] leading-tight text-white drop-shadow">
            {title}
          </h1>
          <p className="text-[13px] text-white/80 mt-1 leading-snug max-w-[28ch] drop-shadow">
            {blurb}
          </p>
        </div>
      )}

      {/* plate-guide circle + instruction pill (only while framing) */}
      {!preview && (
        <div className="relative z-10 flex-1 flex flex-col items-center justify-center px-6">
          <div className="w-[270px] h-[270px] rounded-full border-2 border-dashed border-white/55" />
          <div className="mt-4 px-3.5 py-1.5 rounded-full bg-black/45 backdrop-blur text-[12px] font-medium">
            {guideText}
          </div>
        </div>
      )}

      {/* spacer when previewing — let the image breathe */}
      {preview && <div className="relative z-10 flex-1" />}

      {/* error toast */}
      {error && (
        <div className="relative z-10 mx-4 mb-3 rounded-md bg-danger/90 text-white text-[13px] px-3 py-2 backdrop-blur">
          {error}
        </div>
      )}

      {/* bottom action zone */}
      <div className="relative z-10 px-5 pb-[max(env(safe-area-inset-bottom),20px)] pt-3">
        {!preview ? (
          <div className="row justify-center">
            <button
              onClick={snap}
              aria-label={t('capture.take_picture')}
              className="w-[78px] h-[78px] rounded-full bg-white flex items-center justify-center shadow-lg hover:scale-[0.97] active:scale-95 transition"
            >
              <span className="w-[64px] h-[64px] rounded-full border-2 border-[#0c1413]/85" />
            </button>
          </div>
        ) : (
          <div className="row gap-3">
            <button
              onClick={() => setPreview(null)}
              disabled={busy}
              className="flex-1 h-12 rounded-md border border-white/30 bg-white/10 backdrop-blur text-white font-semibold text-[15px] row items-center justify-center gap-2 hover:bg-white/15 transition disabled:opacity-50"
            >
              <RotateCcw size={16} />
              {t('capture.retake')}
            </button>
            <button
              onClick={send}
              disabled={busy}
              className="flex-1 h-12 rounded-md bg-brand text-white font-semibold text-[15px] row items-center justify-center gap-2 hover:bg-brand-press transition disabled:opacity-60"
            >
              <Check size={16} />
              {busy ? t('capture.sending') : cta}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
