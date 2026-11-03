// Shared types for scrapers, storage, and the deal engine.

export type Category =
  | 'flower'
  | 'pre-roll'
  | 'vape'
  | 'concentrate'
  | 'edible'
  | 'oral'
  | 'topical'
  | 'other';

export const CATEGORIES: Category[] = [
  'flower', 'pre-roll', 'vape', 'concentrate', 'edible', 'oral', 'topical', 'other',
];

/** Unit the "amount" of a product is measured in. */
export type AmountUnit = 'g' | 'mg' | 'ml' | 'each';

/** Weekly opening hours, 24h "HH:MM" pairs per day; an empty list means closed that day. */
export type WeekHours = Record<'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat', Array<[string, string]>>;

export interface Store {
  id: string;               // e.g. "trulieve:clearwater"
  operator: string;         // operator key, e.g. "trulieve"
  operatorName: string;     // display, e.g. "Trulieve"
  name: string;             // e.g. "Clearwater"
  address: string;
  city: string;
  zip: string;
  lat: number;
  lng: number;
  platform: string;         // "trulieve-graphql" | "sweed" | "curaleaf-cms" ...
  platformStoreId: string;  // id/code used by the platform API
  menuUrl?: string;
  menuSupported: boolean;   // false = location known but menu not scraped
  lastScrapedAt?: string;
  phone?: string;
  hours?: WeekHours | null; // regular weekly hours (holiday overrides not included)
  tz?: string;              // IANA zone when the source states it
}

export interface Product {
  id: string;               // stable per store: `${storeId}:${platformProductId}`
  storeId: string;
  name: string;             // product display name
  brand: string;            // product brand (e.g. "Roll One"), not the dispensary
  strain: string;           // strain name if known, else ''
  strainType: string;       // indica/sativa/hybrid/... or ''
  category: Category;
  subcategory: string;      // free text, e.g. "Whole Flower", "Shake / Trim", "Disposables"
  /** Size of one package, in `amountUnit`. For flower 3.5 (g); edibles total mg THC. */
  amount: number | null;
  amountUnit: AmountUnit;
  /** Number of pieces in the package (gummies, pre-rolls), 1 if unknown. */
  packCount: number;
  thcPct: number | null;    // % for flower/concentrate/vape (lowest in-stock batch)
  thcPctMax: number | null; // highest in-stock batch (menus often carry several batches)
  thcMg: number | null;     // total mg THC in the package (edibles/orals) if known
  cbdPct: number | null;
  price: number;            // regular price per package
  salePrice: number | null; // discounted price if a promo applies
  promo: string;            // promo name/description
  qtyAvailable: number | null;
  url: string;
  image: string;
  groupKey: string;         // same strain/product at same store across sizes
  scrapedAt: string;
}

/** Product enriched with store + computed metrics for search results. */
export interface ProductHit extends Product {
  store: Store;
  distanceMi: number | null;
  effectivePrice: number;
  pricePerUnit: number | null;   // $/g, $/mg, $/ml
  pricePerMgThc: number | null;  // $ per mg THC (uses thcPct * grams when needed)
}
