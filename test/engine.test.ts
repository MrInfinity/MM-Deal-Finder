import { test } from 'node:test';
import assert from 'node:assert/strict';
import { minCostCover, search } from '../src/engine.ts';
import { parseQuery } from '../src/query.ts';
import { parseSize, baseName } from '../src/normalize.ts';
import type { Product, Store } from '../src/types.ts';

test('parseSize handles common menu formats', () => {
  assert.deepEqual(parseSize('3.5g'), { amount: 3.5, unit: 'g', packCount: 1 });
  assert.deepEqual(parseSize('1/8 oz'), { amount: 3.5, unit: 'g', packCount: 1 });
  assert.deepEqual(parseSize('1oz'), { amount: 28, unit: 'g', packCount: 1 });
  assert.deepEqual(parseSize('100mg [10-Pack]'), { amount: 100, unit: 'mg', packCount: 10 });
  assert.deepEqual(parseSize('0.5g x 2'), { amount: 1, unit: 'g', packCount: 2 });
  assert.equal(parseSize('Each'), null);
});

test('baseName groups sizes of the same product', () => {
  assert.equal(baseName('Majestic Jack 7g'), baseName('Majestic Jack 14g'));
  assert.equal(baseName('Gelato Flower 3.5g'), 'gelato');
});

test('parseQuery understands amounts, categories, THC and price', () => {
  const q = parseQuery('2 oz flower');
  assert.deepEqual(q.target, { amount: 56, unit: 'g' });
  assert.deepEqual(q.categories, ['flower']);
  assert.equal(q.text, '');

  const q2 = parseQuery('an eighth of gelato indica over 25%');
  assert.deepEqual(q2.target, { amount: 3.5, unit: 'g' });
  assert.deepEqual(q2.strainTypes, ['indica']);
  assert.equal(q2.minThc, 25);
  assert.equal(q2.text, 'gelato');

  const q3 = parseQuery('1000mg gummies under $40');
  assert.deepEqual(q3.target, { amount: 1000, unit: 'mg' });
  assert.equal(q3.maxPrice, 40);
  assert.ok(q3.categories.includes('edible'));

  assert.equal(parseQuery('flower under 50').maxPrice, 50);
  assert.equal(parseQuery('vape under 40 bucks').maxPrice, 40);
  assert.equal(parseQuery('under 20%').maxPrice, null);           // not a price
  assert.equal(parseQuery('flower under 20%').maxThc, 20);
  assert.equal(parseQuery('flower under 20%').minThc, null);
  assert.deepEqual(parseQuery('under 7g').target, { amount: 7, unit: 'g' });
  assert.equal(parseQuery('Half-day Kush').target, null); // strain name, not "a half"
  assert.deepEqual(parseQuery('concentrates').categories, ['concentrate']);
});

test('minCostCover finds the cheapest combination reaching the target', () => {
  // 2 oz: 14g @ $57 (stock 10) vs 28g @ $120 vs 3.5g @ $15
  const r = minCostCover([
    { size: 14, price: 57, stock: 10 },
    { size: 28, price: 120, stock: 10 },
    { size: 3.5, price: 15, stock: 50 },
  ], 56, 0.05)!;
  assert.deepEqual(r.qty, [4, 0, 0]);
  assert.equal(r.cost, 228);
  assert.equal(r.amount, 56);
});

test('minCostCover respects stock limits and allows overshoot when cheaper', () => {
  const r = minCostCover([
    { size: 14, price: 50, stock: 2 },  // only 28g available at the great price
    { size: 7, price: 40, stock: 10 },
    { size: 28, price: 70, stock: 1 },
  ], 56, 0.05)!;
  // best: 2×14 ($100) + 1×28 ($70) = 56g for $170
  assert.equal(r.cost, 170);
  const r2 = minCostCover([{ size: 28, price: 100, stock: 5 }, { size: 3.5, price: 40, stock: 5 }], 30, 0.05)!;
  assert.equal(r2.cost, 140); // 28 + 3.5 = 31.5g ($140) beats 2×28 ($200)
});

const store = (id: string, op: string, lat: number, lng: number): Store => ({
  id, operator: op, operatorName: op.toUpperCase(), name: id, address: '', city: '', zip: '', lat, lng,
  platform: 'x', platformStoreId: id, menuSupported: true,
});
const prod = (o: Partial<Product> & Pick<Product, 'id' | 'storeId' | 'name' | 'amount' | 'price'>): Product => ({
  brand: 'B', strain: o.name, strainType: 'hybrid', category: 'flower', subcategory: 'Whole', amountUnit: 'g',
  packCount: 1, thcPct: 22, thcPctMax: 22, thcMg: null, cbdPct: null, salePrice: null, promo: '', qtyAvailable: 20,
  url: '', image: '', groupKey: `${o.storeId}|${o.name}`, scrapedAt: '', ...o,
});

