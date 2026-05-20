const BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8000/api/v1';

export class ApiException extends Error {
  code: string;
  status: number;
  details?: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function request<T>(
  path: string,
  opts: RequestInit & { token?: string | null } = {},
): Promise<T> {
  const headers = new Headers(opts.headers ?? {});
  if (opts.token) headers.set('Authorization', `Bearer ${opts.token}`);
  if (!(opts.body instanceof FormData)) {
    headers.set('Content-Type', headers.get('Content-Type') ?? 'application/json');
  }
  const res = await fetch(`${BASE}${path}`, { ...opts, headers });
  if (!res.ok) {
    let payload: { error?: { code?: string; message?: string; details?: Record<string, unknown> } } = {};
    try {
      payload = await res.json();
    } catch {
      /* ignore */
    }
    throw new ApiException(
      res.status,
      payload.error?.code ?? `HTTP_${res.status}`,
      payload.error?.message ?? res.statusText,
      payload.error?.details,
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
      body: body ? JSON.stringify(body) : undefined,
    }),
};
