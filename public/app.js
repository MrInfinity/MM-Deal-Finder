import { renderInsights, renderDeals, endsLabel } from './insights.js';
// FL Deal Finder frontend. Talks to /api/* on the Node server, or to the in-browser API
// (static-api.js) on the static site.
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => (n == null ? '—' : `$${n % 1 === 0 ? n.toFixed(0) : n.toFixed(2)}`);
const fmtNum = (n, d = 1) => (n == null ? '—' : String(Math.round(n * 10 ** d) / 10 ** d));
const unitLabel = (u) => (u === 'mg' ? 'mg' : u === 'ml' ? 'ml' : u === 'g' ? 'g' : '');
const saved = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch { /* storage unavailable */ } },
};

async function api(path, params = {}) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v != null && !(Array.isArray(v) && !v.length)));
  if (window.FLDF_API) return window.FLDF_API(path, qs);
  let res;
  try { res = await fetch(`${path}?${qs}`); } catch { throw new Error('Network error — check your connection and try again.'); }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Server error (${res.status})`);
  return body;
}

const CATS = [['flower', 'Flower'], ['pre-roll', 'Pre-rolls'], ['vape', 'Vapes'], ['concentrate', 'Concentrates'], ['edible', 'Edibles'], ['oral', 'Oral/Tinctures'], ['topical', 'Topicals']];
const GRAM_CATS = new Set(['flower', 'pre-roll', 'vape', 'concentrate']);
const SIZES = [1, 3.5, 7, 14, 28];
const STRAINS = [['indica', 'Indica'], ['sativa', 'Sativa'], ['hybrid', 'Hybrid'], ['cbd', 'CBD']];
const EXAMPLES = ['2 oz flower', 'an eighth over 25%', '1g live rosin', '1000mg gummies', 'cheapest vape carts', 'pre-rolls under $10'];
// Product links on these sites already point at the specific store. Others (Trulieve) show stock for
// whichever store the visitor has selected on that site, so the link alone can say "out of stock".
const LINKS_CARRY_STORE = new Set(['muv']);
const LIVE = !window.FLDF_API; // Node server: live stock re-check after each search
const PLANS_FIRST = 5;

const DEFAULTS = {
  q: '', zip: '', radius: '25', category: [], sizes: [], strainType: [], operators: [], stores: [],
  only: false, whole: false, sale: false, open: false, minThc: '', maxPrice: '', targetAmt: '', targetUnit: 'oz',
  sort: 'unit', planSort: 'price',
};
const BOOLS = new Set(['only', 'whole', 'sale', 'open']);
const clone = (o) => JSON.parse(JSON.stringify(o));
// Every visit starts empty: nothing location-related is remembered between visits.
const state = clone(DEFAULTS);
saved.set('zip', ''); saved.set('radius', ''); // clear values older versions stored

let meta = null;
let storeIndex = new Map(); // datalist label -> store
let allStores = [];
let lastResult = null;
let shownProducts = 0;
let shownPlans = PLANS_FIRST;
let pendingScroll = false;
const verified = new Map(); // product id -> { at, inStock, qty }
let verifyNote = '';

// ---------- URL hash (shareable searches) ----------
function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  if (![...h.keys()].length) return false;
  Object.assign(state, clone(DEFAULTS), { zip: state.zip, radius: state.radius });
  for (const k of Object.keys(DEFAULTS)) {
    if (k === 'zip' || !h.has(k)) continue;
    const v = h.get(k);
    state[k] = Array.isArray(DEFAULTS[k]) ? v.split(',').filter(Boolean) : BOOLS.has(k) ? v === '1' : v;
  }
  return true;
}
function hashString() {
  const h = new URLSearchParams();
  for (const [k, v] of Object.entries(state)) {
    if (k === 'zip') continue; // never put anyone's location in a shareable link
    const d = DEFAULTS[k];
    if (Array.isArray(v) ? v.length : v && v !== d) h.set(k, Array.isArray(v) ? v.join(',') : v === true ? '1' : v);
  }
  return h.toString();
}
function writeHash() {
  if (window.FLDF_NO_HASH) return; // hosts that only allow plain #names
  const s = hashString();
  if (location.hash.slice(1) !== s) history.replaceState(null, '', s ? `#${s}` : location.pathname + location.search);
}

