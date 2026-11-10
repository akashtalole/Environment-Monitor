import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import { fetch, EnvHttpProxyAgent } from 'undici';
import { ROOT } from './store.js';

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 EnvironmentMonitor/0.1';

const agents = new Map();

// EnvHttpProxyAgent honours HTTPS_PROXY / NO_PROXY when set and connects directly otherwise.
// Certificates are always verified. Some *.nic.in servers omit their intermediate CA
// certificate; browsers fetch it automatically but Node does not. For those, put the
// intermediate(s) in a PEM file and point the source's "caFile" at it – it is added on top
// of the normal root store, so verification stays on.
function agentFor(caFile) {
  const key = caFile || 'default';
  if (!agents.has(key)) {
    let tlsOpts = {};
    if (caFile) {
      const extra = fs.readFileSync(path.resolve(ROOT, caFile), 'utf8');
      tlsOpts = { ca: [...tls.rootCertificates, extra] };
    }
    agents.set(key, new EnvHttpProxyAgent({ connect: tlsOpts, requestTls: tlsOpts }));
  }
  return agents.get(key);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A small HTTP session with a cookie jar, retries and timeouts.
 * ASP.NET portals (environmentclearance / forestsclearance) need cookies across postbacks.
 */
export class HttpSession {
  constructor({ caFile = null, timeoutMs = 60000, retries = 3 } = {}) {
    this.dispatcher = agentFor(caFile);
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.cookies = new Map();
  }

  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  storeCookies(res) {
    const set = res.headers.getSetCookie?.() ?? [];
    for (const c of set) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      if (i > 0) this.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }

  async request(url, { method = 'GET', headers = {}, body, accept = 'text/html,*/*' } = {}) {
    let lastErr;
    for (let attempt = 1; attempt <= this.retries; attempt++) {
      try {
        const h = { 'user-agent': UA, accept, 'accept-language': 'en-IN,en;q=0.9', ...headers };
        if (this.cookies.size) h.cookie = this.cookieHeader();
        let payload = body;
        if (body && typeof body === 'object' && !(body instanceof URLSearchParams)) {
          payload = JSON.stringify(body);
          h['content-type'] ??= 'application/json';
        }
        const res = await fetch(url, {
          method,
          headers: h,
          body: payload,
          dispatcher: this.dispatcher,
          redirect: 'follow',
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        this.storeCookies(res);
        const text = await res.text();
        if (res.status >= 500) throw new HttpError(`HTTP ${res.status}`, res.status, url);
        return { status: res.status, ok: res.ok, url: res.url, headers: res.headers, text };
      } catch (err) {
        lastErr = err;
        if (err instanceof HttpError && err.status < 500) throw err;
        if (attempt < this.retries) await sleep(1500 * 2 ** (attempt - 1));
      }
    }
    throw describeNetworkError(lastErr, url);
  }

  async getText(url, opts) {
    const r = await this.request(url, opts);
    if (!r.ok) throw new HttpError(`HTTP ${r.status}`, r.status, url);
    return r.text;
  }

  async getJson(url, opts = {}) {
    const r = await this.request(url, { accept: 'application/json, text/plain, */*', ...opts });
    if (!r.ok) throw new HttpError(`HTTP ${r.status}`, r.status, url);
    try {
      return JSON.parse(r.text);
    } catch {
      throw new Error(`Expected JSON from ${url}, got: ${r.text.slice(0, 120)}`);
    }
  }
}

export class HttpError extends Error {
  constructor(message, status, url) {
    super(`${message} for ${url}`);
    this.status = status;
    this.url = url;
  }
}

const INCOMPLETE_CHAIN =
  'server sent an incomplete certificate chain; add its intermediate CA via the source "caFile" option (see README)';

function describeNetworkError(err, url) {
  let code = '';
  for (let c = err; c && !code; c = c.cause) code = c.code || '';
  const hint =
    {
      UNABLE_TO_GET_ISSUER_CERT_LOCALLY: INCOMPLETE_CHAIN,
      UNABLE_TO_VERIFY_LEAF_SIGNATURE: INCOMPLETE_CHAIN,
      ECONNRESET: 'connection reset (many .nic.in sites block traffic from outside India)',
      UND_ERR_SOCKET: 'socket closed by remote (possible geo-block)',
      ETIMEDOUT: 'timed out',
      UND_ERR_CONNECT_TIMEOUT: 'connect timed out',
    }[code] || '';
  const e = new Error(`${err?.message || err} (${url})${hint ? ` – ${hint}` : ''}`);
  e.code = code;
  return e;
}
