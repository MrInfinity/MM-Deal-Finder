// Natural-language-ish query parsing: "2 oz flower", "1/8 gelato indica over 25%", "1000mg gummies under $40".
import type { Category } from './types.ts';

export interface ParsedQuery {
  text: string;                       // leftover free text for name/strain/brand matching
  categories: Category[];
  strainTypes: string[];
  target: { amount: number; unit: 'g' | 'mg' } | null;
  minThc: number | null;
  maxThc: number | null;
  maxPrice: number | null;
}

const CATEGORY_WORDS: Array<[RegExp, Category]> = [
  [/\b(?:flowers?|buds?|nugs?|smokables?|weed)\b/g, 'flower'],
  [/\b(?:pre-?rolls?|prerolls?|joints?|blunts?)\b/g, 'pre-roll'],
  [/\b(?:vapes?|carts?|cartridges?|pods?|disposables?|pens?)\b/g, 'vape'],
  [/\b(?:concentrates?|dabs?|extracts?)\b/g, 'concentrate'],
  [/\b(?:edibles?)\b/g, 'edible'],
  [/\b(?:orals?|tinctures?|capsules?|sublinguals?)\b/g, 'oral'],
  [/\b(?:topicals?|lotions?|creams?)\b/g, 'topical'],
];

// Words that imply a category but are also useful to keep as text (e.g. "gummies", "rosin").
const CATEGORY_HINTS: Array<[RegExp, Category]> = [
  [/\b(?:gumm(?:y|ies)|chews?|chocolates?|mints?|gels?)\b/, 'edible'],
  [/\b(?:rosin|wax|shatter|badder|batter|budder|sugar|diamonds?|sauce|kief|hash|rso|live resin)\b/, 'concentrate'],
  [/\b(?:shake|ground|minis?|smalls|popcorn)\b/, 'flower'],
];

const STRAIN_TYPES = ['indica', 'sativa', 'hybrid', 'cbd'];

const OZ = 28;
const SLANG_SIZES: Array<[RegExp, number]> = [
  [/\b(?:an?\s+)?eighths?\b/, 3.5],
  [/\b(?:a\s+)?quarters?\b/, 7],
  [/\b(?:a\s+half|half\s+(?:an?\s+)?(?:oz|ounce))\b/, 14],
  [/\b(?:a\s+)?zips?\b/, 28],
  [/\b(?:an?\s+)?ounces?\b/, 28],
];

export function parseQuery(raw: string): ParsedQuery {
  let s = ` ${raw.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')} `;
  const out: ParsedQuery = { text: '', categories: [], strainTypes: [], target: null, minThc: null, maxThc: null, maxPrice: null };
  const take = (re: RegExp) => { const m = s.match(re); if (m) s = s.replace(m[0], ' '); return m; };

  // price: "under $100", "< $50", "max $60", "$100 or less"
  let m = take(/(?:under|below|less than|max|<)\s*\$?\s*(\d+(?:\.\d+)?)(?![\d.])(?!\s*(?:%|mg|g\b|grams?|oz|ounces?|\/|\.\d))(?:\s*(?:dollars|bucks))?/)
    || take(/\$\s*(\d+(?:\.\d+)?)\s*(?:or less|max)/);
  if (m) out.maxPrice = parseFloat(m[1]);

  // Max THC: "under 20%", "below 15% thc"
  m = take(/(?:under|below|less than|max(?:imum)?|<=?)\s*(\d+(?:\.\d+)?)\s*%\s*(?:thc)?/);
  if (m) out.maxThc = parseFloat(m[1]);

  // THC: "over 25%", "25%+", "min 20% thc", "at least 20%"
  m = take(/(?:over|above|at least|min(?:imum)?|>=?)\s*(\d+(?:\.\d+)?)\s*%\s*(?:thc)?/) || take(/(\d+(?:\.\d+)?)\s*%\s*\+?\s*(?:thc)?\s*(?:or more|\+|min)?/);
  if (m) out.minThc = parseFloat(m[1]);

  // amounts
  m = take(/(\d+)\s*\/\s*(\d+)\s*(?:oz|ounces?)?\b/);
  if (m) out.target = { amount: (parseInt(m[1]) / parseInt(m[2])) * OZ, unit: 'g' };
  if (!out.target) {
    m = take(/(\d+(?:\.\d+)?)\s*(?:oz|ozs|ounces?|zips?)\b/);
    if (m) out.target = { amount: parseFloat(m[1]) * OZ, unit: 'g' };
  }
  if (!out.target) {
    m = take(/(\d+(?:\.\d+)?)\s*mg\b/);
    if (m) out.target = { amount: parseFloat(m[1]), unit: 'mg' };
  }
  if (!out.target) {
    m = take(/(\d+(?:\.\d+)?)\s*(?:g|grams?)\b/);
    if (m) out.target = { amount: parseFloat(m[1]), unit: 'g' };
  }
  if (!out.target) {
    for (const [re, g] of SLANG_SIZES) if (take(re)) { out.target = { amount: g, unit: 'g' }; break; }
  }

  for (const [re, cat] of CATEGORY_WORDS) {
    if (re.test(s)) { out.categories.push(cat); s = s.replace(re, ' '); }
  }
  for (const [re, cat] of CATEGORY_HINTS) {
    if (re.test(s) && !out.categories.includes(cat)) out.categories.push(cat);
  }
  // Generic edible words ("gummies") rarely appear in product names ("Soft Chews", "Gels"): category only.
  s = s.replace(/\b(?:gumm(?:y|ies)|chews?|candies|candy)\b/g, ' ');
  for (const t of STRAIN_TYPES) {
    const re = new RegExp(`\\b${t}s?\\b`);
    if (re.test(s)) { out.strainTypes.push(t); s = s.replace(re, ' '); }
  }
  // Default: an amount in grams with no category most likely means flower.
  if (out.target?.unit === 'g' && out.categories.length === 0) out.categories.push('flower');

  out.text = s.replace(/\b(?:of|the|a|an|some|best|cheapest|deal|deals|price|for|me|thc|i|want|need|buy|to|and|with|near)\b/g, ' ')
    .replace(/[^a-z0-9#'\- ]/g, ' ').replace(/\s+/g, ' ').trim();
  return out;
}