// ---------- controls ----------
function chip(label, pressed, onClick, extra = '') {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'chip';
  b.setAttribute('aria-pressed', String(pressed));
  b.innerHTML = label + extra;
  b.addEventListener('click', onClick);
  return b;
}
const toggleIn = (arr, v) => { const i = arr.indexOf(v); i >= 0 ? arr.splice(i, 1) : arr.push(v); };
const change = (fn) => () => { fn(); renderControls(); go(); };

function renderControls() {
  const cat = $('#catChips'); cat.innerHTML = '';
  for (const [k, l] of CATS) cat.append(chip(esc(l), state.category.includes(k), change(() => toggleIn(state.category, k))));
  const sz = $('#sizeChips'); sz.innerHTML = '';
  for (const s of SIZES) sz.append(chip(`${s}g`, state.sizes.includes(String(s)), change(() => toggleIn(state.sizes, String(s)))));
  // Gram sizes don't apply to edibles/orals/topicals.
  $('#sizeField').hidden = state.category.length > 0 && !state.category.some((c) => GRAM_CATS.has(c));
  const st = $('#strainChips'); st.innerHTML = '';
  for (const [k, l] of STRAINS) st.append(chip(l, state.strainType.includes(k), change(() => toggleIn(state.strainType, k))));
  const op = $('#opChips'); op.innerHTML = '';
  for (const o of meta?.operators ?? []) {
    const b = chip(esc(o.name), state.operators.includes(o.key), change(() => toggleIn(state.operators, o.key)),
      ` <small>${o.withMenus ? `${o.withMenus} menus` : 'no menus'}</small>`);
    if (!o.withMenus) b.disabled = true;
    op.append(b);
  }
  const sc = $('#storeChips'); sc.innerHTML = '';
  for (const id of state.stores) {
    const s = allStores.find((x) => x.id === id);
    const b = chip(esc(s ? `${s.operatorName} · ${s.name}` : id), true, change(() => toggleIn(state.stores, id)));
    b.classList.add('x');
    b.setAttribute('aria-label', `Remove ${s ? `${s.operatorName} ${s.name}` : id}`);
    sc.append(b);
  }
  $('#onlyStores').checked = state.only;
  $('#qOpen').setAttribute('aria-pressed', String(state.open));
  $('#qSale').setAttribute('aria-pressed', String(state.sale));
  $('#qWhole').setAttribute('aria-pressed', String(state.whole));
  const n = state.category.length + state.sizes.length + state.strainType.length + state.operators.length + state.stores.length
    + (state.minThc ? 1 : 0) + (state.maxPrice ? 1 : 0) + (state.targetAmt ? 1 : 0)
    + (state.sort !== 'unit' ? 1 : 0) + (state.planSort !== 'price' ? 1 : 0);
  $('#filterCount').textContent = n ? String(n) : '';
}

function syncInputs() {
  for (const k of ['q', 'zip', 'radius', 'minThc', 'maxPrice', 'targetAmt', 'targetUnit', 'sort', 'planSort']) {
    const el = $(`#${k}`); if (el) el.value = state[k];
  }
}

async function loadStores() {
  try {
    const r = await api('/api/stores', { zip: /^\d{5}$/.test(state.zip) ? state.zip : '' });
    allStores = r.stores;
    storeIndex = new Map();
    const dl = $('#storeList'); dl.innerHTML = '';
    for (const s of r.stores) {
      const label = `${s.operatorName} · ${s.name}, ${s.city}${s.distanceMi != null ? ` (${fmtNum(s.distanceMi)} mi)` : ''}${s.menuSupported ? '' : ' — no menu'}`;
      storeIndex.set(label, s);
      const o = document.createElement('option'); o.value = label; dl.append(o);
    }
    renderControls();
  } catch { /* non-fatal: store picker stays empty */ }
}

// ---------- search ----------
const hasQuery = () => !!(state.q || state.category.length || state.targetAmt || state.stores.length);

