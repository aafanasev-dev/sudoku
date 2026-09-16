// Thin JSON client for the backend. Same-origin only; the session cookie
// rides along automatically.

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/**
 * @param {object} [o]
 * @param {typeof fetch} [o.fetch]
 * @param {() => void} [o.onUnauthorized]  called on any 401
 */
export function createApi({ fetch: fetchImpl = globalThis.fetch.bind(globalThis), onUnauthorized = () => {} } = {}) {
  async function request(method, path, body, { keepalive = false } = {}) {
    let res;
    try {
      res = await fetchImpl(path, {
        method,
        credentials: 'same-origin',
        keepalive,
        headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new ApiError(0, `Network error: ${err?.message ?? err}`);
    }
    if (res.status === 401) {
      onUnauthorized();
      throw new ApiError(401, 'Not signed in');
    }
    if (!res.ok) {
      let detail = res.statusText;
      try { detail = (await res.json()).detail ?? detail; } catch { /* not JSON */ }
      throw new ApiError(res.status, typeof detail === 'string' ? detail : JSON.stringify(detail));
    }
    if (res.status === 204) return null;
    return res.json();
  }

  return {
    get: (path, opts) => request('GET', path, undefined, opts),
    post: (path, body, opts) => request('POST', path, body ?? {}, opts),
    put: (path, body, opts) => request('PUT', path, body, opts),
    del: (path, opts) => request('DELETE', path, undefined, opts),
  };
}

export function randomId() {
  if (globalThis.crypto?.randomUUID) {
    try { return crypto.randomUUID(); } catch { /* insecure context */ }
  }
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}
