// HTTP server: JSON API + static frontend. Zero dependencies.
//   GET /api/meta
//   GET /api/stores?zip=<ZIP>&radius=25
//   GET /api/search?q=2 oz flower&zip=<ZIP>&radius=25&operators=muv,trulieve&stores=<store id>&minThc=20
//   GET /api/verify?ids=<product ids>   live stock re-check with the dispensaries (max 40 ids)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, allStores, productsForStores, productsByIds, applyStockCheck } from './db.ts';
import { getScraper } from './scrapers/index.ts';
import type { Product } from './types.ts';
import { nearestZip, zipToLatLng } from './geo.ts';
import { route, type Snapshot } from './api.ts';

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const db = openDb();
// Menu data older than this is not trusted for stock; those stores are left out of results.
const MAX_MENU_AGE_HOURS = Number(process.env.MAX_MENU_AGE_HOURS ?? 24);

// In-memory snapshot, reloaded whenever a scrape writes new data (max(last_scraped_at) changes).
let cache: (Snapshot & { version: string }) | null = null;
function snapshot(): Snapshot {
  const v = db.prepare('SELECT max(last_scraped_at) v, count(*) n FROM stores').get() as any;
  const version = `${v.v}|${v.n}`;
  if (!cache || cache.version !== version) {
    const stores = allStores(db);
    cache = { version, stores, products: productsForStores(db, stores.map((s) => s.id)) };
  }
  return cache;
}

/** Re-check stock live for the given products (grouped per store), update the DB, report per id. */
async function verify(ids: string[]) {
  const products = productsByIds(db, ids.slice(0, 40));
  const stores = new Map(allStores(db).map((s) => [s.id, s]));
  const byStore = new Map<string, Product[]>();
  for (const p of products) (byStore.get(p.storeId) ?? byStore.set(p.storeId, []).get(p.storeId)!).push(p);
  const results: Record<string, { inStock: boolean; qty: number | null; price: number | null; salePrice: number | null; changed: boolean } | { error: string }> = {};
  // Different operators run in parallel; stores of the same operator queue on the polite per-host limiter.
  await Promise.all([...byStore].map(async ([storeId, prods]) => {
    const store = stores.get(storeId);
    const scraper = store && getScraper(store.operator);
    if (!store || !scraper?.checkStock) { for (const p of prods) results[p.id] = { error: 'live check not supported' }; return; }
    try {
      const fresh = await scraper.checkStock(store, prods);
      applyStockCheck(db, fresh);
      for (const p of prods) {
        const f = fresh.get(p.id) ?? null;
        results[p.id] = {
          inStock: !!f, qty: f?.qtyAvailable ?? 0, price: f?.price ?? null, salePrice: f?.salePrice ?? null,
          changed: !f || f.price !== p.price || f.salePrice !== p.salePrice || f.qtyAvailable !== p.qtyAvailable,
        };
      }
    } catch (e) {
      for (const p of prods) results[p.id] = { error: (e as Error).message };
    }
  }));
  for (const id of ids) if (!results[id]) results[id] = { inStock: false, qty: 0, price: null, salePrice: null, changed: true };
  cache = null; // products changed → rebuild snapshot on next search
  return { checkedAt: new Date().toISOString(), results };
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

createServer(async (req, res) => {
  const u = new URL(req.url ?? '/', 'http://localhost');
  try {
    if (u.pathname === '/api/verify') {
      const ids = (u.searchParams.get('ids') ?? '').split(',').filter(Boolean);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(await verify(ids)));
      return;
    }
    if (u.pathname.startsWith('/api/')) {
      const r = route(u.pathname, u.searchParams, snapshot(), zipToLatLng, { maxAgeHours: MAX_MENU_AGE_HOURS, nearestZip });
      res.writeHead(r.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(r.body));
      return;
    }
    const rel = normalize(u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname.slice(1)));
    if (rel.startsWith('..')) throw Object.assign(new Error('bad path'), { code: 'ENOENT' });
    const file = join(PUBLIC_DIR, rel);
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch (e: any) {
    res.writeHead(e?.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain' });
    res.end(e?.code === 'ENOENT' ? 'Not found' : `Error: ${e?.message}`);
  }
}).listen(PORT, () => console.log(`FL Deal Finder on http://localhost:${PORT}`));