test('search builds per-product plans, filters by radius/THC, and ranks by total price', () => {
  const stores = [store('muv:a', 'muv', 28.54, -81.38), store('tru:b', 'trulieve', 28.6, -81.3), store('far:c', 'muv', 25.77, -80.19)];
  const products = [
    prod({ id: '1', storeId: 'muv:a', name: 'ABC', amount: 14, price: 95, salePrice: 57, thcPct: 20 }),
    prod({ id: '2', storeId: 'muv:a', name: 'ABC', amount: 3.5, price: 35, thcPct: 20 }),
    prod({ id: '3', storeId: 'tru:b', name: 'XYZ', amount: 28, price: 130, thcPct: 18 }),
    prod({ id: '4', storeId: 'tru:b', name: 'Weak', amount: 28, price: 60, thcPct: 12 }),
    prod({ id: '5', storeId: 'far:c', name: 'Cheap', amount: 28, price: 10, thcPct: 30 }),
  ];
  const r = search(stores, products, {
    categories: ['flower'], minThc: 15, target: { amount: 56, unit: 'g' },
    center: { lat: 28.54, lng: -81.38 }, radiusMi: 25,
  });
  assert.equal(r.storesSearched, 2);
  assert.equal(r.plans[0].store.id, 'muv:a');
  assert.equal(r.plans[0].summary, '4 × 14g');
  assert.equal(r.plans[0].totalPrice, 228);
  assert.ok(!r.products.some((p) => p.id === '4' || p.id === '5'));

  // explicitly added far store is included
  const r2 = search(stores, products, { categories: ['flower'], center: { lat: 28.54, lng: -81.38 }, radiusMi: 25, storeIds: ['far:c'] });
  assert.ok(r2.products.some((p) => p.id === '5'));
  // operator filter
  const r3 = search(stores, products, { operators: ['trulieve'] });
  assert.ok(r3.products.every((p) => p.store.operator === 'trulieve'));
});

test('out-of-stock, unknown-stock and stale products are never shown', () => {
  const stores = [store('muv:a', 'muv', 28.54, -81.38), store('tru:b', 'trulieve', 28.6, -81.3)];
  const now = Date.parse('2026-11-01T12:00:00Z');
  const products = [
    prod({ id: 'ok', storeId: 'muv:a', name: 'Fresh', amount: 14, price: 50, scrapedAt: '2026-11-01T10:00:00Z' }),
    prod({ id: 'zero', storeId: 'muv:a', name: 'Gone', amount: 14, price: 10, qtyAvailable: 0, scrapedAt: '2026-11-01T10:00:00Z' }),
    prod({ id: 'unknown', storeId: 'muv:a', name: 'Unknown', amount: 14, price: 10, qtyAvailable: null, scrapedAt: '2026-11-01T10:00:00Z' }),
    prod({ id: 'old', storeId: 'tru:b', name: 'Old', amount: 14, price: 5, scrapedAt: '2026-10-29T10:00:00Z' }),
  ];
  const r = search(stores, products, { categories: ['flower'], target: { amount: 28, unit: 'g' }, maxAgeHours: 24, now });
  assert.deepEqual(r.products.map((p) => p.id), ['ok']);
  assert.ok(r.plans.every((p) => p.lines.every((l) => l.product.id === 'ok')));
  assert.deepEqual(r.storesStale.map((s) => s.id), ['tru:b']);
  assert.equal(r.storesSearched, 1);

  // Plans never ask for more units than are in stock
  const low = [prod({ id: 'two', storeId: 'muv:a', name: 'Two', amount: 14, price: 30, qtyAvailable: 2 })];
  const r2 = search(stores, low, { target: { amount: 56, unit: 'g' } });
  assert.equal(r2.plans.length, 0);
});

test('MÜV product links match muvfl.com URL format', async () => {
  const { muvProductPath } = await import('../src/scrapers/muv.ts');
  // Real URLs copied from muvfl.com menu pages.
  const p = { brand: { name: '(the) Essence' }, name: 'Minty Blizzard', subcategory: { name: 'Whole' }, category: { name: 'Flower', id: 3485 }, productType: null, qualityLine: null };
  assert.equal(muvProductPath('apollo-beach', p, { id: 518320, name: '3.5g' }),
    '/locations/apollo-beach/menu/menu/flower-3485/the-essence-minty-blizzard-whole-flower-3.5g-518320');
  const e = { brand: { name: 'Encore ' }, name: 'Concord Grape RSO Soft Chews', subcategory: { name: 'RSO Soft Chews' }, category: { name: 'Edibles', id: 3488 } };
  assert.equal(muvProductPath('apollo-beach', e, { id: 192981, name: '100mg [10-Pack]' }),
    '/locations/apollo-beach/menu/menu/edibles-3488/encore-concord-grape-rso-soft-chews-rso-soft-chews-edible-100mg-10-pack-192981');
});

