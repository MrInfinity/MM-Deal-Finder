// In-browser API for the static (GitHub Pages) build. Loads the store index once, then only the
// menus of stores in the searched area, and runs the same engine the Node server uses.
(() => {
  const L = window.FLDF_LIB;
  let index = null;
  let zips = null;
  const menus = new Map(); // store id -> products
  const load = async (url) => {
    const r = await fetch(url, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`Couldn't load ${url} (${r.status})`);
    return r.json();
  };
  async function init() {
    if (!index) [index, zips] = await Promise.all([load('data/stores.json'), load('data/fl-zips.json')]);
  }
  function nearestZip(lat, lng) {
    let best = null;
    for (const [zip, [zl, zg]] of Object.entries(zips)) {
      const d = L.haversineMi(lat, lng, zl, zg);
      if (!best || d < best.distanceMi) best = { zip, distanceMi: d };
    }
    return best;
  }
  const zipLookup = (z) => { const h = zips[String(z).trim().slice(0, 5)]; return h ? { lat: h[0], lng: h[1] } : null; };
  const list = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

  async function ensureMenus(stores) {
    const need = stores.filter((s) => s.menuFile && !menus.has(s.id));
    let done = 0;
    const progress = () => window.FLDF_PROGRESS && window.FLDF_PROGRESS(done, need.length);
    if (need.length) progress();
    for (let i = 0; i < need.length; i += 10) {
      await Promise.all(need.slice(i, i + 10).map(async (s) => {
        try {
          const prods = await load(`data/menus/${s.menuFile}`);
          menus.set(s.id, prods.map((p) => ({ ...p, storeId: s.id })));
        } catch { /* leave unset so a later search retries this store */ }
        done++; progress();
      }));
    }
  }

  window.FLDF_STATIC = true;
  window.FLDF_API = async (path, qs) => {
    await init();
    if (path === '/api/meta') return index.meta;
    let products = [];
    if (path === '/api/search') {
      const zip = (qs.get('zip') || '').trim();
      const center = zip ? zipLookup(zip) : null;
      if (zip && !center) throw new Error(`Unknown Florida ZIP: ${zip}`);
      const radius = qs.get('radius');
      const sel = L.selectStores(index.stores, {
        center,
        radiusMi: center ? (radius === 'any' ? null : Number(radius) || 25) : null,
        operators: list(qs.get('operators')),
        storeIds: list(qs.get('stores')),
        onlyStoreIds: qs.get('only') === '1',
        openNow: qs.get('open') === '1',
      });
      await ensureMenus(sel.map((x) => x.store));
      for (const x of sel) products = products.concat(menus.get(x.store.id) || []);
    }
    const r = L.route(path, qs, { stores: index.stores, products }, zipLookup, { maxAgeHours: index.meta.maxAgeHours, nearestZip });
    if (r.status !== 200) throw new Error(r.body.error || 'Something went wrong');
    return r.body;
  };
})();
