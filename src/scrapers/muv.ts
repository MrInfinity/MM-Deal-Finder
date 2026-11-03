// MÜV (Verano) — menus run on the Sweed platform. Store list (with Sweed store ids and
// coordinates) is embedded in muvfl.com/shop; menus come from Sweed's product-list API,
// which is what the muvfl.com menu pages call.
import type { Category, Product, Store } from '../types.ts';
import type { OperatorScraper } from './types.ts';
import { getJson, getText } from './http.ts';
import { cleanText, makeGroupKey, normalizeCategory, normalizeStrainType, num, pct } from '../normalize.ts';
import { DAYS, emptyWeek, to24h, zonedToUtc } from '../hours.ts';

/** When a Sweed promo stops: its end date + the end of its time window, Florida local time. */
export function promoEndsAt(promo: any, timeZone = 'America/New_York'): string | null {
  if (!promo?.endDate) return null; // open-ended ("Daily") promos
  const date = String(promo.endDate).slice(0, 10);
  const end = Array.isArray(promo.interval) && /^\d\d:\d\d$/.test(promo.interval[1]) ? promo.interval[1] : '23:59';
  return zonedToUtc(date, end, timeZone);
}

const DAY_NAMES: Record<string, string> = { sun: 'sunday', mon: 'monday', tue: 'tuesday', wed: 'wednesday', thu: 'thursday', fri: 'friday', sat: 'saturday' };
function muvHours(h: any) {
  if (!h) return null;
  const w = emptyWeek();
  let any = false;
  for (const d of DAYS) {
    const x = h[DAY_NAMES[d]];
    if (!x || !x.open || !x.closed) continue; // missing = closed that day
    const o = to24h(x.open), c = to24h(x.closed);
    if (!o || !c) return null;
    w[d] = [[o, c]];
    any = true;
  }
  return any ? w : null;
}

const SITE = 'https://muvfl.com';
const SWEED_API = 'https://sweed.app/_api/proxy/Products/GetProductList';
const SWEED_PROMOS = 'https://sweed.app/_api/proxy/Products/GetPromotionsList';

/** The store's promotion schedule (start/end dates and times) — the product list omits them. */
async function loadPromoSchedule(sweedId: string): Promise<Map<number, any>> {
  try {
    const list = await getJson(SWEED_PROMOS, {
      method: 'POST',
      headers: { Storeid: sweedId, SaleType: 'Medical' },
      body: { platformOs: 'Web', saleType: 'Medical' },
    });
    return new Map((Array.isArray(list) ? list : []).map((x: any) => [x.id, x]));
  } catch { return new Map(); }
}

/** Decode the React Server Components payload strings embedded in a Next.js app-router page. */
export function decodeRscPayload(html: string): string {
  const out: string[] = [];
  const re = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    try { out.push(JSON.parse(m[1])); } catch { /* skip malformed chunk */ }
  }
  return out.join('');
}

/** Find `"key":[ ... ]` in text and JSON-parse the bracket-balanced array. */
export function extractJsonArray(text: string, key: string): any[] | null {
  const i = text.indexOf(`"${key}":[`);
  if (i < 0) return null;
  const start = text.indexOf('[', i);
  let depth = 0, inStr = false, esc = false;
  for (let k = start; k < text.length; k++) {
    const ch = text[k];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '[') depth++;
    else if (ch === ']' && --depth === 0) return JSON.parse(text.slice(start, k + 1));
  }
  return null;
}

/**
 * The site maps store slugs to Sweed store ids in a static JSON table bundled into one of its
 * JS chunks (`[{"id":"279","slug":"apollo-beach","geoState":"florida",...}]`). The CMS field
 * `medicalStoreId` is NOT the Sweed id, so we read the same table the site uses.
 */