test('store hours: parsing, time zones, open/closed labels', async () => {
  const { parseRange, to24h, openStatus, storeTimeZone } = await import('../src/hours.ts');
  assert.deepEqual(parseRange('9:00 am - 8:45 pm'), [['09:00', '20:45']]);
  assert.deepEqual(parseRange('10:00am - 6:00pm'), [['10:00', '18:00']]);
  assert.deepEqual(parseRange('Closed'), []);
  assert.equal(parseRange('whenever'), null);
  assert.equal(to24h('12:30 PM'), '12:30');
  assert.equal(to24h('12:00 am'), '00:00');
  assert.equal(storeTimeZone({ lat: 30.42, lng: -87.22 }), 'America/Chicago');   // Pensacola
  assert.equal(storeTimeZone({ lat: 29.81, lng: -85.3 }), 'America/New_York');   // Port St. Joe
  assert.equal(storeTimeZone({ lat: 28.54, lng: -81.38 }), 'America/New_York');  // Orlando
  const week = { sun: [['10:00', '17:00']], mon: [['09:00', '20:00']], tue: [['09:00', '20:00']], wed: [['09:00', '20:00']],
    thu: [['09:00', '20:00']], fri: [['09:00', '20:00']], sat: [] } as any;
  const orlando = { lat: 28.54, lng: -81.38, hours: week };
  // Mon Nov 2 2026 10:00 EST
  assert.deepEqual(openStatus(orlando, new Date('2026-11-02T15:00:00Z')), { open: true, closingSoon: false, label: 'Open · closes 8 PM' });
  // 19:30 EST → closing soon
  assert.equal(openStatus(orlando, new Date('2026-11-03T00:30:00Z'))!.label, 'Closes soon · 8 PM');
  // Fri 21:00 EST → closed Sat → opens Sun 10 AM
  assert.equal(openStatus(orlando, new Date('2026-11-07T02:00:00Z'))!.label, 'Closed · opens Sun 10 AM');
  // Same instant, Pensacola (Central) is an hour earlier: Mon 19:00 CST is still open
  assert.equal(openStatus({ ...orlando, lat: 30.42, lng: -87.22 }, new Date('2026-11-03T01:00:00Z'))!.open, true);
  assert.equal(openStatus({ lat: 28.5, lng: -81.4, hours: null }), null);
});

test('open-now and on-sale filters', () => {
  const week = { sun: [], mon: [['09:00', '20:00']], tue: [], wed: [], thu: [], fri: [], sat: [] } as any;
  const a = { ...store('muv:a', 'muv', 28.54, -81.38), hours: week };
  const b = { ...store('tru:b', 'trulieve', 28.6, -81.3), hours: { ...week, mon: [] } };
  const products = [
    prod({ id: '1', storeId: 'muv:a', name: 'A', amount: 3.5, price: 40, salePrice: 30 }),
    prod({ id: '2', storeId: 'tru:b', name: 'B', amount: 3.5, price: 20 }),
  ];
  const now = Date.parse('2026-11-02T15:00:00Z'); // Monday 10am ET
  assert.deepEqual(search([a, b], products, { openNow: true, now }).products.map((p) => p.id), ['1']);
  assert.deepEqual(search([a, b], products, { saleOnly: true }).products.map((p) => p.id), ['1']);
});

test('sale prices stop applying when the promo ends', async () => {
  const { zonedToUtc } = await import('../src/hours.ts');
  const { promoEndsAt } = await import('../src/scrapers/muv.ts');
  assert.equal(zonedToUtc('2026-11-05', '20:30'), '2026-11-06T01:30:00.000Z'); // EST
  assert.equal(zonedToUtc('2026-07-10', '12:00'), '2026-07-10T16:00:00.000Z'); // EDT
  assert.equal(promoEndsAt({ endDate: '2026-11-03T00:00:00Z', interval: ['20:30', '12:00'] }), '2026-11-03T17:00:00.000Z');
  assert.equal(promoEndsAt({ endDate: null, interval: [] }), null);
  const st = store('muv:a', 'muv', 28.54, -81.38);
  const p = prod({ id: 's', storeId: 'muv:a', name: 'Sale', amount: 3.5, price: 40, salePrice: 20, saleEndsAt: '2026-11-03T17:00:00.000Z' });
  const before = search([st], [p], { now: Date.parse('2026-11-03T16:00:00Z') }).products[0];
  const after = search([st], [p], { now: Date.parse('2026-11-03T18:00:00Z') }).products[0];
  assert.equal(before.effectivePrice, 20);
  assert.equal(after.effectivePrice, 40);
  assert.equal(search([st], [p], { saleOnly: true, now: Date.parse('2026-11-03T18:00:00Z') }).products.length, 0);
});

