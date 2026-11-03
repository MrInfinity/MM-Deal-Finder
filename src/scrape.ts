// CLI: refresh store lists and menus.
//   node src/scrape.ts                         # all operators, all stores (slow: ~250 menus)
//   node src/scrape.ts --zip <ZIP> --radius 50  # only menus near a ZIP
//   node src/scrape.ts --operators muv --stores muv:apollo-beach
//   node src/scrape.ts --stores-only           # refresh locations, skip menus
//   node src/scrape.ts --shard 2/4             # only every 4th store menu (offset 2) — for parallel CI jobs
import { parseArgs } from 'node:util';
import { openDb, upsertStores, replaceMenu, allStores } from './db.ts';
import { SCRAPERS } from './scrapers/index.ts';
import { haversineMi, zipToLatLng } from './geo.ts';
import type { Store } from './types.ts';

const { values: args } = parseArgs({
  options: {
    operators: { type: 'string' },
    zip: { type: 'string' },
    radius: { type: 'string', default: '50' },
    stores: { type: 'string' },
    'stores-only': { type: 'boolean', default: false },
    'max-age-hours': { type: 'string' }, // skip menus scraped more recently than this
    shard: { type: 'string' },           // "i/n": scrape the i-th of n slices of each operator's stores
  },
});

const db = openDb();
const wanted = args.operators ? args.operators.split(',') : SCRAPERS.map((s) => s.key);
const center = args.zip ? zipToLatLng(args.zip) : null;
if (args.zip && !center) throw new Error(`Unknown Florida ZIP ${args.zip}`);
const radius = Number(args.radius);
const onlyStores = args.stores ? new Set(args.stores.split(',')) : null;
const maxAgeMs = args['max-age-hours'] ? Number(args['max-age-hours']) * 3600_000 : null;
const [shardIdx, shardCount] = (args.shard ?? '0/1').split('/').map(Number);
if (!(shardCount >= 1 && shardIdx >= 0 && shardIdx < shardCount)) throw new Error(`Bad --shard ${args.shard}`);

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

await Promise.all(SCRAPERS.filter((s) => wanted.includes(s.key)).map(async (scraper) => {
  let stores: Store[];
  try {
    stores = await scraper.listStores();
    upsertStores(db, stores);
    log(`${scraper.name}: ${stores.length} FL stores`);
  } catch (e) {
    log(`${scraper.name}: store list FAILED — ${(e as Error).message}`);
    return;
  }
  if (args['stores-only'] || !scraper.scrapeMenu) return;

  const known = new Map(allStores(db).map((s) => [s.id, s]));
  const targets = [...stores].sort((a, b) => a.id.localeCompare(b.id)).filter((_, i) => i % shardCount === shardIdx).filter((s) => {
    if (onlyStores && !onlyStores.has(s.id)) return false;
    if (center && haversineMi(center.lat, center.lng, s.lat, s.lng) > radius) return false;
    const last = known.get(s.id)?.lastScrapedAt;
    if (maxAgeMs && last && Date.now() - Date.parse(last) < maxAgeMs) return false;
    return true;
  });
  log(`${scraper.name}: scraping ${targets.length} menus`);
  let ok = 0;
  for (const store of targets) {
    try {
      const products = await scraper.scrapeMenu(store);
      replaceMenu(db, store.id, products);
      ok++;
      log(`  ${store.id}: ${products.length} products`);
    } catch (e) {
      log(`  ${store.id}: FAILED — ${(e as Error).message}`);
    }
  }
  log(`${scraper.name}: done, ${ok}/${targets.length} menus`);
  if (targets.length && ok === 0) process.exitCode = 1;
}));

// Fold the write-ahead log into the main file so the .db is complete on its own (CI uploads only *.db).
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
db.close();