async function loadSweedIdMap(shopHtml: string): Promise<Map<string, string>> {
  const chunkUrls = [...new Set(shopHtml.match(/\/_next\/static\/chunks\/[\w.-]+\.js/g) ?? [])];
  for (const path of chunkUrls) {
    const js = await getText(`${SITE}${path}`).catch(() => '');
    if (!js.includes('"geoState":"florida"')) continue;
    for (const m of js.matchAll(/JSON\.parse\('(\[\{"id"[\s\S]*?)'\)/g)) {
      let arr: any[];
      try {
        arr = JSON.parse(`"${m[1].replace(/\\'/g, "'").replace(/"/g, '\\"')}"`);
        arr = JSON.parse(arr as unknown as string);
      } catch { continue; }
      const fl = arr.filter((x) => x.geoState === 'florida');
      if (fl.length) return new Map(fl.map((x) => [x.slug, String(x.id)]));
    }
  }
  throw new Error('MÜV: could not find slug→Sweed store id table in site bundles');
}

/**
 * Product page URL, ported from muvfl.com's own buildProductUrl / buildProductNameDisplayUrl:
 *   /locations/<store>/menu/menu/<category name>-<category id>/<name slug>-<variant id>
 * e.g. /locations/apollo-beach/menu/menu/flower-3485/the-essence-minty-blizzard-whole-flower-3.5g-518320
 */
export function muvProductPath(storeSlug: string, p: any, v: any): string {
  const brand = p?.brand?.name || '', name = p?.name || '', productType = p?.productType?.name || '';
  const cat = p?.category?.name || '', catSingular = cat.endsWith('s') ? cat.slice(0, -1) : cat;
  const quality = p?.qualityLine?.name || '', sub = p?.subcategory?.name || '';
  let variant = v?.name || '';
  let n = '';
  if (brand) n += brand;
  if (quality) n += ` ${quality}`;
  if (name) n += ` ${name}`;
  if (productType) n += ` ${productType}`;
  if (!productType.includes(sub)) n += ` ${sub}`;
  if (!(productType.includes(catSingular) || productType.includes(cat) || sub.includes(catSingular) || sub.includes(cat)
    || ['Accessories', 'Apparel'].includes(cat))) n += ` ${catSingular}`;
  if (variant) {
    if (variant.includes(productType)) variant = variant.replace(productType, '');
    if (variant.includes(sub)) variant = variant.replace(sub, '');
    if (variant.includes(cat)) variant = variant.replace(cat, '');
    if (variant.includes(catSingular)) variant = variant.replace(catSingular, '');
    n += `, ${variant.replace(/ \[(.*?)\]/g, ', $1')}`;
  }
  const slug = n.trim().replace(/[^a-zA-Z0-9\s\-.]/g, '').replace(/ /g, '-').replace(/-{2,}/g, '-').toLowerCase();
  const catPath = `${cat.toLowerCase().replace(/ /g, '-')}-${p?.category?.id ?? ''}`;
  return `/locations/${storeSlug}/menu/menu/${catPath}/${slug}-${v?.id ?? ''}`;
}

function sweedCategory(cat: string, sub: string, name: string): Category {
  const c = `${cat} ${sub}`.toLowerCase();
  if (/pre-?roll/.test(c)) return 'pre-roll';
  if (/cartridge|vape|all in one|pod|disposable/.test(c)) return 'vape';
  if (/flower/.test(c)) return 'flower';
  if (/concentrate/.test(c)) return 'concentrate';
  if (/edible/.test(c)) return 'edible';
  if (/oral|tincture|capsule|sublingual/.test(c)) return 'oral';
  if (/topical/.test(c)) return 'topical';
  if (/accessor|merch|gear/.test(c)) return 'other';
  return normalizeCategory(cat, sub, name);
}