test('insights: price by THC, sizes, THC value, deals and sale days', async () => {
  const { computeInsights, upcomingSaleDays, weekdayOf, saleDaysForYear } = await import('../src/insights.ts');
  const thanksgiving2026 = saleDaysForYear(2026).find((d) => d.name === 'Green Wednesday')!;
  assert.equal(thanksgiving2026.date, '2026-11-25');
  assert.equal(saleDaysForYear(2027).find((d) => d.name === 'Black Friday')!.date, '2027-11-26');
  const up = upcomingSaleDays(new Date('2026-11-03T12:00:00Z'));
  assert.deepEqual(up.map((u) => u.name), ['Green Wednesday', 'Black Friday', 'Cyber Monday', '4/20']);
  assert.equal(up[0].daysAway, 22);
  assert.equal(weekdayOf('TRUsday Deals'), 'Tuesday');
  assert.equal(weekdayOf('Fire Friday'), 'Friday');
  assert.equal(weekdayOf('Bud Bargains'), null);
  assert.equal(weekdayOf('Sun Grown Specials'), null);
  assert.equal(weekdayOf('4 for $100 Monster Mix & Match'), null);
  assert.equal(weekdayOf('Wellness Wednesday'), 'Wednesday');

  const st = [store('muv:a', 'muv', 28.54, -81.38), store('tru:b', 'trulieve', 28.6, -81.3)];
  const ps: Product[] = [];
  for (let i = 0; i < 40; i++) {
    ps.push(prod({ id: `lo${i}`, storeId: 'muv:a', name: `Lo ${i}`, amount: 3.5, price: 21, thcPct: 16 }));               // $6/g
    ps.push(prod({ id: `hi${i}`, storeId: 'tru:b', name: `Hi ${i}`, amount: 3.5, price: 42, thcPct: 31,
      salePrice: 35, promo: 'Fall Flower Sale', collections: ['TRUsday Deals'] }));                                          // $10/g on sale
    ps.push(prod({ id: `oz${i}`, storeId: 'tru:b', name: `Oz ${i}`, amount: 14, price: 70, thcPct: 22 }));                 // $5/g
    ps.push(prod({ id: `ed${i}`, storeId: 'muv:a', name: `Gummy ${i}`, category: 'edible', amount: 100, amountUnit: 'mg', thcMg: 100, thcPct: null, price: 20 }));
  }
  const ins = computeInsights(st, ps, Date.parse('2026-11-03T12:00:00Z'));
  assert.equal(ins.listings, 160);
  assert.deepEqual(ins.flowerByThc.map((b) => [b.label, b.median]), [['15–18%', 6], ['21–24%', 5], ['30%+', 10]]);
  assert.deepEqual(ins.flowerBySize.map((s) => [s.size, s.median]), [[3.5, 8], [14, 5]]);
  assert.equal(ins.thcValue[0].label, 'Flower');
  assert.equal(ins.thcValue.at(-1)!.label, 'Edibles');
  assert.equal(ins.deals.current[0].name, 'Fall Flower Sale');
  assert.equal(ins.deals.current[0].medianOffPct, 17);
  assert.deepEqual(ins.deals.weekly.map((w) => [w.day, w.name, w.listings]), [['Tuesday', 'TRUsday Deals', 40]]);
  assert.ok(ins.takeaways.some((t) => t.startsWith('THC drives flower prices')));
  assert.ok(ins.takeaways.some((t) => t.includes('Best bulk value: 14g')));
});

test('each current deal shows its own end time, not an overlapping promo’s', async () => {
  const { computeInsights } = await import('../src/insights.ts');
  const st = [store('muv:a', 'muv', 28.54, -81.38)];
  const ps: Product[] = [];
  for (let i = 0; i < 25; i++) ps.push(prod({ id: `x${i}`, storeId: 'muv:a', name: `X ${i}`, amount: 1, price: 50, salePrice: 30,
    promo: 'Flash Sale · Extracts: 40% OFF', saleEndsAt: '2026-11-03T17:00:00.000Z',
    promoEnds: { 'Flash Sale': '2026-11-03T17:00:00.000Z', 'Extracts: 40% OFF': '2026-11-06T01:30:00.000Z' } }));
  const ins = computeInsights(st, ps, Date.parse('2026-11-03T12:00:00Z'));
  const ends = Object.fromEntries(ins.deals.current.map((d) => [d.name, d.endsAt]));
  assert.equal(ends['Flash Sale'], '2026-11-03T17:00:00.000Z');
  assert.equal(ends['Extracts: 40% OFF'], '2026-11-06T01:30:00.000Z');
});
