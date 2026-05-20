import { useCallback, useEffect, useRef, useState } from 'react';
import Webcam from 'react-webcam';
import { useNavigate } from 'react-router-dom';
import { api, ApiException } from '../lib/api';
import { useAuthStore } from '../lib/auth';

interface Props {
  sessionId: string;
  phase: 'before' | 'after';
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
  const [meta, b64] = dataUrl.split(',');
  const mime = meta.match(/data:(.*?);/)?.[1] ?? 'image/jpeg';
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

export function Capture({ sessionId, phase, title, blurb, cta, nextPath }: Props) {
  const navigate = useNavigate();
  const token = useAuthStore((s) => s.token);
  const webcamRef = useRef<Webcam>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [geo, setGeo] = useState<Geo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
    if (src) setPreview(src);
  }, []);

  async function send() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const nonce = sessionStorage.getItem(`nonce-${phase}-${sessionId}`);
      if (!nonce) {
        setError('Missing capture token. Re-open the session from the kitchen flow.');
        setBusy(false);
        return;
      }
      const blob = dataUrlToBlob(preview);
      const form = new FormData();
      form.append('image', blob, `${phase}.jpg`);
      form.append('nonce', nonce);
      if (geo) {
        form.append('client_lat', String(geo.lat));
        form.append('client_lng', String(geo.lng));
      }
      form.append('device_fingerprint', navigator.userAgent.slice(0, 200));

      const res = await api.post<{ after_capture_nonce?: string; processing_status?: string }>(
        `/sessions/${sessionId}/captures/${phase}`,
        form,
        token,
      );
      sessionStorage.removeItem(`nonce-${phase}-${sessionId}`);
      if (phase === 'before' && res.after_capture_nonce) {
        sessionStorage.setItem(`nonce-after-${sessionId}`, res.after_capture_nonce);
      }
      navigate(nextPath);
    } catch (err) {
      if (err instanceof ApiException) setError(err.message);
      else setError('Could not upload. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-4">
      <h1 className="text-xl font-semibold">{title}</h1>
      <p className="text-sm text-slate-600">{blurb}</p>
      <div className="rounded-lg overflow-hidden bg-black aspect-[3/4]">
        {preview ? (
          <img src={preview} alt="captured" className="w-full h-full object-cover" />
        ) : (
          <Webcam
            ref={webcamRef}
            audio={false}
            screenshotFormat="image/jpeg"
            videoConstraints={{ facingMode: { ideal: 'environment' } }}
            className="w-full h-full object-cover"
          />
        )}
      </div>
      {error && <p className="text-sm text-red-700">{error}</p>}
      <div className="flex gap-2">
        {!preview ? (
          <button
            onClick={snap}
            className="flex-1 rounded-md bg-brand-600 hover:bg-brand-700 text-white py-3 font-medium"
          >
            Take picture
          </button>
        ) : (
          <>
            <button
              onClick={() => setPreview(null)}
              className="flex-1 rounded-md border border-slate-300 py-3"
            >
              Retake
            </button>
            <button
              onClick={send}
              disabled={busy}
              className="flex-1 rounded-md bg-brand-600 hover:bg-brand-700 text-white py-3 disabled:opacity-50"
            >
              {busy ? 'Sending…' : cta}
            </button>
          </>
        )}
      </div>
    </section>
  );
}