function variantToProduct(store: Store, p: any, v: any, scrapedAt: string, promoNames: Map<number, string>, promoInfo: Map<number, any> = new Map()): Product | null {
  const price = num(v.price);
  if (!price || price <= 0) return null;
  // In-stock checks: a positive stock count is required, and Sweed must say it can be ordered.
  const qty = num(v.availableQty);
  if (qty === null || qty <= 0) return null;
  const reason = v.orderingAvailability?.reason;
  if (reason && reason !== 'Available') return null;
  if (/out.?of.?stock|unavailable/i.test(String(v.stockType ?? ''))) return null;

  const catName = cleanText(p.category?.name);
  const subName = cleanText(p.subcategory?.name);
  const category = sweedCategory(catName, subName, p.name);
  if (category === 'other' && /accessor/i.test(catName)) return null; // skip batteries, glass, etc.

  const unitAbbr = String(v.unitSize?.unitAbbr ?? '').toUpperCase();
  const unitVal = num(v.unitSize?.value);
  const units = Math.max(1, num(v.unitsInPackage) ?? 1);
  const thc = v.labTests?.thc;
  const thcVals: number[] = Array.isArray(thc?.value) ? thc.value.map(Number).filter(Number.isFinite) : [];
  const thcIsPct = thc?.unitAbbr === '%';
  const thcIsMg = String(thc?.unitAbbr ?? '').toUpperCase() === 'MG';

  let amount: number | null = null;
  let amountUnit: Product['amountUnit'] = 'each';
  let thcMg: number | null = null;
  if ((category === 'edible' || category === 'oral') && (thcIsMg || unitAbbr === 'MG')) {
    // Infused products: measure by total mg THC in the package.
    thcMg = thcIsMg && thcVals.length ? Math.max(...thcVals) : unitVal !== null ? unitVal * units : null;
    amount = unitAbbr === 'MG' && unitVal !== null ? unitVal * units : thcMg;
    amountUnit = 'mg';
  } else if (unitAbbr === 'G' && unitVal !== null) {
    amount = unitVal * units; // e.g. 0.5 g x 5 pre-rolls = 2.5 g
    amountUnit = 'g';
  } else if (unitAbbr === 'ML' && unitVal !== null) {
    amount = unitVal * units;
    amountUnit = 'ml';
  }

  const promos: any[] = v.promos ?? [];
  // Conditional promos (min cart, user segment) aren't guaranteed, so don't count them as the price.
  const conditional = promos.some((x) => x?.isConditional || x?.minCartAmount || x?.matchedUserSegmentIds?.length);
  const info = promos.map((x) => ({ ...x, ...promoInfo.get(x?.id) }));
  const inactive = info.length > 0 && info.every((x) => x?.isActiveBySchedule === false);
  const promo = conditional || inactive ? null : num(v.promoPrice);
  // Which applied promo set the price isn't stated, so use the earliest end: never show a sale price
  // after it may have expired (the next refresh restores it if another promo still applies).
  const ends = info.map((x) => (x?.endDate ? promoEndsAt(x) : null)).filter((x): x is string => !!x).sort();
  const saleEndsAt = promo && ends.length ? ends[0] : null;
  const promoEnds: Record<string, string> = {};
  for (const x of info) {
    const nm = cleanText(promoNames.get(x?.id) || x?.name || '');
    const e = x?.endDate ? promoEndsAt(x) : null;
    if (nm && e) promoEnds[nm] = e;
  }
  const promoText = promos.map((x) => promoNames.get(x?.id) || x?.name || x?.shortName).filter(Boolean).join(' · ');
  const name = cleanText(p.customName || p.name);
  const brand = cleanText(p.brand?.name);

  return {
    id: `${store.id}:${v.id}`,
    storeId: store.id,
    name,
    brand,
    strain: cleanText(p.strain?.name),
    strainType: normalizeStrainType(p.strain?.prevalence?.name),
    category,
    subcategory: subName,
    amount,
    amountUnit,
    packCount: units,
    thcPct: thcIsPct && thcVals.length ? pct(Math.min(...thcVals)) : null,
    thcPctMax: thcIsPct && thcVals.length ? pct(Math.max(...thcVals)) : null,
    thcMg,
    cbdPct: v.labTests?.cbd?.unitAbbr === '%' ? pct(v.labTests.cbd.value?.[0]) : null,
    price,
    salePrice: promo && promo > 0 && promo < price ? promo : null,
    promo: cleanText(promoText) + (conditional ? ' (conditional)' : ''),
    saleEndsAt,
    promoEnds: Object.keys(promoEnds).length ? promoEnds : undefined,
    qtyAvailable: qty,
    url: `${SITE}${muvProductPath(store.platformStoreId.split('#')[1] ?? '', p, v)}`,
    image: v.images?.[0] ?? p.images?.[0] ?? '',
    groupKey: makeGroupKey(store.id, brand, name, subName),
    scrapedAt,
  };
}

