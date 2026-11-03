// Builds the static website (GitHub Pages) into ./site:
//   index.html, app.js, styles.css, lib.js (engine), static-api.js (in-browser API)
//   data/stores.json        all stores + meta (small; loaded first)
//   data/menus/<store>.json one file per store; the browser loads only stores in range
//   data/fl-zips.json
//
//   node scripts/build-site.ts [--db data/deals.db ...] [--out site] [--fallback-base https://x.github.io/repo/]
// --db may repeat (one DB per CI shard); for each store the most recently scraped copy wins.
// --fallback-base: stores with no fresh menu this run keep the menu currently on the live site
// (the browser still drops it once it is older than MAX_AGE_HOURS).
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { openDb, allStores, productsForStores } from '../src/db.ts';
import type { Product, Store } from '../src/types.ts';
import { bundleLib } from './bundle-lib.ts';
import { computeInsights } from '../src/insights.ts';

const { values: args } = parseArgs({
  options: {
    db: { type: 'string', multiple: true },
    out: { type: 'string', default: 'site' },
    'fallback-base': { type: 'string' },
    'max-age-hours': { type: 'string', default: process.env.MAX_MENU_AGE_HOURS ?? '12' },
    'refresh-note': { type: 'string', default: 'every 3 hours, 8am–11pm' },
    'repo-url': { type: 'string', default: process.env.REPO_URL ?? '' },
  },
});
const root = new URL('..', import.meta.url);
const OUT = new URL(`${args.out!.replace(/\/?$/, '/')}`, root);
const fileFor = (id: string) => `${id.replace(/[^a-zA-Z0-9_-]+/g, '__')}.json`;

// 1) Merge stores + menus from all DBs.
const stores = new Map<string, Store>();
const menus = new Map<string, Product[]>();
for (const path of args.db?.length ? args.db : ['data/deals.db']) {
  if (!existsSync(path)) { console.warn(`skip missing ${path}`); continue; }
  const db = openDb(path);
  const ss = allStores(db);
  const byStore = new Map<string, Product[]>();
  for (const p of productsForStores(db, ss.map((s) => s.id))) (byStore.get(p.storeId) ?? byStore.set(p.storeId, []).get(p.storeId)!).push(p);
  for (const s of ss) {
    const prev = stores.get(s.id);
    const newer = !prev || (s.lastScrapedAt ?? '') > (prev.lastScrapedAt ?? '');
    if (newer) stores.set(s.id, s);
    if (newer && byStore.get(s.id)?.length) menus.set(s.id, byStore.get(s.id)!);
  }
  db.close();
}

// 2) Fallback to the live site's copy for stores that didn't scrape this run.
if (args['fallback-base']) {
  const base = args['fallback-base'].replace(/\/?$/, '/');
  let prevIndex: any = null;
  try { prevIndex = await (await fetch(`${base}data/stores.json`)).json(); } catch { console.warn('no previous site to fall back to'); }
  const prevById = new Map<string, any>((prevIndex?.stores ?? []).map((s: any) => [s.id, s]));
  // Stores missing from this run entirely (e.g. an operator's store list failed) stay listed.
  for (const [id, prev] of prevById) {
    if (stores.has(id)) continue;
    const { menuFile, productCount, distanceMi, ...store } = prev;
    stores.set(id, store as Store);
  }
  let reused = 0;
  for (const s of stores.values()) {
    if (!s.menuSupported || menus.has(s.id)) continue;
    const prev = prevById.get(s.id);
    if (!prev?.menuFile) continue;
    try {
      const prods = (await (await fetch(`${base}data/menus/${prev.menuFile}`)).json()) as Product[];
      menus.set(s.id, prods.map((p) => ({ ...p, storeId: s.id })));
      s.lastScrapedAt = prev.lastScrapedAt;
      reused++;
    } catch { /* gone */ }
  }
  console.log(`fallback: reused ${reused} menus from ${base}`);
}

// 3) Write data files.
rmSync(OUT, { recursive: true, force: true });
mkdirSync(new URL('data/menus/', OUT), { recursive: true });
const storeList = [...stores.values()].sort((a, b) => a.id.localeCompare(b.id)).map((s) => {
  const prods = menus.get(s.id);
  if (prods?.length) {
    // storeId is implied by the file; image is unused by the UI.
    writeFileSync(new URL(`data/menus/${fileFor(s.id)}`, OUT), JSON.stringify(prods.map(({ storeId, image, ...p }) => p)));
  }
  return { ...s, menuFile: prods?.length ? fileFor(s.id) : null, productCount: prods?.length ?? 0 };
});
const operators = new Map<string, { key: string; name: string; stores: number; withMenus: number }>();
for (const s of storeList) {
  const o = operators.get(s.operator) ?? { key: s.operator, name: s.operatorName, stores: 0, withMenus: 0 };
  o.stores++; if (s.menuFile) o.withMenus++;
  operators.set(s.operator, o);
}
const scraped = storeList.filter((s) => s.menuFile).map((s) => s.lastScrapedAt!).sort();
const meta = {
  operators: [...operators.values()],
  categories: ['flower', 'pre-roll', 'vape', 'concentrate', 'edible', 'oral', 'topical', 'other'],
  productCount: storeList.reduce((n, s) => n + s.productCount, 0),
  oldestScrape: scraped[0] ?? null,
  newestScrape: scraped.at(-1) ?? null,
  builtAt: new Date().toISOString(),
  maxAgeHours: Number(args['max-age-hours']),
  refreshNote: args['refresh-note'],
};
writeFileSync(new URL('data/stores.json', OUT), JSON.stringify({ meta, stores: storeList }));
// Statewide market insights + deals, from every menu in this build.
const allProducts = [...menus.values()].flat();
const insights = computeInsights([...stores.values()], allProducts);
writeFileSync(new URL('data/insights.json', OUT), JSON.stringify(insights));
copyFileSync(new URL('data/fl-zips.json', root), new URL('data/fl-zips.json', OUT));

// 4) Write app files.
const read = (p: string) => readFileSync(new URL(p, root), 'utf8');
writeFileSync(new URL('lib.js', OUT), `(function(){\n${bundleLib()}\nwindow.FLDF_LIB = { route, selectStores, haversineMi, openStatus };\n})();\n`);
copyFileSync(new URL('public/static-api.js', root), new URL('static-api.js', OUT));
copyFileSync(new URL('public/app.js', root), new URL('app.js', OUT));
copyFileSync(new URL('public/insights.js', root), new URL('insights.js', OUT));
copyFileSync(new URL('public/styles.css', root), new URL('styles.css', OUT));
for (const f of ['favicon.svg', 'icon-180.png', 'icon-192.png', 'icon-512.png', 'manifest.webmanifest']) copyFileSync(new URL(`public/${f}`, root), new URL(f, OUT));
let html = read('public/index.html').replace('<script src="app.js" type="module"></script>',
  () => '<script src="lib.js"></script>\n<script src="static-api.js"></script>\n<script src="app.js" type="module"></script>');
if (args['repo-url']) html = html.replace('<!--REPO-->', () => ` · <a href="${args['repo-url']}">Source &amp; issues on GitHub</a>`);
writeFileSync(new URL('index.html', OUT), html);
writeFileSync(new URL('.nojekyll', OUT), '');
writeFileSync(new URL('404.html', OUT), html);

console.log(`site/: ${storeList.length} stores, ${storeList.filter((s) => s.menuFile).length} menus, ${meta.productCount} products`);
