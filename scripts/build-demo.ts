// Builds dist/demo.html: a single self-contained page with a frozen data snapshot and the same
// search engine running in the browser. Handy for sharing/previewing without a server.
//   node scripts/build-demo.ts [--zip <ZIP> --radius 60]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { openDb, allStores, productsForStores } from '../src/db.ts';
import { haversineMi, zipToLatLng } from '../src/geo.ts';
import { bundleLib } from './bundle-lib.ts';

const { values: args } = parseArgs({ options: { zip: { type: 'string' }, radius: { type: 'string', default: '60' } } });
const root = new URL('..', import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), 'utf8');

// 1) Engine modules → one plain script.
const lib = bundleLib();

// 2) Data snapshot (optionally limited to an area), trimmed of fields the UI doesn't need.
const db = openDb();
let stores = allStores(db);
const center = args.zip ? zipToLatLng(args.zip) : null;
if (center) stores = stores.filter((s) => haversineMi(center.lat, center.lng, s.lat, s.lng) <= Number(args.radius));
const products = productsForStores(db, stores.map((s) => s.id)).map(({ image, ...p }) => p);
const zips = read('data/fl-zips.json');
const asOf = stores.map((s) => s.lastScrapedAt).filter(Boolean).sort().at(-1) ?? '';

const shim = `
${lib}
const DATA = ${JSON.stringify({ stores, products })};
const ZIPS = ${zips};
const zipLookup = (z) => { const h = ZIPS[String(z).slice(0, 5)]; return h ? { lat: h[0], lng: h[1] } : null; };
window.FLDF_DEFAULT_ZIP = ${JSON.stringify(args.zip ?? '')};
window.FLDF_NO_HASH = true;
window.FLDF_API = (path, qs) => {
  const r = route(path, qs, DATA, zipLookup);
  if (r.status !== 200) throw new Error(r.body.error || 'error');
  return r.body;
};`;

const html = read('public/index.html')
  .replace('<link rel="stylesheet" href="styles.css">', () => `<style>\n${read('public/styles.css')}\n</style>`)
  .replace('<script src="app.js" type="module"></script>', () =>
    `<script>(function(){${shim.replace(/<\/script/g, '<\\/script')}})();</script>\n<script type="module">\n${read('public/app.js')}\n</script>`)
  .replace('<footer>', () => `<footer><b>Demo snapshot</b> of ${stores.filter((s) => s.lastScrapedAt).length} store menus captured ${asOf.slice(0, 16).replace('T', ' ')} UTC — not live prices. `);

mkdirSync(new URL('dist/', root), { recursive: true });
writeFileSync(new URL('dist/demo.html', root), html);
console.log(`dist/demo.html: ${(html.length / 1e6).toFixed(1)} MB, ${stores.length} stores, ${products.length} products`);
