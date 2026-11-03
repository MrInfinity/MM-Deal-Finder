// Market insights and deals, computed from every in-stock listing statewide.
// Pure (no I/O): the static build writes the result to data/insights.json; the server computes it on demand.
import type { Product, Store } from './types.ts';
import { effectivePrice } from './engine.ts';

export interface Bucket { label: string; lo: number; hi: number; median: number; p25: number; p75: number; n: number }
export interface CurrentDeal {
  operator: string; operatorName: string; name: string; listings: number; stores: number;
  /** Typical % off, only when the promo name doesn't state its own terms (items often carry overlapping promos). */
  medianOffPct: number | null; endsAt: string | null; monthLong: boolean;
}
export interface WeeklyDeal { operator: string; operatorName: string; name: string; day: string; listings: number }
export interface SaleDay { name: string; date: string; daysAway: number; note: string }
export interface Bundle { operator: string; operatorName: string; name: string; listings: number; stores: number }
export interface Insights {
  generatedAt: string;
  listings: number;
  storesWithMenus: number;
  flowerByThc: Bucket[];
  shake: { median: number; n: number; thcP25: number; thcP75: number } | null;
  flowerBySize: Array<{ size: number; median: number; n: number }>;
  thcValue: Array<{ category: string; label: string; median: number; n: number }>;
  operators: Array<{ key: string; name: string; flowerMedian: number | null; onSalePct: number; medianOffPct: number | null; listings: number }>;
  sale: { onSalePct: number; medianOffPct: number | null };
  takeaways: string[];
  deals: { current: CurrentDeal[]; weekly: WeeklyDeal[]; bundles: Bundle[]; upcoming: SaleDay[] };
}

const SHAKE = /shake|ground|trim|popcorn|smalls/i;
const isShake = (p: Product) => SHAKE.test(`${p.subcategory} ${p.name}`);

export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
const sortNum = (a: number[]) => [...a].sort((x, y) => x - y);
const median = (a: number[]) => quantile(sortNum(a), 0.5);
const r2 = (n: number) => Math.round(n * 100) / 100;
const money = (n: number) => `$${n.toFixed(2)}`;

const THC_BUCKETS: Array<[number, number, string]> = [
  [0, 15, 'Under 15%'], [15, 18, '15–18%'], [18, 21, '18–21%'], [21, 24, '21–24%'],
  [24, 27, '24–27%'], [27, 30, '27–30%'], [30, 101, '30%+'],
];
const SIZES = [1, 3.5, 7, 14, 28];
const CAT_LABEL: Record<string, string> = {
  flower: 'Flower', 'pre-roll': 'Pre-rolls', vape: 'Vapes', concentrate: 'Concentrates', edible: 'Edibles', oral: 'Oral & tinctures', topical: 'Topicals',
};
const MIN_N = 30;

function thcMg(p: Product): number | null {
  if (p.thcMg) return p.thcMg;
  if (p.amountUnit === 'g' && p.amount && p.thcPct) return p.amount * 1000 * (p.thcPct / 100);
  return null;
}

// ---------------------------------------------------------------------------
// Annual sale days Florida dispensaries have run big promotions on.
// ---------------------------------------------------------------------------
function thanksgiving(year: number): Date {
  const nov1 = new Date(Date.UTC(year, 10, 1));
  const firstThu = 1 + ((4 - nov1.getUTCDay() + 7) % 7);
  return new Date(Date.UTC(year, 10, firstThu + 21));
}
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400_000);

export function saleDaysForYear(year: number): Array<{ name: string; date: string; note: string }> {
  const tg = thanksgiving(year);
  return [
    { name: '4/20', date: `${year}-04-20`, note: 'The biggest cannabis sale day of the year. Expect storewide discounts and doorbusters.' },
    { name: '7/10 (Oil Day)', date: `${year}-07-10`, note: 'Concentrate and vape deals. Good time to stock up on extracts.' },
    { name: 'Green Wednesday', date: iso(addDays(tg, -1)), note: 'Day before Thanksgiving. Dispensaries have run storewide sales (up to ~50% off), sometimes for several days.' },
    { name: 'Black Friday', date: iso(addDays(tg, 1)), note: 'Often a continuation of Green Wednesday deals.' },
    { name: 'Cyber Monday', date: iso(addDays(tg, 4)), note: 'Some chains extend holiday-weekend pricing.' },
  ];
}

/** Today's date in Florida (Eastern). */
export function floridaToday(now: Date): string {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  return p; // en-CA formats as YYYY-MM-DD
}

export function upcomingSaleDays(now: Date, count = 4): SaleDay[] {
  const today = floridaToday(now);
  const y = Number(today.slice(0, 4));
  const all = [...saleDaysForYear(y), ...saleDaysForYear(y + 1)]
    .filter((d) => d.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, count);
  return all.map((d) => ({ ...d, daysAway: Math.round((Date.parse(d.date) - Date.parse(today)) / 86400_000) }));
}

