// Deal engine — pure functions over stores + products (runs on the server or in the browser).
//
//  search()  → filtered, ranked product list + "buy plans" that reach a target amount
//  A buy plan answers: "cheapest way to get ≥ 56 g at one store", either
//    - single: one product (same strain/brand) in whichever sizes are cheapest, e.g. 4 × 14g
//    - mix:    any combination of matching products at that store
import type { Category, Product, ProductHit, Store } from './types.ts';
import { isOpenNow } from './hours.ts';

export type SortKey = 'unit' | 'price' | 'thcValue' | 'thc' | 'distance';
export type PlanSortKey = 'price' | 'thcValue' | 'distance';

export interface SearchParams {
  text?: string;
  categories?: Category[];
  strainTypes?: string[];
  subcategory?: string;
  minThc?: number | null;
  maxThc?: number | null;           // for milder products; uses the highest in-stock batch
  maxPrice?: number | null;
  minSize?: number | null;          // package size bounds, in the product's unit
  maxSize?: number | null;
  sizes?: number[];                 // exact allowed package sizes (e.g. [14, 28])
  target?: { amount: number; unit: 'g' | 'mg' } | null;
  operators?: string[];             // dispensary brand keys, e.g. ["muv","trulieve"]
  storeIds?: string[];              // specific stores to include (even outside radius)
  onlyStoreIds?: boolean;           // search ONLY storeIds
  center?: { lat: number; lng: number } | null;
  radiusMi?: number | null;
  sort?: SortKey;
  planSort?: PlanSortKey;
  limit?: number;
  planLimit?: number;
  includeMixPlans?: boolean;
  excludeShake?: boolean;           // drop shake / ground / trim / popcorn flower
  saleOnly?: boolean;               // only items with a sale price right now
  openNow?: boolean;                // only stores open right now (known hours)
  /** Ignore product data older than this (stock may have changed). null = no limit (static demo). */
  maxAgeHours?: number | null;
  now?: number;                     // for tests
}

export interface PlanLine { product: ProductHit; qty: number }

export interface BuyPlan {
  kind: 'single' | 'mix';
  store: Store;
  distanceMi: number | null;
  title: string;
  summary: string;           // "4 × 14g"
  lines: PlanLine[];
  totalAmount: number;
  unit: 'g' | 'mg';
  totalPrice: number;
  pricePerUnit: number;
  overshoot: number;         // amount above target
  thcRange: [number, number] | null;
  pricePerMgThc: number | null;
  /** Other stores (same chain) offering the identical plan at the identical price. */
  alsoAt?: Array<{ store: Store; distanceMi: number | null }>;
  /** Other strains of the same brand/size/price at the same store — "pick any of these". */
  alternatives?: Array<{ name: string; strain: string; thcPct: number | null; url: string }>;
}

export interface SearchResult {
  storesSearched: number;
  storesWithoutMenus: Store[];
  /** Stores whose menu data was too old to trust stock levels, so they were left out. */
  storesStale: Store[];
  totalMatches: number;
  products: ProductHit[];
  plans: BuyPlan[];
}

const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