export const muv: OperatorScraper = {
  key: 'muv',
  name: 'MÜV',

  async listStores() {
    const html = await getText(`${SITE}/shop`);
    const stores = extractJsonArray(decodeRscPayload(html), 'initialStores') ?? [];
    const sweedIds = await loadSweedIdMap(html);
    return stores
      .filter((s) => s.location_status === 'Open' && s.nap?.state?.abbr === 'FL'
        && s.storeEmbeds?.storePlatform === 'Sweed' && sweedIds.has(s.slug))
      .map((s): Store => ({
        id: `muv:${s.slug}`,
        operator: 'muv',
        operatorName: 'MÜV',
        name: cleanText(s.title),
        address: cleanText([s.nap.address_1, s.nap.address_2].filter(Boolean).join(' ')),
        city: cleanText(s.nap.city),
        zip: String(s.nap.zip ?? '').slice(0, 5),
        lat: Number(s.nap.lat),
        lng: Number(s.nap.lng),
        platform: 'sweed',
        // "<sweed store id>#<site slug>" — slug is needed to build menu links
        platformStoreId: `${sweedIds.get(s.slug)}#${s.slug}`,
        menuUrl: `${SITE}/locations/${s.slug}/menu/menu`,
        menuSupported: true,
        phone: cleanText(s.nap.phoneNumberOverride),
        hours: muvHours(s.hours),
      }));
  },

  /** Live re-check: search the store's menu by product name (one request per distinct name). */
  async checkStock(store, products) {
    const sweedId = store.platformStoreId.split('#')[0];
    const checkedAt = new Date().toISOString();
    const schedule = await loadPromoSchedule(sweedId);
    const fresh = new Map<string, Product>();
    for (const name of new Set(products.map((p) => p.name))) {
      const res = await getJson(SWEED_API, {
        method: 'POST',
        headers: { Storeid: sweedId, SaleType: 'Medical' },
        body: { filters: {}, page: 1, pageSize: 100, sorting: 0, searchTerm: name, saleType: 'Medical', platformOs: 'web', Storeid: sweedId },
      });
      const promoNames = new Map<number, string>((res.promos ?? []).map((x: any) => [x.id, x.name]));
      const promoInfo = new Map<number, any>((res.promos ?? []).map((x: any) => [x.id, { ...x, ...schedule.get(x.id) }]));
      for (const [id, x] of schedule) if (!promoInfo.has(id)) promoInfo.set(id, x);
      for (const p of res.list ?? []) for (const v of p.variants ?? []) {
        const prod = variantToProduct(store, p, v, checkedAt, promoNames, promoInfo);
        if (prod) fresh.set(prod.id, prod);
      }
    }
    return new Map(products.map((p) => [p.id, fresh.get(p.id) ?? null]));
  },

  async scrapeMenu(store) {
    const sweedId = store.platformStoreId.split('#')[0];
    const scrapedAt = new Date().toISOString();
    const schedule = await loadPromoSchedule(sweedId);
    const out: Product[] = [];
    const pageSize = 100;
    for (let page = 1; page <= 30; page++) {
      const res = await getJson(SWEED_API, {
        method: 'POST',
        headers: { Storeid: sweedId, SaleType: 'Medical' },
        body: { filters: {}, page, pageSize, sorting: 0, searchTerm: '', saleType: 'Medical', platformOs: 'web', Storeid: sweedId },
      });
      const list: any[] = res.list ?? [];
      const promoNames = new Map<number, string>((res.promos ?? []).map((x: any) => [x.id, x.name]));
      const promoInfo = new Map<number, any>((res.promos ?? []).map((x: any) => [x.id, { ...x, ...schedule.get(x.id) }]));
      for (const [id, x] of schedule) if (!promoInfo.has(id)) promoInfo.set(id, x);
      for (const p of list) for (const v of p.variants ?? []) {
        const prod = variantToProduct(store, p, v, scrapedAt, promoNames, promoInfo);
        if (prod) out.push(prod);
      }
      if (list.length < pageSize || page * pageSize >= (res.total ?? 0)) break;
    }
    return out;
  },
};
