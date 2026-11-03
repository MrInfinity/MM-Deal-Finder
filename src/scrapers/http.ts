// Polite HTTP client for scrapers:
//  - identifies itself honestly (no browser impersonation)
//  - enforces a minimum delay between requests per host
//  - retries 429/5xx with backoff, honoring Retry-After
// Set SCRAPER_CONTACT to an email/URL so site operators can reach you.

const CONTACT = process.env.SCRAPER_CONTACT || 'set SCRAPER_CONTACT';
export const USER_AGENT = process.env.SCRAPER_USER_AGENT || `FLDealFinderBot/0.1 (+${CONTACT})`;
const MIN_INTERVAL_MS = Number(process.env.SCRAPER_MIN_INTERVAL_MS || 600);

const nextSlot = new Map<string, number>();

async function waitForHost(host: string) {
  const now = Date.now();
  const at = Math.max(now, nextSlot.get(host) ?? 0);
  nextSlot.set(host, at + MIN_INTERVAL_MS);
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
}

export interface FetchOpts {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
  retries?: number;
  timeoutMs?: number;
}

export async function politeFetch(url: string, opts: FetchOpts = {}): Promise<Response> {
  const { method = 'GET', headers = {}, body, retries = 3, timeoutMs = 45_000 } = opts;
  const host = new URL(url).host;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    await waitForHost(host);
    try {
      const res = await fetch(url, {
        method,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'application/json, text/html;q=0.9',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 429 || res.status >= 500) {
        const ra = Number(res.headers.get('retry-after'));
        const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1500 * 2 ** attempt;
        lastErr = new Error(`HTTP ${res.status} for ${url}`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
  throw lastErr;
}

export async function getJson<T = any>(url: string, opts: FetchOpts = {}): Promise<T> {
  const res = await politeFetch(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return (await res.json()) as T;
}

export async function getText(url: string, opts: FetchOpts = {}): Promise<string> {
  const res = await politeFetch(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

/** Extract Next.js pages-router data blob. */
export function nextData(html: string): any {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('__NEXT_DATA__ not found');
  return JSON.parse(m[1]);
}