// Full day names only (plus Trulieve's "TRUsday"), so brands like "Sun Grown" aren't read as Sunday.
const WEEKDAYS: Array<[RegExp, string]> = [
  [/monday/i, 'Monday'], [/tuesday|trusday/i, 'Tuesday'], [/wednesday/i, 'Wednesday'], [/thursday/i, 'Thursday'],
  [/friday/i, 'Friday'], [/saturday/i, 'Saturday'], [/sunday/i, 'Sunday'],
];
const BUNDLE = /\b\d+\s*for\s*\$\s*\d+|\bbundles?\b|mix\s*(&|and)\s*match/i;
export function weekdayOf(name: string): string | null {
  for (const [re, day] of WEEKDAYS) if (re.test(name)) return day;
  return null;
}

// ---------------------------------------------------------------------------
export function computeInsights(stores: Store[], products: Product[], nowMs: number = Date.now()): Insights {
  const now = new Date(nowMs);
  const storeById = new Map(stores.map((s) => [s.id, s]));
  const opName = (key: string) => stores.find((s) => s.operator === key)?.operatorName ?? key;
  const live = products.filter((p) => p.qtyAvailable != null && p.qtyAvailable >= 1 && storeById.has(p.storeId));
  const eff = (p: Product) => effectivePrice(p, nowMs);
  const onSale = (p: Product) => eff(p) < p.price - 0.005;
  const off = (p: Product) => 1 - eff(p) / p.price;

  // Flower $/g by THC (whole flower; shake is its own line)
  const flower = live.filter((p) => p.category === 'flower' && p.amountUnit === 'g' && p.amount && p.thcPct != null);
  const whole = flower.filter((p) => !isShake(p));
  const shakeP = flower.filter(isShake);
  const flowerByThc: Bucket[] = [];
  for (const [lo, hi, label] of THC_BUCKETS) {
    const v = sortNum(whole.filter((p) => p.thcPct! >= lo && p.thcPct! < hi).map((p) => eff(p) / p.amount!));
    if (v.length >= MIN_N) flowerByThc.push({ label, lo, hi, median: r2(quantile(v, 0.5)), p25: r2(quantile(v, 0.25)), p75: r2(quantile(v, 0.75)), n: v.length });
  }
  const shakeThc = sortNum(shakeP.map((p) => p.thcPct!));
  const shake = shakeP.length >= MIN_N
    ? { median: r2(median(shakeP.map((p) => eff(p) / p.amount!))), n: shakeP.length, thcP25: Math.round(quantile(shakeThc, 0.25)), thcP75: Math.round(quantile(shakeThc, 0.75)) }
    : null;

  const flowerBySize = SIZES.map((size) => {
    const v = whole.filter((p) => Math.abs(p.amount! - size) < 0.05).map((p) => eff(p) / p.amount!);
    return { size, median: r2(median(v)), n: v.length };
  }).filter((x) => x.n >= MIN_N);

  // $ per 100mg THC by product type
  const byCat = new Map<string, number[]>();
  for (const p of live) {
    const mg = thcMg(p);
    if (!mg || mg <= 0 || !CAT_LABEL[p.category]) continue;
    (byCat.get(p.category) ?? byCat.set(p.category, []).get(p.category)!).push((eff(p) / mg) * 100);
  }
  const thcValue = [...byCat].filter(([, v]) => v.length >= MIN_N)
    .map(([category, v]) => ({ category, label: CAT_LABEL[category], median: r2(median(v)), n: v.length }))
    .sort((a, b) => a.median - b.median);

  // Chains
  const opKeys = [...new Set(live.map((p) => storeById.get(p.storeId)!.operator))].sort();
  const operators = opKeys.map((key) => {
    const ps = live.filter((p) => storeById.get(p.storeId)!.operator === key);
    const fw = whole.filter((p) => storeById.get(p.storeId)!.operator === key).map((p) => eff(p) / p.amount!);
    const sale = ps.filter(onSale);
    return {
      key, name: opName(key), listings: ps.length,
      flowerMedian: fw.length >= MIN_N ? r2(median(fw)) : null,
      onSalePct: ps.length ? Math.round((sale.length / ps.length) * 100) : 0,
      medianOffPct: sale.length ? Math.round(median(sale.map(off)) * 100) : null,
    };
  });
  const allSale = live.filter(onSale);
  const sale = {
    onSalePct: live.length ? Math.round((allSale.length / live.length) * 100) : 0,
    medianOffPct: allSale.length ? Math.round(median(allSale.map(off)) * 100) : null,
  };

  // Current deals: group sale listings by promo name per chain
  const groups = new Map<string, { op: string; name: string; offs: number[]; stores: Set<string>; ends: string[]; open: boolean; monthLong: boolean }>();
  for (const p of allSale) {
    const op = storeById.get(p.storeId)!.operator;
    for (const raw of (p.promo || '').split(' · ')) {
      if (!raw || /\(conditional\)/i.test(raw)) continue;
      const monthLong = /month[\s-]*long/i.test(raw);
      const name = raw.replace(/\(\s*month[\s-]*long\s*\)/i, '').replace(/^(new\s+)?fl\s*-\s*/i, '')
        .replace(/\s+PS\d+\s*$/i, '').replace(/\s+/g, ' ').trim();
      if (!name) continue;
      const k = `${op}|${name}`;
      const g = groups.get(k) ?? { op, name, offs: [], stores: new Set(), ends: [], open: false, monthLong };
      g.offs.push(off(p)); g.stores.add(p.storeId);
      const own = p.promoEnds?.[raw];
      if (own) g.ends.push(own); else g.open = true;
      groups.set(k, g);
    }
  }
  const current: CurrentDeal[] = [...groups.values()]
    .filter((g) => g.offs.length >= 20)
    .map((g) => ({
      operator: g.op, operatorName: opName(g.op), name: g.name, listings: g.offs.length, stores: g.stores.size,
      medianOffPct: /\d\s*%|\$\s*\d|\d-for-|bogo/i.test(g.name) ? null : Math.round(median(g.offs) * 100),
      endsAt: !g.open && g.ends.length ? sortNum(g.ends.map(Date.parse)).map((t) => new Date(t).toISOString())[0] : null,
      monthLong: g.monthLong,
    }))
    .sort((a, b) => b.stores - a.stores || b.listings - a.listings);
  // Keep the top deals per chain so one chain doesn't crowd out the other.
  const perOp = new Map<string, number>();
  const currentTop = current.filter((d) => { const n = (perOp.get(d.operator) ?? 0) + 1; perOp.set(d.operator, n); return n <= 6; });

  // Weekly deals: merchandising collections named after a weekday
  const weeklyMap = new Map<string, WeeklyDeal>();
  const bundleMap = new Map<string, { operator: string; name: string; listings: number; stores: Set<string> }>();
  for (const p of live) {
    for (const c of p.collections ?? []) {
      const op = storeById.get(p.storeId)!.operator;
      if (BUNDLE.test(c)) {
        const b = bundleMap.get(`${op}|${c}`) ?? { operator: op, name: c, listings: 0, stores: new Set<string>() };
        b.listings++; b.stores.add(p.storeId);
        bundleMap.set(`${op}|${c}`, b);
      }
      const day = weekdayOf(c);
      if (!day) continue;
      const k = `${op}|${c}`;
      const w = weeklyMap.get(k) ?? { operator: op, operatorName: opName(op), name: c, day, listings: 0 };
      w.listings++;
      weeklyMap.set(k, w);
    }
  }
  const order = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const weekly = [...weeklyMap.values()].filter((w) => w.listings >= 5).sort((a, b) => order.indexOf(a.day) - order.indexOf(b.day));
  const bundles: Bundle[] = [...bundleMap.values()].filter((b) => b.listings >= 5)
    .map((b) => ({ operator: b.operator, operatorName: opName(b.operator), name: b.name, listings: b.listings, stores: b.stores.size }))
    .sort((a, b) => b.stores - a.stores || b.listings - a.listings).slice(0, 8);

  // Plain-language takeaways (only the ones the data supports)
  const takeaways: string[] = [];
  if (flowerByThc.length >= 2) {
    const a = flowerByThc[0], b = flowerByThc[flowerByThc.length - 1];
    takeaways.push(`THC drives flower prices: whole flower runs about ${money(a.median)}/g at ${a.label.toLowerCase()} THC vs ${money(b.median)}/g at ${b.label}.`);
  }
  if (flowerBySize.length >= 2) {
    const best = [...flowerBySize].sort((x, y) => x.median - y.median)[0];
    const big = flowerBySize.find((x) => x.size === 28);
    takeaways.push(`Best bulk value: ${best.size}g packages at about ${money(best.median)}/g${big && big.size !== best.size && big.median > best.median ? `. Full ounces average more per gram (${money(big.median)}/g)` : ''}.`);
  }
  const fl = thcValue.find((x) => x.category === 'flower'), ed = thcValue.find((x) => x.category === 'edible');
  if (fl && ed) takeaways.push(`Flower is the cheapest THC: about ${money(fl.median)} per 100mg vs ${money(ed.median)} for edibles (${Math.round(ed.median / fl.median)}× more).`);
  const ops = operators.filter((o) => o.flowerMedian != null).sort((a, b) => a.flowerMedian! - b.flowerMedian!);
  if (ops.length >= 2) takeaways.push(`${ops[0].name} whole flower is the cheapest chain-wide at about ${money(ops[0].flowerMedian!)}/g (${ops.slice(1).map((o) => `${o.name} ${money(o.flowerMedian!)}/g`).join(', ')}).`);
  if (shake) takeaways.push(`Shake and ground flower averages ${money(shake.median)}/g, mostly ${shake.thcP25}–${shake.thcP75}% THC.`);
  if (sale.medianOffPct != null) takeaways.push(`${sale.onSalePct}% of in-stock listings are on sale right now, typically ${sale.medianOffPct}% off.`);

  return {
    generatedAt: now.toISOString(),
    listings: live.length,
    storesWithMenus: new Set(live.map((p) => p.storeId)).size,
    flowerByThc, shake, flowerBySize, thcValue, operators, sale, takeaways,
    deals: { current: currentTop, weekly, bundles, upcoming: upcomingSaleDays(now) },
  };
}
