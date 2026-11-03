// API handlers as pure functions over a data snapshot — shared by the Node server and the static demo build.
import { parseQuery } from './query.ts';
import { haversineMi, search } from './engine.ts';
import { openStatus } from './hours.ts';
import type { PlanSortKey, SearchParams, SortKey } from './engine.ts';
import { CATEGORIES } from './types.ts';
import type { Category, Product, Store } from './types.ts';

export interface Snapshot { stores: Store[]; products: Product[] }
export type ZipLookup = (zip: string) => { lat: number; lng: number } | null;
export interface ApiResponse { status: number; body: any }

const list = (v: string | null) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);
const numOrNull = (v: string | null) => (v === null || v === '' || isNaN(Number(v)) ? null : Number(v));

function parseTarget(v: string | null): SearchParams['target'] {
  if (!v) return null;
  const t = parseQuery(v).target;
  if (t) return t;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? { amount: n, unit: 'g' } : null;
}

export interface ApiOptions {
  maxAgeHours?: number | null;
  /** Nearest Florida ZIP centroid to a point (for "use my location"). */
  nearestZip?: (lat: number, lng: number) => { zip: string; distanceMi: number } | null;
}

export function searchApi(qp: URLSearchParams, data: Snapshot, zipLookup: ZipLookup, opts: ApiOptions = {}): ApiResponse {
  const parsed = parseQuery(qp.get('q') ?? '');
  const zip = (qp.get('zip') ?? '').trim();
  const center = zip ? zipLookup(zip) : null;
  if (zip && !center) return { status: 400, body: { error: `Unknown Florida ZIP: ${zip}` } };

  const cats = list(qp.get('category')).filter((c): c is Category => (CATEGORIES as string[]).includes(c));
  const sp: SearchParams = {
    text: parsed.text,
    categories: cats.length ? cats : parsed.categories,
    strainTypes: list(qp.get('strainType')).length ? list(qp.get('strainType')) : parsed.strainTypes,
    subcategory: qp.get('subcategory') || undefined,
    minThc: numOrNull(qp.get('minThc')) ?? parsed.minThc,
    maxThc: numOrNull(qp.get('maxThc')) ?? parsed.maxThc,
    maxPrice: numOrNull(qp.get('maxPrice')) ?? parsed.maxPrice,
    minSize: numOrNull(qp.get('minSize')),
    maxSize: numOrNull(qp.get('maxSize')),
    sizes: list(qp.get('sizes')).map(Number).filter((n) => n > 0),
    target: qp.get('target') ? parseTarget(qp.get('target')) : parsed.target,
    operators: list(qp.get('operators')),
    storeIds: list(qp.get('stores')),
    onlyStoreIds: qp.get('only') === '1',
    center,
    radiusMi: center ? (qp.get('radius') === 'any' ? null : (numOrNull(qp.get('radius')) ?? 25)) : null,
    sort: (qp.get('sort') as SortKey) || 'unit',
    planSort: (qp.get('planSort') as PlanSortKey) || 'price',
    limit: Math.min(500, numOrNull(qp.get('limit')) ?? 100),
    includeMixPlans: qp.get('mix') !== '0',
    excludeShake: qp.get('whole') === '1',
    saleOnly: qp.get('sale') === '1',
    openNow: qp.get('open') === '1',
    maxAgeHours: opts.maxAgeHours ?? null,
  };
  const result = search(data.stores, data.products, sp);
  // Open/closed label for every store that appears in the results (computed in the store's time zone).
  const storeStatus: Record<string, ReturnType<typeof openStatus>> = {};
  const now = new Date();
  const note = (s: Store) => { if (!(s.id in storeStatus)) storeStatus[s.id] = openStatus(s, now); };
  for (const p of result.plans) { note(p.store); for (const a of p.alsoAt ?? []) note(a.store); }
  for (const h of result.products) note(h.store);
  const { center: _c, now: _n, ...interpreted } = sp;
  return { status: 200, body: { interpreted, center, result: { ...result, storeStatus } } };
}

export function storesApi(qp: URLSearchParams, data: Snapshot, zipLookup: ZipLookup): ApiResponse {
  const zip = (qp.get('zip') ?? '').trim();
  const center = zip ? zipLookup(zip) : null;
  const radius = numOrNull(qp.get('radius'));
  const counts = new Map<string, number>();
  for (const p of data.products) counts.set(p.storeId, (counts.get(p.storeId) ?? 0) + 1);
  const stores = data.stores
    .map((s) => ({ ...s, productCount: counts.get(s.id) ?? 0, distanceMi: center ? haversineMi(center.lat, center.lng, s.lat, s.lng) : null }))
    .filter((s) => radius == null || s.distanceMi == null || s.distanceMi <= radius)
    .sort((a, b) => (a.distanceMi ?? 0) - (b.distanceMi ?? 0) || a.name.localeCompare(b.name));
  return { status: 200, body: { center, stores } };
}

export function metaApi(data: Snapshot): ApiResponse {
  const operators = new Map<string, { key: string; name: string; stores: number; withMenus: number }>();
  for (const s of data.stores) {
    const o = operators.get(s.operator) ?? { key: s.operator, name: s.operatorName, stores: 0, withMenus: 0 };
    o.stores++;
    if (s.lastScrapedAt) o.withMenus++;
    operators.set(s.operator, o);
  }
  const scraped = data.stores.map((s) => s.lastScrapedAt).filter(Boolean).sort() as string[];
  return {
    status: 200,
    body: {
      operators: [...operators.values()],
      categories: CATEGORIES,
      productCount: data.products.length,
      oldestScrape: scraped[0] ?? null,
      newestScrape: scraped[scraped.length - 1] ?? null,
    },
  };
}

export function route(path: string, qp: URLSearchParams, data: Snapshot, zipLookup: ZipLookup, opts: ApiOptions = {}): ApiResponse {
  if (path === '/api/search') return searchApi(qp, data, zipLookup, opts);
  if (path === '/api/stores') return storesApi(qp, data, zipLookup);
  if (path === '/api/meta') return metaApi(data);
  if (path === '/api/nearzip') {
    const lat = Number(qp.get('lat')), lng = Number(qp.get('lng'));
    const hit = Number.isFinite(lat) && Number.isFinite(lng) ? opts.nearestZip?.(lat, lng) : null;
    if (!hit) return { status: 400, body: { error: 'Could not find a nearby ZIP code.' } };
    if (hit.distanceMi > 25) return { status: 400, body: { error: 'Your location looks to be outside Florida. Enter a Florida ZIP code instead.' } };
    return { status: 200, body: hit };
  }
  return { status: 404, body: { error: 'not found' } };
}
