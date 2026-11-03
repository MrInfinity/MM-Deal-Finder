// Normalization helpers: turn messy menu strings into comparable numbers/categories.
import type { AmountUnit, Category } from './types.ts';

export const GRAMS_PER_OZ = 28; // FL dispensaries sell an "ounce" as 28 g

export interface ParsedSize {
  amount: number;
  unit: AmountUnit;
  packCount: number;
}

/**
 * Parse a size string like "3.5g", "1/8 oz", "14 G", "100mg [10-Pack]", "0.5g x 2", "1oz".
 * Returns total amount for the package (pack multiplied out for grams).
 */
export function parseSize(input: string | null | undefined): ParsedSize | null {
  if (!input) return null;
  const s = input.toLowerCase().replace(/,/g, '').trim();

  let packCount = 1;
  const pack = s.match(/(\d+)\s*-?\s*(?:pack|pk|ct|count)\b/) || s.match(/\bx\s*(\d+)\b/) || s.match(/\b(\d+)\s*x\b/);
  if (pack) packCount = parseInt(pack[1], 10) || 1;

  const frac = s.match(/(\d+)\s*\/\s*(\d+)\s*(?:oz|ounce)/);
  if (frac) return { amount: (parseInt(frac[1]) / parseInt(frac[2])) * GRAMS_PER_OZ, unit: 'g', packCount };

  const oz = s.match(/(\d+(?:\.\d+)?)\s*(?:oz|ounce)/);
  if (oz) return { amount: parseFloat(oz[1]) * GRAMS_PER_OZ, unit: 'g', packCount };

  const mg = s.match(/(\d+(?:\.\d+)?)\s*mg\b/);
  if (mg) return { amount: parseFloat(mg[1]), unit: 'mg', packCount };

  const ml = s.match(/(\d+(?:\.\d+)?)\s*ml\b/);
  if (ml) return { amount: parseFloat(ml[1]), unit: 'ml', packCount };

  const g = s.match(/(\d+(?:\.\d+)?)\s*(?:g|gr|gram|grams)\b/);
  if (g) {
    const per = parseFloat(g[1]);
    // "0.5g x 2" style multi-packs of pre-rolls: total grams = per * count
    const multi = s.match(/(\d+(?:\.\d+)?)\s*g\s*x\s*(\d+)/) || s.match(/(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*g/);
    if (multi) {
      const a = parseFloat(multi[1]), b = parseFloat(multi[2]);
      const [each, count] = s.includes('g x') ? [a, b] : [b, a];
      return { amount: each * count, unit: 'g', packCount: count };
    }
    return { amount: per, unit: 'g', packCount };
  }

  // Slang sizes
  if (/\beighth\b/.test(s)) return { amount: 3.5, unit: 'g', packCount };
  if (/\bquarter\b/.test(s)) return { amount: 7, unit: 'g', packCount };
  if (/\bhalf\b/.test(s)) return { amount: 14, unit: 'g', packCount };
  return null;
}

const CATEGORY_RULES: Array<[RegExp, Category]> = [
  [/pre-?roll|preroll|joint|blunt|infused cone/i, 'pre-roll'],
  [/vape|cart|cartridge|pod|disposable|all.?in.?one|aio|pen\b/i, 'vape'],
  [/concentrate|wax|shatter|badder|batter|budder|rosin|resin|sauce|diamond|crumble|sugar|kief|hash|rso|syringe|distillate|live/i, 'concentrate'],
  [/edible|gumm|chew|chocolate|gel|lozenge|mint|baked|beverage|drink|powder|candy|troche|tablet/i, 'edible'],
  [/oral|tincture|capsule|sublingual|spray|drops|nasal|inhaler/i, 'oral'],
  [/topical|cream|lotion|balm|salve|patch|transdermal|suppositor/i, 'topical'],
  [/flower|bud|shake|trim|ground|mini|smalls|popcorn|whole/i, 'flower'],
];

/** Map any category/subcategory text from a menu to our normalized category. */
export function normalizeCategory(...hints: Array<string | null | undefined>): Category {
  const text = hints.filter(Boolean).join(' | ');
  for (const [re, cat] of CATEGORY_RULES) if (re.test(text)) return cat;
  return 'other';
}

export function normalizeStrainType(s: string | null | undefined): string {
  if (!s) return '';
  const t = s.toLowerCase();
  if (t.includes('cbd')) return 'cbd';
  if (t.includes('indica') && t.includes('dom')) return 'indica-dominant';
  if (t.includes('sativa') && t.includes('dom')) return 'sativa-dominant';
  if (t.includes('indica')) return 'indica';
  if (t.includes('sativa')) return 'sativa';
  if (t.includes('hybrid')) return 'hybrid';
  return t.trim();
}

/** Strip size tokens & punctuation so "Majestic Jack 7g" and "Majestic Jack 14g" group together. */
export function baseName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/\d+(?:\.\d+)?\s*(?:g|mg|ml|oz)\b/g, ' ')
    .replace(/\b\d+\s*\/\s*\d+\s*oz\b/g, ' ')
    .replace(/\b(?:whole flower|flower)\b/g, ' ')
    .replace(/[^a-z0-9#]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function makeGroupKey(storeId: string, brand: string, name: string, subcategory: string): string {
  return [storeId, baseName(brand), baseName(name), baseName(subcategory)].join('|');
}

export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** THC percentage sanity: values like 1610 are option ids, not percents. */
export function pct(v: unknown): number | null {
  const n = num(v);
  if (n === null || n < 0 || n > 100) return null;
  return n;
}

export function cleanText(s: unknown): string {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}