let seq = 0;
async function go({ silent = false } = {}) {
  writeHash();
  const my = ++seq;
  const status = $('#status');
  if (state.zip && !/^\d{5}$/.test(state.zip)) { showWelcome(null); status.innerHTML = '<span class="err">Enter a 5-digit Florida ZIP code.</span>'; clearResults(); return; }
  if (!state.zip && state.radius !== 'any' && !(state.only && state.stores.length)) { showWelcome('zip'); status.innerHTML = ''; clearResults(); return; }
  if (!hasQuery()) { showWelcome('query'); status.innerHTML = ''; clearResults(); return; }
  showWelcome(null);
  if (!silent) { status.innerHTML = '<span class="spin"></span>Searching…'; verifyNote = ''; shownPlans = PLANS_FIRST; }
  window.FLDF_PROGRESS = (done, total) => {
    if (my === seq && total > 1) status.innerHTML = `<span class="spin"></span>Loading menus… ${done}/${total} stores`;
  };
  try {
    const r = await api('/api/search', {
      q: state.q, zip: state.zip, radius: state.zip ? state.radius : '', category: state.category.join(','),
      sizes: state.sizes.join(','), strainType: state.strainType.join(','), operators: state.operators.join(','),
      stores: state.stores.join(','), only: state.only ? '1' : '', whole: state.whole ? '1' : '',
      sale: state.sale ? '1' : '', open: state.open ? '1' : '', minThc: state.minThc, maxPrice: state.maxPrice,
      target: state.targetAmt ? `${state.targetAmt}${state.targetUnit}` : '', sort: state.sort, planSort: state.planSort, limit: 300,
    });
    if (my !== seq) return;
    lastResult = r;
    render(r);
    if (pendingScroll) { pendingScroll = false; $('#results').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    if (LIVE) verifyTop(r, my);
  } catch (e) {
    if (my !== seq) return;
    status.innerHTML = `<span class="err">${esc(e.message)}</span> <button type="button" class="link" id="retry">Try again</button>`;
    $('#retry').addEventListener('click', () => go());
    clearResults();
  }
}

function clearResults() { $('#plans').innerHTML = $('#products').innerHTML = $('#nomenu').innerHTML = ''; }

function showWelcome(kind) {
  const w = $('#welcome');
  if (!kind) { w.hidden = true; w.innerHTML = ''; w.dataset.kind = ''; return; }
  w.hidden = false;
  if (w.dataset.kind === kind) return; // keep the same buttons in place (a re-render would swallow taps)
  w.dataset.kind = kind;
  w.innerHTML = kind === 'zip'
    ? `<h2>Find the cheapest in-stock deals near you</h2>
       <p>Enter your ZIP code above, or tap <b>Near me</b>. Then search for what you want, like <i>2 oz flower</i>, and it finds the cheapest way to buy it at a dispensary nearby.</p>
       <button type="button" class="go small" id="wLocate">Use my location</button>`
    : `<h2>What are you looking for?</h2>
       <p>Type a product, strain or amount, or try one of these:</p>
       <div class="examples big">${EXAMPLES.map((e) => `<button type="button" data-q="${esc(e)}">${esc(e)}</button>`).join('')}</div>`;
  $('#wLocate')?.addEventListener('click', locate);
  for (const b of w.querySelectorAll('[data-q]')) b.addEventListener('click', () => runExample(b.dataset.q));
}

function runExample(q) { state.q = q; $('#q').value = q; pendingScroll = true; go(); }

// ---------- live stock re-check (Node server only) ----------
async function verifyTop(r, my) {
  const ids = new Set();
  for (const p of r.result.plans.slice(0, shownPlans)) for (const l of p.lines) ids.add(l.product.id);
  for (const h of r.result.products.slice(0, 20)) ids.add(h.id);
  const fresh = Date.now() - 3 * 60_000;
  const todo = [...ids].filter((id) => !(verified.get(id)?.at > fresh)).slice(0, 40);
  if (!todo.length) return;
  setVerifyStatus('checking');
  try {
    const v = await api('/api/verify', { ids: todo.join(',') });
    let gone = 0, changed = 0;
    for (const [id, x] of Object.entries(v.results)) {
      if (x.error) continue;
      verified.set(id, { at: Date.parse(v.checkedAt), inStock: x.inStock, qty: x.qty });
      if (!x.inStock) gone++;
      if (x.changed) changed++;
    }
    if (my !== seq) return;
    verifyNote = gone ? `${gone} item${gone > 1 ? 's' : ''} sold out since the last scan and ${gone > 1 ? 'were' : 'was'} removed.` : '';
    if (changed) await go({ silent: true });
    else render(lastResult);
    setVerifyStatus('done');
  } catch {
    if (my === seq) setVerifyStatus('failed');
  }
}
function setVerifyStatus(kind) {
  const el = $('#verify');
  if (!el) return;
  el.className = `verify ${kind}`;
  el.innerHTML = kind === 'checking' ? '<span class="spin"></span>Confirming stock with dispensaries…'
    : kind === 'failed' ? 'Couldn’t reach dispensaries to re-confirm stock; showing last scan.'
    : `Stock re-confirmed live for top results.${verifyNote ? ' ' + esc(verifyNote) : ''}`;
}

// ---------- rendering ----------
function ago(iso) {
  if (!iso) return 'never';
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} days ago`;
}
const directionsUrl = (s) => `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${s.address}, ${s.city}, FL ${s.zip}`)}`;
const telUrl = (p) => `tel:${String(p).replace(/[^\d+]/g, '')}`;

function statusBadge(storeId) {
  const st = lastResult?.result.storeStatus?.[storeId];
  if (!st) return '';
  return `<span class="hours ${st.open ? (st.closingSoon ? 'soon' : 'open') : 'closed'}">${esc(st.label)}</span>`;
}

/** "sale ends today 12 PM" when a sale price stops within 3 days. */
function saleEnds(h) {
  if (!h.saleEndsAt || !(h.effectivePrice < h.price - 0.005)) return '';
  const left = Date.parse(h.saleEndsAt) - Date.now();
  return left > 0 && left < 72 * 3600_000 ? ` <span class="ends">sale ${esc(endsLabel(h.saleEndsAt))}</span>` : '';
}

function stockBadge(h) {
  const v = verified.get(h.id);
  if (v && v.inStock) return `<span class="ok">✓ in stock${v.qty != null && v.qty < 10 ? ` (${v.qty} left)` : ''} · confirmed ${ago(new Date(v.at).toISOString())}</span>`;
  return `<span class="asof">in stock as of ${ago(h.scrapedAt)}${h.qtyAvailable != null && h.qtyAvailable < 10 ? ` · ${h.qtyAvailable} left` : ''}</span>`;
}

function storeHint(s) {
  if (LINKS_CARRY_STORE.has(s.operator) || !s.menuUrl) return '';
  return `<div class="storehint">ⓘ ${esc(s.operatorName)}'s site shows stock for the store you've selected there. <a href="${esc(s.menuUrl)}" target="_blank" rel="noopener">Select ${esc(s.name)}</a> (“Shop Here”) before opening these.</div>`;
}

function interpChips(i) {
  const out = [];
  if (i.categories?.length) out.push(i.categories.join(' / '));
  if (i.target) out.push(`≥ ${fmtNum(i.target.amount, 2)}${i.target.unit}${i.target.unit === 'g' && i.target.amount % 28 === 0 ? ` (${i.target.amount / 28} oz)` : ''}`);
  if (i.text) out.push(`“${i.text}”`);
  if (i.strainTypes?.length) out.push(i.strainTypes.join(', '));
  if (i.minThc != null) out.push(`THC ≥ ${i.minThc}%`);
  if (i.maxThc != null) out.push(`THC ≤ ${i.maxThc}%`);
  if (i.maxPrice != null) out.push(`≤ ${money(i.maxPrice)}`);
  if (i.excludeShake) out.push('no shake/ground');
  if (i.saleOnly) out.push('on sale');
  if (i.openNow) out.push('open now');
  if (i.sizes?.length) out.push(`${i.sizes.join(', ')}g packages`);
  if (i.operators?.length) out.push(i.operators.map((k) => meta?.operators.find((o) => o.key === k)?.name ?? k).join(', '));
  if (i.storeIds?.length) out.push(`${i.storeIds.length} picked store${i.storeIds.length > 1 ? 's' : ''}${i.onlyStoreIds ? ' only' : ''}`);
  if (i.radiusMi != null) out.push(`within ${i.radiusMi} mi`);
  else if (state.zip) out.push('anywhere in FL');
  return out.map((t) => `<span>${esc(t)}</span>`).join('');
}

function render(r) {
  const { result, interpreted } = r;
  $('#status').innerHTML = `<div class="statusrow"><span>${result.totalMatches.toLocaleString()} matching product${result.totalMatches === 1 ? '' : 's'} across ${result.storesSearched} store menu${result.storesSearched === 1 ? '' : 's'}</span>
      ${window.FLDF_NO_HASH ? '' : '<button type="button" class="link" id="share">Share</button>'}</div>
    <div class="interp">${interpChips(interpreted)}</div>
    ${LIVE ? '<div id="verify" class="verify"></div>'
      : window.FLDF_STATIC ? `<div class="verify">In stock as of the last menu refresh (${ago(meta?.newestScrape)}). Menus refresh ${esc(meta?.refreshNote || 'several times a day')}.</div>`
      : '<div class="verify">Snapshot: stock shown as of the capture time.</div>'}`;
  $('#share')?.addEventListener('click', share);
  if (LIVE && verifyNote) setVerifyStatus('done');
  renderPlans(result.plans, interpreted.target);
  shownProducts = 0;
  $('#products').innerHTML = result.products.length
    ? `<h2>Products <small>by ${esc($('#sort').selectedOptions[0].textContent.toLowerCase())}</small></h2><div id="plist"></div>`
    : `<div class="empty"><p><b>No in-stock products match.</b></p><ul>${emptyTips(interpreted, result)}</ul></div>`;
  for (const b of document.querySelectorAll('[data-fix]')) b.addEventListener('click', () => applyFix(b.dataset.fix));
  moreProducts();
  const notes = [];
  const nm = result.storesWithoutMenus;
  if (nm.length) {
    const byOp = {};
    for (const s of nm) (byOp[s.operatorName] ??= []).push(s);
    notes.push(`Not included: ${Object.entries(byOp).map(([op, ss]) =>
      `<b>${esc(op)}</b> (${ss.length} store${ss.length > 1 ? 's' : ''} in range)`).join(', ')}. Their online menus can't be read automatically yet, so check their sites directly.`);
  }
  const st = result.storesStale ?? [];
  if (st.length) notes.push(`Left out because their stock hasn't been checked recently: ${st.slice(0, 6).map((s) => `${esc(s.operatorName)} ${esc(s.name)}`).join(', ')}${st.length > 6 ? ` +${st.length - 6} more` : ''}.`);
  $('#nomenu').innerHTML = notes.map((n) => `<div class="note">${n}</div>`).join('');
}

function emptyTips(i, result) {
  const tips = [];
  if (result.storesSearched === 0) tips.push(state.open ? 'No stores with menus are open right now in this area. <button type="button" class="link" data-fix="open">Include closed stores</button>' : 'No dispensaries with readable menus in this area. <button type="button" class="link" data-fix="radius">Search a wider area</button>');
  else {
    if (i.radiusMi != null && i.radiusMi < 100) tips.push('<button type="button" class="link" data-fix="radius">Search a wider area</button>');
    if (state.open) tips.push('<button type="button" class="link" data-fix="open">Include closed stores</button>');
    if (state.sale) tips.push('<button type="button" class="link" data-fix="sale">Include items not on sale</button>');
    if (i.minThc != null || i.maxThc != null || i.maxPrice != null || i.sizes?.length || i.strainTypes?.length || state.whole) tips.push('<button type="button" class="link" data-fix="filters">Clear filters</button>');
    if (i.text) tips.push(`Check the spelling of “${esc(i.text)}”, or search a category like <i>flower</i>.`);
  }
  return tips.map((t) => `<li>${t}</li>`).join('');
}
function applyFix(kind) {
  if (kind === 'radius') state.radius = ({ 5: '10', 10: '25', 25: '50', 50: '100' })[state.radius] ?? 'any';
  if (kind === 'open') state.open = false;
  if (kind === 'sale') state.sale = false;
  if (kind === 'filters') Object.assign(state, { minThc: '', maxPrice: '', sizes: [], strainType: [], whole: false });
  syncInputs(); renderControls(); go();
}

function planCard(p, idx, u) {
  const regular = p.lines.reduce((s, l) => s + l.product.price * l.qty, 0);
  const save = regular - p.totalPrice;
  const thc = p.thcRange ? (p.thcRange[0] === p.thcRange[1] ? `THC ${fmtNum(p.thcRange[0])}%` : `THC ${fmtNum(p.thcRange[0])}–${fmtNum(p.thcRange[1])}%`) : '';
  const also = p.alsoAt?.length ? `<div class="also">Also in stock at the same price: ${p.alsoAt.slice(0, 3).map((a) => `${esc(a.store.name)}${a.distanceMi != null ? ` (${fmtNum(a.distanceMi)} mi)` : ''}`).join(', ')}${p.alsoAt.length > 3 ? ` +${p.alsoAt.length - 3} more` : ''}</div>` : '';
  const lines = p.lines.map((l) => `<li><span>${l.qty} × <a href="${esc(l.product.url)}" target="_blank" rel="noopener">${esc(l.product.name)}</a> ${fmtNum(l.product.amount, 2)}${u}${l.product.thcPct != null ? ` · ${fmtNum(l.product.thcPct)}%` : ''}<br><small>${stockBadge(l.product)}${saleEnds(l.product)}</small></span><span>${money(l.product.effectivePrice)} ea</span></li>`).join('');
  const s = p.store;
  return `<article class="plan${idx === 0 ? ' best' : ''}">
    <div><div class="rank">${idx === 0 ? 'BEST ' : ''}#${idx + 1}${p.kind === 'mix' ? ' · MIX' : ''}</div><div class="title">${esc(p.title)}</div></div>
    <div><div class="total">${money(p.totalPrice)}</div><div class="ppu">${money(p.pricePerUnit)}/${u}</div></div>
    <div class="how">${esc(p.summary)}</div>
    <div class="ppu">${save > 0.5 ? `<span class="save">save ${money(save)}</span>` : ''}</div>
    <div class="meta">${fmtNum(p.totalAmount, 2)}${u} total${p.overshoot > 0.01 ? ` (+${fmtNum(p.overshoot, 2)}${u} extra)` : ''}${thc ? ` · ${thc}` : ''}${p.pricePerMgThc ? ` · ${money(p.pricePerMgThc * 100)}/100mg THC` : ''}</div>
    <div class="where2"><b>${esc(s.operatorName)} ${esc(s.name)}</b>${p.distanceMi != null ? ` · ${fmtNum(p.distanceMi)} mi` : ''} ${statusBadge(s.id)}<br>${esc(s.address)}, ${esc(s.city)}
      <span class="actions"><a href="${directionsUrl(s)}" target="_blank" rel="noopener">Directions</a>${s.phone ? ` · <a href="${telUrl(s.phone)}">Call</a>` : ''}${s.menuUrl ? ` · <a href="${esc(s.menuUrl)}" target="_blank" rel="noopener">Store page</a>` : ''}</span></div>
    ${storeHint(s)}
    <ul class="lines">${lines}</ul>
    ${p.alternatives?.length ? `<div class="also"><b>Same price, other strains:</b> ${p.alternatives.slice(0, 8).map((a) => `<a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.strain || a.name)}</a>${a.thcPct != null ? ` ${fmtNum(a.thcPct)}%` : ''}`).join(', ')}${p.alternatives.length > 8 ? ` +${p.alternatives.length - 8} more` : ''}</div>` : ''}
    ${also}
  </article>`;
}

function renderPlans(plans, target) {
  const el = $('#plans');
  if (!target) { el.innerHTML = ''; return; }
  const u = target.unit;
  const head = `<h2>Best ways to get ${fmtNum(target.amount, 2)}${u}${u === 'g' && target.amount % 7 === 0 && target.amount >= 7 ? ` <small>${target.amount / 28} oz</small>` : ''}</h2>`;
  if (!plans.length) { el.innerHTML = `${head}<p class="empty">No single store has enough in stock to reach that amount with these filters.</p>`; return; }
  el.innerHTML = head + plans.slice(0, shownPlans).map((p, i) => planCard(p, i, u)).join('')
    + (plans.length > shownPlans ? `<button type="button" class="more" id="morePlans">Show more ways to buy (${plans.length - shownPlans} more)</button>` : '');
  $('#morePlans')?.addEventListener('click', () => { shownPlans = plans.length; renderPlans(plans, target); if (LIVE) verifyTop(lastResult, seq); });
}

function prodRow(h) {
  const u = unitLabel(h.amountUnit);
  const size = h.amount ? `${fmtNum(h.amount, 2)}${u}` : 'each';
  const thc = h.thcPct != null ? (h.thcPctMax && h.thcPctMax !== h.thcPct ? `THC ${fmtNum(h.thcPct)}–${fmtNum(h.thcPctMax)}%` : `THC ${fmtNum(h.thcPct)}%`) : h.thcMg ? `${fmtNum(h.thcMg, 0)}mg THC` : '';
  const sale = h.effectivePrice < h.price - 0.005;
  return `<div class="prod">
    <div class="name"><a href="${esc(h.url)}" target="_blank" rel="noopener">${esc(h.name)}</a></div>
    <div class="price">${sale ? `<s>${money(h.price)}</s>` : ''}${money(h.effectivePrice)}</div>
    <div class="sub1">${[h.brand, h.subcategory, h.strainType].filter(Boolean).map(esc).join(' · ')}</div>
    <div class="ppu">${h.pricePerUnit != null ? `${money(h.pricePerUnit)}/${u}` : ''}</div>
    <div class="sub2">${[size, thc, `${esc(h.store.operatorName)} ${esc(h.store.name)}${h.distanceMi != null ? ` · ${fmtNum(h.distanceMi)} mi` : ''}`].filter(Boolean).join(' · ')} ${statusBadge(h.store.id)}${h.promo && sale ? `<br><span class="promo">${esc(h.promo)}</span>${saleEnds(h)}` : ''}<br>${stockBadge(h)}${!LINKS_CARRY_STORE.has(h.store.operator) && h.store.menuUrl ? ` · <a href="${esc(h.store.menuUrl)}" target="_blank" rel="noopener">set store to ${esc(h.store.name)} on ${esc(h.store.operatorName)}'s site first</a>` : ''}</div>
  </div>`;
}

function moreProducts() {
  const list = $('#plist');
  if (!list || !lastResult) return;
  const items = lastResult.result.products;
  const next = items.slice(shownProducts, shownProducts + 40);
  shownProducts += next.length;
  list.insertAdjacentHTML('beforeend', next.map(prodRow).join(''));
  $('#products .more')?.remove();
  if (shownProducts < items.length) {
    const b = document.createElement('button');
    b.className = 'more'; b.type = 'button'; b.textContent = `Show more products (${items.length - shownProducts} more)`;
    b.addEventListener('click', moreProducts);
    $('#products').append(b);
  }
}

// ---------- actions ----------
async function share() {
  const url = location.href;
  const btn = $('#share');
  try {
    if (navigator.share) { await navigator.share({ title: 'FL Deal Finder', url }); return; }
    await navigator.clipboard.writeText(url);
    if (btn) { btn.textContent = 'Link copied'; setTimeout(() => { if (btn.isConnected) btn.textContent = 'Share'; }, 2000); }
  } catch { /* user cancelled or clipboard blocked */ }
}

function locate() {
  const btn = $('#locate');
  const status = $('#status');
  if (!navigator.geolocation) { status.innerHTML = '<span class="err">Your browser can’t share its location. Enter a ZIP code instead.</span>'; return; }
  btn.classList.add('busy');
  status.innerHTML = '<span class="spin"></span>Finding your location…';
  navigator.geolocation.getCurrentPosition(async (pos) => {
    try {
      const r = await api('/api/nearzip', { lat: pos.coords.latitude.toFixed(4), lng: pos.coords.longitude.toFixed(4) });
      await setZip(r.zip);
    } catch (e) {
      status.innerHTML = `<span class="err">${esc(e.message)}</span>`;
    } finally { btn.classList.remove('busy'); }
  }, (err) => {
    btn.classList.remove('busy');
    status.innerHTML = `<span class="err">${err.code === 1 ? 'Location permission was denied.' : 'Couldn’t get your location.'} Enter a ZIP code instead.</span>`;
  }, { timeout: 15000, maximumAge: 10 * 60_000 });
}

async function setZip(z) {
  if (z === state.zip && $('#zip').value === z) return;
  state.zip = z;
  $('#zip').value = z;
  await loadStores();
  go();
}

function updateFreshness() {
  if (!meta) return;
  const menus = meta.operators.reduce((s, o) => s + o.withMenus, 0);
  $('#freshness').textContent = `${meta.productCount.toLocaleString()} in-stock products · ${menus} store menus · updated ${ago(meta.newestScrape)}`;
  const ageH = meta.newestScrape ? (Date.now() - Date.parse(meta.newestScrape)) / 3_600_000 : Infinity;
  const banner = $('#banner');
  banner.hidden = !(window.FLDF_STATIC && ageH > 6);
  banner.textContent = `Menus haven’t refreshed since ${ago(meta.newestScrape)}. Stores whose data gets too old are left out until the next refresh.`;
  const withMenus = meta.operators.filter((o) => o.withMenus).map((o) => o.name);
  const without = meta.operators.filter((o) => !o.withMenus).map((o) => o.name);
  if (withMenus.length) $('#coverage').textContent = `${withMenus.join(' and ')} menus.${without.length ? ` ${without.join(', ')} locations are listed but their menus aren't included yet.` : ''}`;
}

async function init() {
  readHash();
  syncInputs();
  const ex = $('#examples');
  for (const e of EXAMPLES) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = e;
    b.addEventListener('click', () => runExample(e));
    ex.append(b);
  }
  try {
    meta = await api('/api/meta');
    updateFreshness();
    setInterval(updateFreshness, 60_000);
  } catch (e) {
    $('#freshness').textContent = 'Couldn’t load dispensary data. Check your connection and reload.';
  }
  renderControls();
  loadStores();
  api('/api/insights').then((ins) => { renderInsights(ins); renderDeals(ins); }).catch(() => { /* optional section */ });

  $('#search').addEventListener('submit', (e) => { e.preventDefault(); state.q = $('#q').value.trim(); $('#q').blur(); pendingScroll = true; go(); });
  $('#zip').addEventListener('change', () => setZip($('#zip').value.trim()));
  $('#zip').addEventListener('input', () => { const z = $('#zip').value.trim(); if (/^\d{5}$/.test(z) && z !== state.zip) setZip(z); });
  $('#locate').addEventListener('click', locate);
  $('#radius').addEventListener('change', () => { state.radius = $('#radius').value; renderControls(); go(); });
  for (const k of ['sort', 'planSort', 'targetUnit']) $(`#${k}`).addEventListener('change', () => { state[k] = $(`#${k}`).value; renderControls(); go(); });
  for (const k of ['minThc', 'maxPrice', 'targetAmt']) $(`#${k}`).addEventListener('change', () => { state[k] = $(`#${k}`).value.trim(); renderControls(); go(); });
  $('#qOpen').addEventListener('click', change(() => { state.open = !state.open; }));
  $('#qSale').addEventListener('click', change(() => { state.sale = !state.sale; }));
  $('#qWhole').addEventListener('click', change(() => { state.whole = !state.whole; }));
  $('#onlyStores').addEventListener('change', () => { state.only = $('#onlyStores').checked; go(); });
  $('#storePick').addEventListener('change', () => {
    const s = storeIndex.get($('#storePick').value);
    if (s && !state.stores.includes(s.id)) { state.stores.push(s.id); renderControls(); go(); }
    $('#storePick').value = '';
  });
  $('#reset').addEventListener('click', () => {
    Object.assign(state, { ...clone(DEFAULTS), q: state.q, zip: state.zip, radius: state.radius });
    syncInputs(); renderControls(); go();
  });
  window.addEventListener('hashchange', () => { if (location.hash.slice(1) !== hashString() && readHash()) { syncInputs(); renderControls(); go(); } });
  go();
}
init();
