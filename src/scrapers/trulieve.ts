// Trulieve (largest FL operator). Store list comes from the public /dispensaries page;
// menus come from the site's Magento GraphQL endpoint (robots.txt: "Allow: /*graphql"),
// scoped to a store with the `Store: <store_code>` header — same as the website does.
import type { Product, Store } from '../types.ts';
import type { OperatorScraper } from './types.ts';
import { getJson, getText, nextData } from './http.ts';
import { cleanText, makeGroupKey, normalizeStrainType, num, parseSize, pct } from '../normalize.ts';
import type { Category } from '../types.ts';
import { DAYS, emptyWeek, parseRange } from '../hours.ts';

const BASE = 'https://www.trulieve.com';

// Top-level menu categories (Magento category uids are base64 ids). Accessories skipped.
const MENU_CATEGORIES: Array<{ uid: string; name: string }> = [
  { uid: 'MjA3', name: 'Flower' },
  { uid: 'MTU1', name: 'Vapes' },
  { uid: 'Ng==', name: 'Concentrates' },
  { uid: 'OA==', name: 'Edibles' },
  { uid: 'OQ==', name: 'Oral' },
  { uid: 'MjAz', name: 'Sublingual' },
  { uid: 'MTg=', name: 'Topicals' },
  { uid: 'MjI4', name: 'TruPODs and TruSTIKs' },
];

const PRODUCTS_QUERY = `query products($searchCriteria: [SearchCriteriaInput!]!, $pageSize: Int = 10, $currentPage: Int = 1) {
  products(searchCriteria: $searchCriteria, pageSize: $pageSize, currentPage: $currentPage) {
    total_count
    page_info { total_pages current_page }
    items {
      __typename id name sku url_key stock_status available_quantity
      custom_attributes_product { code value }
      opps_promo { promo_id promo_name }
      categories { name url_path }
      small_image { url }
      price_range { minimum_price { regular_price { value } final_price { value } } }
      ... on ConfigurableProduct {
        variants {
          attributes { code label }
          product { sku stock_status price_range { minimum_price { regular_price { value } final_price { value } } } }
        }
      }
    }
  }
}`;

async function gql(storeCode: string, variables: Record<string, unknown>): Promise<any> {
  const url = `${BASE}/api/graphql?query=${encodeURIComponent(PRODUCTS_QUERY)}&operationName=products&variables=${encodeURIComponent(JSON.stringify(variables))}`;
  const data = await getJson(url, {
    headers: { Store: storeCode, 'x-pylot-backend': 'trulieve_prod', 'x-pylot-query': 'products', Checkouttype: 'pickup' },
  });
  if (data.errors?.length) throw new Error(`Trulieve GraphQL: ${data.errors[0].message}`);
  return data.data.products;
}

function categorize(paths: string[]): { category: Category; subcategory: string } {
  const has = (p: string) => paths.some((x) => x === p || x.startsWith(p + '/'));
  const sub = (root: string) => {
    const child = paths.find((x) => x.startsWith(root + '/'));
    return child ? child.split('/')[1].replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : '';
  };
  if (has('flower/pre-rolls')) return { category: 'pre-roll', subcategory: 'Pre-Rolls' };
  if (has('flower')) return { category: 'flower', subcategory: sub('flower') };
  if (has('vapes') || has('trupods-and-trustiks')) return { category: 'vape', subcategory: sub('vapes') || 'Pods/Stiks' };
  if (has('concentrates')) return { category: 'concentrate', subcategory: sub('concentrates') };
  if (has('edibles')) return { category: 'edible', subcategory: sub('edibles') };
  if (has('oral') || has('sublinguals')) return { category: 'oral', subcategory: sub('oral') || sub('sublinguals') };
  if (has('topicals')) return { category: 'topical', subcategory: sub('topicals') };
  return { category: 'other', subcategory: '' };
}

// Top-level category paths that are product types; anything else is a merchandising collection
// ("TRUsday Deals", "Fire Friday", "Bud Bargains", ...).
const PRODUCT_ROOTS = new Set(['flower', 'vapes', 'concentrates', 'edibles', 'oral', 'sublinguals', 'topicals',
  'accessories', 'brands', 'trupods-and-trustiks', 'nasal']);

/** "New FL - $35 Live Resin, Budder (month long) PS4" → "$35 Live Resin, Budder (month long)" */
export function cleanTrulievePromo(s: string): string {
  return cleanText(s).replace(/^(new\s+)?fl\s*-\s*/i, '').replace(/\s+PS\d+\s*$/i, '').replace(/^AZ-.*$/i, '').trim();
}