export function haversineMi(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 3958.8, r = Math.PI / 180;
  const dLat = (bLat - aLat) * r, dLng = (bLng - aLng) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Pick stores by radius/operator filter, plus explicitly chosen stores. */
export function selectStores(stores: Store[], p: SearchParams): Array<{ store: Store; distanceMi: number | null }> {
  const explicit = new Set(p.storeIds ?? []);
  const ops = p.operators?.length ? new Set(p.operators) : null;
  const now = new Date(p.now ?? Date.now());
  const out: Array<{ store: Store; distanceMi: number | null }> = [];
  for (const s of stores) {
    if (p.openNow && !isOpenNow(s, now)) continue;
    const d = p.center ? haversineMi(p.center.lat, p.center.lng, s.lat, s.lng) : null;
    let keep: boolean;
    if (explicit.has(s.id)) keep = true;
    else if (p.onlyStoreIds) keep = false;
    else keep = (!ops || ops.has(s.operator)) && (d === null || p.radiusMi == null || d <= p.radiusMi);
    if (keep) out.push({ store: s, distanceMi: d });
  }
  return out;
}

/** Price you'd pay: the sale price while its promo is running, otherwise the regular price. */
export function effectivePrice(p: Product, now: number = Date.now()): number {
  if (p.saleEndsAt && Date.parse(p.saleEndsAt) <= now) return p.price;
  return p.salePrice != null && p.salePrice > 0 && p.salePrice < p.price ? p.salePrice : p.price;
}

function thcMgOf(p: Product): number | null {
  if (p.thcMg != null) return p.thcMg;
  if (p.amountUnit === 'g' && p.amount && p.thcPct != null) return p.amount * 1000 * (p.thcPct / 100);
  return null;
}

export function enrich(p: Product, store: Store, distanceMi: number | null, now: number = Date.now()): ProductHit {
  const eff = effectivePrice(p, now);
  const mg = thcMgOf(p);
  return {
    ...p,
    store,
    distanceMi,
    effectivePrice: eff,
    pricePerUnit: p.amount ? eff / p.amount : null,
    pricePerMgThc: mg ? eff / mg : null,
  };
}

const near = (a: number, b: number) => Math.abs(a - b) < 0.051;

/** In stock = a known, positive quantity. Unknown stock is treated as not available. */
export function inStock(p: Product): boolean {
  return p.qtyAvailable != null && p.qtyAvailable >= 1;
}

export function matches(p: Product, store: Store, sp: SearchParams): boolean {
  if (!inStock(p)) return false;
  if (sp.categories?.length && !sp.categories.includes(p.category)) return false;
  if (sp.strainTypes?.length) {
    const st = p.strainType || '';
    if (!sp.strainTypes.some((t) => st.startsWith(t) || (t === 'hybrid' && st.includes('dominant')))) return false;
  }
  if (sp.subcategory && !fold(p.subcategory).includes(fold(sp.subcategory))) return false;
  if (sp.excludeShake && /shake|ground|trim|popcorn|smalls/i.test(`${p.subcategory} ${p.name}`)) return false;
  if (sp.minThc != null) {
    if (p.thcPct == null || p.thcPct < sp.minThc) return false;
  }
  if (sp.maxThc != null) {
    const hi = p.thcPctMax ?? p.thcPct;
    if (hi == null || hi > sp.maxThc) return false;
  }
  const eff = effectivePrice(p, sp.now ?? Date.now());
  if (sp.maxPrice != null && eff > sp.maxPrice) return false;
  if (sp.saleOnly && !(eff < p.price - 0.005)) return false;
  if (sp.target && (p.amountUnit !== sp.target.unit || !p.amount)) return false;
  if (sp.sizes?.length && !(p.amount && sp.sizes.some((s) => near(s, p.amount!)))) return false;
  if (sp.minSize != null && !(p.amount && p.amount >= sp.minSize - 1e-9)) return false;
  if (sp.maxSize != null && !(p.amount && p.amount <= sp.maxSize + 1e-9)) return false;
  if (sp.text) {
    const hay = fold(`${p.name} ${p.brand} ${p.strain} ${p.subcategory} ${p.strainType} ${store.operatorName} ${store.operator} ${store.name}`);
    for (const tok of fold(sp.text).split(/\s+/).filter(Boolean)) if (!hay.includes(tok)) return false;
  }
  return true;
}

const SORTERS: Record<SortKey, (a: ProductHit, b: ProductHit) => number> = {
  unit: (a, b) => (a.pricePerUnit ?? Infinity) - (b.pricePerUnit ?? Infinity) || a.effectivePrice - b.effectivePrice,
  price: (a, b) => a.effectivePrice - b.effectivePrice,
  thcValue: (a, b) => (a.pricePerMgThc ?? Infinity) - (b.pricePerMgThc ?? Infinity),
  thc: (a, b) => (b.thcPct ?? -1) - (a.thcPct ?? -1),
  distance: (a, b) => (a.distanceMi ?? Infinity) - (b.distanceMi ?? Infinity) || (a.pricePerUnit ?? Infinity) - (b.pricePerUnit ?? Infinity),
};

// ---------------------------------------------------------------------------
// Min-cost cover: choose quantities of items (size s_i, price p_i, stock q_i) so that
// Σ qty·s ≥ target with minimal Σ qty·p. Bounded knapsack via binary splitting.
// Among equal-cost solutions, the one with the least overshoot wins.
// ---------------------------------------------------------------------------
export interface CoverItem { size: number; price: number; stock: number }

export function minCostCover(items: CoverItem[], target: number, resolution: number): { qty: number[]; amount: number; cost: number } | null {
  const valid = items.map((it, i) => ({ ...it, i })).filter((it) => it.size > 0 && it.price >= 0 && it.stock > 0);
  if (!valid.length) return null;
  const T = Math.ceil(target / resolution - 1e-9);
  const sizes = valid.map((it) => Math.max(1, Math.round(it.size / resolution)));
  const maxS = Math.max(...sizes);
  const cap = T + maxS - 1;

  // binary-split pieces
  const pieces: Array<{ item: number; mult: number; w: number; c: number }> = [];
  valid.forEach((it, k) => {
    let remaining = Math.min(it.stock, Math.ceil(T / sizes[k]));
    let m = 1;
    while (remaining > 0) {
      const take = Math.min(m, remaining);
      pieces.push({ item: k, mult: take, w: sizes[k] * take, c: it.price * take });
      remaining -= take;
      m *= 2;
    }
  });

  const INF = Number.POSITIVE_INFINITY;
  const dp = new Float64Array(cap + 1).fill(INF);
  dp[0] = 0;
  const took: Uint8Array[] = [];
  for (const pc of pieces) {
    const t = new Uint8Array(cap + 1);
    for (let c = cap; c >= pc.w; c--) {
      const v = dp[c - pc.w] + pc.c;
      if (v < dp[c] - 1e-9) { dp[c] = v; t[c] = 1; }
    }
    took.push(t);
  }
  let best = -1;
  for (let c = T; c <= cap; c++) if (dp[c] < INF && (best < 0 || dp[c] < dp[best] - 1e-9)) best = c;
  if (best < 0) return null;

  const qty = new Array(items.length).fill(0);
  let c = best;
  for (let k = pieces.length - 1; k >= 0; k--) {
    if (took[k][c]) { qty[valid[pieces[k].item].i] += pieces[k].mult; c -= pieces[k].w; }
  }
  const amount = items.reduce((s, it, i) => s + it.size * qty[i], 0);
  return { qty, amount, cost: dp[best] };
}

function fmtAmount(n: number, unit: string) {
  const v = Math.round(n * 100) / 100;
  return `${v}${unit}`;
}

function buildPlan(kind: BuyPlan['kind'], hits: ProductHit[], target: { amount: number; unit: 'g' | 'mg' }, resolution: number): BuyPlan | null {
  const res = minCostCover(
    hits.map((h) => ({ size: h.amount!, price: h.effectivePrice, stock: Math.floor(h.qtyAvailable ?? 0) })),
    target.amount,
    resolution,
  );
  if (!res) return null;
  const lines = hits.map((h, i) => ({ product: h, qty: res.qty[i] })).filter((l) => l.qty > 0)
    .sort((a, b) => b.product.amount! - a.product.amount!);
  const thcs = lines.map((l) => l.product.thcPct).filter((x): x is number => x != null);
  const mgTotal = lines.reduce((s, l) => {
    const per = l.product.pricePerMgThc != null ? l.product.effectivePrice / l.product.pricePerMgThc : null;
    return per == null ? s : s + per * l.qty;
  }, 0);
  const first = lines[0].product;
  const names = [...new Set(lines.map((l) => l.product.name))];
  return {
    kind,
    store: first.store,
    distanceMi: first.distanceMi,
    title: kind === 'single' ? `${first.name}${first.brand ? ` · ${first.brand}` : ''}` : names.length === 1 ? names[0] : `${names.length} products`,
    summary: lines.map((l) => `${l.qty} × ${fmtAmount(l.product.amount!, target.unit)}${kind === 'mix' && names.length > 1 ? ` ${l.product.name}` : ''}`).join(' + '),
    lines,
    totalAmount: res.amount,
    unit: target.unit,
    totalPrice: Math.round(res.cost * 100) / 100,
    pricePerUnit: res.cost / res.amount,
    overshoot: Math.max(0, res.amount - target.amount),
    thcRange: thcs.length ? [Math.min(...thcs), Math.max(...thcs)] : null,
    pricePerMgThc: mgTotal > 0 ? res.cost / mgTotal : null,
  };
}

export function buildPlans(hits: ProductHit[], target: { amount: number; unit: 'g' | 'mg' }, includeMix = true): BuyPlan[] {
  const resolution = target.unit === 'g' ? 0.05 : 1;
  const plans: BuyPlan[] = [];
  const byGroup = new Map<string, ProductHit[]>();
  const byStore = new Map<string, ProductHit[]>();
  for (const h of hits) {
    if (!h.amount) continue;
    (byGroup.get(h.groupKey) ?? byGroup.set(h.groupKey, []).get(h.groupKey)!).push(h);
    (byStore.get(h.storeId) ?? byStore.set(h.storeId, []).get(h.storeId)!).push(h);
  }
  for (const group of byGroup.values()) {
    const p = buildPlan('single', group, target, resolution);
    if (p) plans.push(p);
  }
  if (includeMix) {
    const bestSingle = new Map<string, number>();
    for (const p of plans) bestSingle.set(p.store.id, Math.min(bestSingle.get(p.store.id) ?? Infinity, p.totalPrice));
    for (const storeHits of byStore.values()) {
      // Keep the DP small: cheapest-per-unit 60 items are plenty to find the optimum in practice.
      const top = [...storeHits].sort((a, b) => a.pricePerUnit! - b.pricePerUnit!).slice(0, 60);
      const p = buildPlan('mix', top, target, resolution);
      // Only worth showing when mixing products beats buying a single product at that store.
      if (p && new Set(p.lines.map((l) => l.product.groupKey)).size > 1
        && p.totalPrice < (bestSingle.get(p.store.id) ?? Infinity) - 0.01) plans.push(p);
    }
  }
  return plans.sort((a, b) => a.totalPrice - b.totalPrice || a.overshoot - b.overshoot || (a.distanceMi ?? 0) - (b.distanceMi ?? 0));
}

export function search(stores: Store[], products: Product[], sp: SearchParams): SearchResult {
  const selected = selectStores(stores, sp);
  const byId = new Map(selected.map((x) => [x.store.id, x]));
  const cutoff = sp.maxAgeHours != null ? (sp.now ?? Date.now()) - sp.maxAgeHours * 3600_000 : null;
  const staleStores = new Set<string>();
  const freshStores = new Set<string>();
  const hits: ProductHit[] = [];
  for (const p of products) {
    const sel = byId.get(p.storeId);
    if (!sel) continue;
    if (cutoff !== null && !(Date.parse(p.scrapedAt) >= cutoff)) { staleStores.add(p.storeId); continue; }
    freshStores.add(p.storeId);
    if (!matches(p, sel.store, sp)) continue;
    hits.push(enrich(p, sel.store, sel.distanceMi, sp.now ?? Date.now()));
  }
  const sorted = hits.sort(SORTERS[sp.sort ?? 'unit']);
  const plans = sp.target ? sortPlans(buildPlans(hits, sp.target, sp.includeMixPlans ?? true), sp.planSort ?? 'price') : [];
  return {
    storesSearched: selected.filter((x) => x.store.menuSupported && (cutoff === null || freshStores.has(x.store.id))).length,
    storesWithoutMenus: selected.filter((x) => !x.store.menuSupported).map((x) => x.store),
    storesStale: selected.filter((x) => x.store.menuSupported && !freshStores.has(x.store.id)
      && (cutoff === null ? false : staleStores.has(x.store.id) || !x.store.lastScrapedAt)).map((x) => x.store),
    totalMatches: sorted.length,
    products: sorted.slice(0, sp.limit ?? 100),
    plans: groupAlternatives(dedupePlans(plans)).slice(0, sp.planLimit ?? 25),
  };
}

/** Merge single-product plans that differ only by strain (same store, brand, sizes, price) into one card. */
function groupAlternatives(plans: BuyPlan[]): BuyPlan[] {
  const groups = new Map<string, BuyPlan[]>();
  const order: string[] = [];
  for (const p of plans) {
    const brand = p.lines[0]?.product.brand ?? '';
    const k = p.kind === 'single' ? `${p.store.id}|${brand}|${p.lines[0]?.product.subcategory}|${p.summary}|${p.totalPrice}` : `mix|${order.length}`;
    if (!groups.has(k)) { groups.set(k, []); order.push(k); }
    groups.get(k)!.push(p);
  }
  return order.map((k) => {
    const g = groups.get(k)!;
    if (g.length === 1) return g[0];
    g.sort((a, b) => (b.thcRange?.[0] ?? -1) - (a.thcRange?.[0] ?? -1));
    const [head, ...rest] = g;
    head.alternatives = rest.map((r) => ({
      name: r.lines[0].product.name, strain: r.lines[0].product.strain,
      thcPct: r.lines[0].product.thcPct, url: r.lines[0].product.url,
    }));
    return head;
  });
}

function sortPlans(plans: BuyPlan[], key: PlanSortKey): BuyPlan[] {
  if (key === 'thcValue') return plans.sort((a, b) => (a.pricePerMgThc ?? Infinity) - (b.pricePerMgThc ?? Infinity) || a.totalPrice - b.totalPrice);
  if (key === 'distance') return plans.sort((a, b) => (a.distanceMi ?? Infinity) - (b.distanceMi ?? Infinity) || a.totalPrice - b.totalPrice);
  return plans;
}

/** The same chain often has identical plans at many stores; keep each (title, summary, price) once — nearest store. */
function dedupePlans(plans: BuyPlan[]): BuyPlan[] {
  const seen = new Map<string, BuyPlan>();
  const out: BuyPlan[] = [];
  for (const p of plans) {
    const k = `${p.store.operator}|${p.kind}|${p.title}|${p.summary}|${p.totalPrice}`;
    const prev = seen.get(k);
    if (!prev) { p.alsoAt = []; seen.set(k, p); out.push(p); continue; }
    if ((p.distanceMi ?? Infinity) < (prev.distanceMi ?? Infinity)) {
      // keep the nearest store as the headline
      prev.alsoAt!.push({ store: prev.store, distanceMi: prev.distanceMi });
      prev.store = p.store; prev.distanceMi = p.distanceMi; prev.lines = p.lines;
    } else {
      prev.alsoAt!.push({ store: p.store, distanceMi: p.distanceMi });
    }
  }
  return out;
}
