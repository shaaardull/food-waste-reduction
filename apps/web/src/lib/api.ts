const BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8000/api/v1';

export class ApiException extends Error {
  code: string;
  details?: Record<string, unknown>;
  status: number;

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

type ApiOptions = RequestInit & { token?: string | null };

async function request<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  const headers = new Headers(opts.headers ?? {});
  if (opts.token) headers.set('Authorization', `Bearer ${opts.token}`);
  if (!(opts.body instanceof FormData)) {
    headers.set('Content-Type', headers.get('Content-Type') ?? 'application/json');
  }
  const res = await fetch(`${BASE}${path}`, { ...opts, headers });
  if (!res.ok) {
    // Backend uses two error envelope shapes: the ApiError wrapper
    // (`{"error": {"code","message","details"}}`) on custom errors,
    // and raw FastAPI HTTPException (`{"detail": ...}`) elsewhere.
    // `detail` may itself be a dict like `{"code","message"}`.
    // Fall through both so a raw HTTPException lands as a friendly
    // message rather than the HTTP status text.
    let payload: {
      error?: { code?: string; message?: string; details?: Record<string, unknown> };
      detail?: string | { code?: string; message?: string };
    } = {};
    try {
      payload = await res.json();
    } catch {
      /* swallow non-JSON */
    }
    let code = payload.error?.code;
    let message = payload.error?.message;
    let details = payload.error?.details;
    if (!code && !message && payload.detail !== undefined) {
      if (typeof payload.detail === 'string') {
        message = payload.detail;
      } else {
        code = payload.detail.code;
        message = payload.detail.message;
      }
    }
    throw new ApiException(
      res.status,
      code ?? `HTTP_${res.status}`,
      message ?? res.statusText,
      details,
    );
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string, token?: string | null) => request<T>(path, { method: 'GET', token }),
  post: <T>(path: string, body?: unknown, token?: string | null) =>
    request<T>(path, {
      method: 'POST',
      token,
      body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
    }),
  patch: <T>(path: string, body?: unknown, token?: string | null) =>
    request<T>(path, { method: 'PATCH', token, body: JSON.stringify(body ?? {}) }),
  del: <T>(path: string, token?: string | null) => request<T>(path, { method: 'DELETE', token }),
};