function toProduct(store: Store, it: any, scrapedAt: string): Product | null {
  // In-stock checks: product flag must say IN_STOCK, the store's count must be > 0,
  // and a configurable product needs at least one in-stock batch.
  if (it.stock_status !== 'IN_STOCK') return null;
  const qty = num(it.available_quantity);
  if (qty === null || qty <= 0) return null;
  if (Array.isArray(it.variants) && it.variants.length
    && !it.variants.some((v: any) => v.product?.stock_status === 'IN_STOCK')) return null;
  const ca: Record<string, string> = {};
  for (const a of it.custom_attributes_product ?? []) ca[a.code] = a.value;
  const paths: string[] = (it.categories ?? []).map((c: any) => c.url_path);
  const { category, subcategory } = categorize(paths);

  // THC % lives on per-batch variants: attribute "thc_percentage" label (e.g. "23").
  const inStock = (it.variants ?? []).filter((v: any) => v.product?.stock_status === 'IN_STOCK');
  const thcVals = inStock
    .map((v: any) => pct(v.attributes?.find((a: any) => a.code === 'thc_percentage')?.label))
    .filter((x: number | null): x is number => x !== null);
  const thcAttr = pct(ca.thc_percentage);
  const thcPct = thcVals.length ? Math.min(...thcVals) : thcAttr;
  const thcPctMax = thcVals.length ? Math.max(...thcVals) : thcAttr;

  const regular = num(it.price_range?.minimum_price?.regular_price?.value) ?? 0;
  const final = num(it.price_range?.minimum_price?.final_price?.value) ?? regular;
  if (!(regular > 0 || final > 0)) return null;

  const size = parseSize(ca.units) ?? parseSize(it.name);
  const name = cleanText(ca.product_display_name || it.name);
  const brand = cleanText(ca.brand);
  const isMg = size?.unit === 'mg';

  return {
    id: `${store.id}:${it.id}`,
    storeId: store.id,
    name,
    brand,
    strain: cleanText(ca.strain),
    strainType: normalizeStrainType(ca.strain_type),
    category,
    subcategory,
    amount: size?.amount ?? null,
    amountUnit: size?.unit ?? 'each',
    packCount: size?.packCount ?? 1,
    thcPct: isMg ? null : thcPct,
    thcPctMax: isMg ? null : thcPctMax,
    thcMg: isMg ? size!.amount : null,
    cbdPct: null,
    price: regular || final,
    salePrice: final > 0 && final < regular ? final : null,
    promo: cleanTrulievePromo(it.opps_promo?.promo_name ?? ''),
    collections: [...new Set((it.categories ?? [])
      .filter((c: any) => c?.url_path && !c.url_path.includes('/') && !PRODUCT_ROOTS.has(c.url_path))
      .map((c: any) => cleanText(c.name)))] as string[],
    qtyAvailable: qty,
    url: it.url_key ? `${BASE}/${it.url_key}` : BASE,
    image: it.small_image?.url ?? '',
    groupKey: makeGroupKey(store.id, brand, name, subcategory),
    scrapedAt,
  };
}

export const trulieve: OperatorScraper = {
  key: 'trulieve',
  name: 'Trulieve',

  async listStores() {
    const html = await getText(`${BASE}/dispensaries`);
    const stores: any[] = nextData(html).props.pageProps.stores ?? [];
    return stores
      .filter((s) => s.state === 'FL' && s.is_active && !s.coming_soon && !s.non_shop_store)
      .map((s): Store => ({
        id: `trulieve:${s.code}`,
        operator: 'trulieve',
        operatorName: 'Trulieve',
        name: cleanText(s.store_name_override || s.name),
        address: cleanText(s.address),
        city: cleanText(s.city),
        zip: String(s.zipCode ?? '').slice(0, 5),
        lat: Number(s.latitude),
        lng: Number(s.longitude),
        platform: 'trulieve-graphql',
        platformStoreId: s.code,
        menuUrl: `${BASE}${s.map_pin_url ?? ''}`,
        menuSupported: true,
        phone: cleanText(s.phone),
        hours: (() => {
          if (!s.workingHours || typeof s.workingHours !== 'object') return null;
          const w = emptyWeek();
          for (const d of DAYS) {
            const r = parseRange(s.workingHours[d]);
            if (r === null && s.workingHours[d] != null) return null; // unknown format → don't guess
            w[d] = r ?? [];
          }
          return w;
        })(),
      }));
  },

  /** Live re-check of specific products: one GraphQL call (repeated url_key EQ = IN) per 50 products. */
  async checkStock(store, products) {
    const checkedAt = new Date().toISOString();
    const keyOf = (p: Product) => p.url.replace(`${BASE}/`, '');
    const fresh = new Map<string, Product>();
    for (let i = 0; i < products.length; i += 50) {
      const batch = products.slice(i, i + 50);
      const res = await gql(store.platformStoreId, {
        searchCriteria: batch.map((p) => ({ attribute_code: 'url_key', filter_action: 'EQ', filter_value: keyOf(p) })),
        pageSize: 100,
        currentPage: 1,
      });
      for (const it of res.items ?? []) {
        const p = toProduct(store, it, checkedAt);
        if (p) fresh.set(p.id, p);
      }
    }
    return new Map(products.map((p) => [p.id, fresh.get(p.id) ?? null]));
  },

  async scrapeMenu(store) {
    const scrapedAt = new Date().toISOString();
    const seen = new Map<string, Product>();
    for (const cat of MENU_CATEGORIES) {
      let page = 1;
      let totalPages = 1;
      do {
        const res = await gql(store.platformStoreId, {
          searchCriteria: [{ attribute_code: 'category_uid', filter_action: 'EQ', filter_value: cat.uid }],
          pageSize: 100,
          currentPage: page,
        });
        totalPages = res.page_info?.total_pages ?? 1;
        for (const it of res.items ?? []) {
          const p = toProduct(store, it, scrapedAt);
          if (p && !seen.has(p.id)) seen.set(p.id, p);
        }
        page++;
      } while (page <= totalPages && page <= 20);
    }
    return [...seen.values()];
  },
};
