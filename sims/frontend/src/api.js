/**
 * Tiny API client.
 *  - Access token lives in memory only (never localStorage → not readable by injected scripts).
 *  - The long-lived refresh token is an httpOnly cookie managed by the server.
 *  - A 401 triggers ONE silent refresh (shared by concurrent calls) and a retry of the original request.
 */
const BASE = '/api/v1';

let accessToken = null;
let refreshing = null;
let onSessionLost = () => {};

export const setAccessToken = (t) => { accessToken = t; };
export const setSessionLostHandler = (fn) => { onSessionLost = fn; };

export class ApiError extends Error {
  constructor(status, code, message, details) { super(message); this.status = status; this.code = code; this.details = details; }
  /** field → message map for form display (from the server's validation details) */
  get fields() {
    const out = {};
    for (const d of Array.isArray(this.details) ? this.details : []) if (d?.path && !out[d.path]) out[d.path] = d.message;
    return out;
  }
}

async function parse(res) {
  const ct = res.headers.get('content-type') || '';
  if (res.status === 204) return null;
  return ct.includes('json') ? res.json() : res.blob();
}

async function send(method, path, { body, form, signal } = {}) {
  const headers = {};
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  if (body !== undefined && !form) headers['Content-Type'] = 'application/json';
  return fetch(BASE + path, { method, headers, credentials: 'include', signal, body: form ?? (body === undefined ? undefined : JSON.stringify(body)) });
}

/** Exchange the refresh cookie for a new access token. Returns the session or null. */
export async function refreshSession() {
  refreshing ||= (async () => {
    try {
      const res = await fetch(`${BASE}/auth/refresh`, { method: 'POST', credentials: 'include' });
      if (!res.ok) return null;
      const data = await res.json();
      accessToken = data.accessToken;
      return data;
    } catch { return null; } finally { setTimeout(() => { refreshing = null; }, 0); }
  })();
  return refreshing;
}

export async function request(method, path, opts = {}) {
  let res = await send(method, path, opts);
  if (res.status === 401 && !path.startsWith('/auth/')) {
    const s = await refreshSession();
    if (s) res = await send(method, path, opts);
    else { onSessionLost(); }
  }
  const data = await parse(res);
  if (!res.ok) {
    const e = data?.error || {};
    throw new ApiError(res.status, e.code || 'ERROR', e.message || `Request failed (${res.status})`, e.details);
  }
  return data;
}

export const api = {
  get: (p, o) => request('GET', p, o),
  post: (p, body, o) => request('POST', p, { ...o, body }),
  put: (p, body, o) => request('PUT', p, { ...o, body }),
  patch: (p, body, o) => request('PATCH', p, { ...o, body }),
  del: (p, o) => request('DELETE', p, o),
  upload: (p, form, method = 'POST') => request(method, p, { form }),
  /** Fetch a protected file and open it in a new tab (an <a href> can't send the Authorization header). */
  async openFile(path) {
    const blob = await request('GET', path);
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  },
};
