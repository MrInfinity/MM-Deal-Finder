// Florida price snapshot + deals sections. Plain SVG charts with hover/tap/keyboard tooltips and a table view.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usd = (n) => `$${Number(n).toFixed(2)}`;
const commas = (n) => Number(n).toLocaleString();
const ET = 'America/New_York';

function ago(iso) {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} days ago`;
}

/** "ends today 12 PM" / "ends tomorrow 8:30 PM" / "ends Thu 8:30 PM" / "ends Nov 29" */
export function endsLabel(iso) {
  const end = new Date(iso);
  const day = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: ET, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  const diffDays = Math.round((Date.parse(day(end)) - Date.parse(day(new Date()))) / 86400_000);
  const time = new Intl.DateTimeFormat('en-US', { timeZone: ET, hour: 'numeric', minute: '2-digit' }).format(end).replace(':00', '');
  if (diffDays <= 0) return `ends today ${time}`;
  if (diffDays === 1) return `ends tomorrow ${time}`;
  if (diffDays < 7) return `ends ${new Intl.DateTimeFormat('en-US', { timeZone: ET, weekday: 'short' }).format(end)} ${time}`;
  return `ends ${new Intl.DateTimeFormat('en-US', { timeZone: ET, month: 'short', day: 'numeric' }).format(end)}`;
}

// ---------- charts ----------
let chartSeq = 0;
function niceMax(v) {
  const step = v <= 6 ? 1 : v <= 12 ? 2 : v <= 30 ? 5 : 10;
  return { max: Math.ceil(v / step) * step, step };
}

/**
 * Column chart, one series. bars: [{ label, value, tip }]; labelAt: indexes that get a value label.
 */
function columnChart({ bars, fmt, labelAt = [], title, desc, W }) {
  const id = `c${++chartSeq}`;
  const H = 220, L = 40, R = 6, T = 22, B = 30;
  const { max, step } = niceMax(Math.max(...bars.map((b) => b.value)) * 1.08);
  const y = (v) => T + (H - T - B) * (1 - v / max);
  const band = (W - L - R) / bars.length;
  const bw = Math.min(24, band * 0.6); // drawn 1:1 in CSS pixels; bars never thicker than 24px
  let grid = '';
  for (let v = 0; v <= max + 1e-9; v += step) {
    grid += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="grid"/>`
      + `<text x="${L - 6}" y="${y(v) + 4}" class="tick" text-anchor="end">${fmt(v, true)}</text>`;
  }
  const r = 4;
  const marks = bars.map((b, i) => {
    const x = L + band * i + (band - bw) / 2, top = y(b.value), base = y(0), h = Math.max(base - top, 1);
    const rr = Math.min(r, h);
    const path = `M${x},${base}V${top + rr}Q${x},${top} ${x + rr},${top}H${x + bw - rr}Q${x + bw},${top} ${x + bw},${top + rr}V${base}Z`;
    const lbl = labelAt.includes(i) ? `<text x="${x + bw / 2}" y="${top - 6}" class="val" text-anchor="middle">${fmt(b.value)}</text>` : '';
    return `<path d="${path}" class="bar"/>${lbl}
      <text x="${L + band * i + band / 2}" y="${H - B + 18}" class="tick" text-anchor="middle">${esc(b.label)}</text>
      <rect x="${L + band * i}" y="${T}" width="${band}" height="${H - T - B}" class="hit" tabindex="0" data-tip="${esc(b.tip)}" aria-label="${esc(b.tip)}"/>`;
  }).join('');
  return `<figure class="chart" id="${id}">
    <figcaption><b>${esc(title)}</b>${desc ? `<span>${esc(desc)}</span>` : ''}</figcaption>
    <div class="plot"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">${grid}${marks}</svg><div class="tip" hidden></div></div>
  </figure>`;
}

/** Horizontal bar chart (ranked), one series. */
function barChart({ bars, fmt, labelAt = [], title, desc, W }) {
  const id = `c${++chartSeq}`;
  const rowH = 30, L = 116, R = 62, T = 6;
  const H = T + rowH * bars.length + 6;
  const max = Math.max(...bars.map((b) => b.value));
  const x = (v) => L + (W - L - R) * (v / max);
  const bh = 16, r = 4;
  const marks = bars.map((b, i) => {
    const yy = T + rowH * i + (rowH - bh) / 2, end = Math.max(x(b.value), L + 2), rr = Math.min(r, end - L);
    const path = `M${L},${yy}H${end - rr}Q${end},${yy} ${end},${yy + rr}V${yy + bh - rr}Q${end},${yy + bh} ${end - rr},${yy + bh}H${L}Z`;
    const lbl = labelAt.includes(i) ? `<text x="${end + 6}" y="${yy + bh / 2 + 4}" class="val">${fmt(b.value)}</text>` : '';
    return `<text x="${L - 8}" y="${yy + bh / 2 + 4}" class="tick" text-anchor="end">${esc(b.label)}</text><path d="${path}" class="bar"/>${lbl}
      <rect x="0" y="${T + rowH * i}" width="${W}" height="${rowH}" class="hit" tabindex="0" data-tip="${esc(b.tip)}" aria-label="${esc(b.tip)}"/>`;
  }).join('');
  return `<figure class="chart" id="${id}">
    <figcaption><b>${esc(title)}</b>${desc ? `<span>${esc(desc)}</span>` : ''}</figcaption>
    <div class="plot"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}"><line x1="${L}" x2="${L}" y1="${T}" y2="${H - 6}" class="grid"/>${marks}</svg><div class="tip" hidden></div></div>
  </figure>`;
}

function tableView(caption, head, rows) {
  return `<details class="tableview"><summary>Show as table</summary><table><caption class="sr">${esc(caption)}</caption>
    <thead><tr>${head.map((h) => `<th scope="col">${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c, i) => (i === 0 ? `<th scope="row">${esc(c)}</th>` : `<td>${esc(c)}</td>`)).join('')}</tr>`).join('')}</tbody></table></details>`;
}

function wireTooltips(root) {
  for (const plot of root.querySelectorAll('.plot')) {
    const tip = plot.querySelector('.tip');
    const show = (el, ev) => {
      tip.textContent = el.dataset.tip;
      tip.hidden = false;
      const box = plot.getBoundingClientRect(), r = el.getBoundingClientRect();
      let cx = ev && ev.clientX ? ev.clientX - box.left : r.left - box.left + r.width / 2;
      const cy = ev && ev.clientY ? ev.clientY - box.top : r.top - box.top + 12;
      const w = tip.offsetWidth;
      cx = Math.max(w / 2 + 4, Math.min(box.width - w / 2 - 4, cx));
      tip.style.left = `${cx}px`;
      tip.style.top = `${Math.max(0, cy - tip.offsetHeight - 12)}px`;
      for (const h of plot.querySelectorAll('.hit.on')) h.classList.remove('on');
      el.classList.add('on');
    };
    const hide = () => { tip.hidden = true; for (const h of plot.querySelectorAll('.hit.on')) h.classList.remove('on'); };
    for (const hit of plot.querySelectorAll('.hit')) {
      hit.addEventListener('pointermove', (e) => show(hit, e));
      hit.addEventListener('pointerdown', (e) => show(hit, e));
      hit.addEventListener('focus', () => show(hit));
      hit.addEventListener('blur', hide);
    }
    plot.addEventListener('pointerleave', hide);
  }
}

// ---------- sections ----------
export function renderInsights(ins) {
  const sec = document.querySelector('#insights');
  if (!ins || !ins.listings) { sec.hidden = true; return; }
  sec.hidden = false;
  const body = document.querySelector('#insightsBody');
  const W = Math.round(Math.min(Math.max(body.clientWidth || 340, 280), 820));
  lastInsights = ins; lastWidth = body.clientWidth;
  const parts = [];
  parts.push(`<p class="lede">From ${commas(ins.listings)} in-stock listings at ${ins.storesWithMenus} dispensaries across Florida · updated ${ago(ins.generatedAt)}. Prices are menu prices, including current sales.</p>`);
  if (ins.takeaways?.length) parts.push(`<ul class="takeaways">${ins.takeaways.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>`);

  if (ins.flowerByThc?.length) {
    const b = ins.flowerByThc;
    const peak = b.reduce((m, x, i) => (x.median > b[m].median ? i : m), 0);
    parts.push(columnChart({
      W, title: 'Whole flower: price per gram by THC %',
      desc: 'Typical (median) price per gram at each THC % range. Tap a bar for details.',
      fmt: (v, tick) => (tick ? `$${v}` : usd(v)),
      labelAt: [...new Set([0, peak, b.length - 1])],
      bars: b.map((x) => ({ label: x.label.replace('Under ', '<').replace(/%/g, ''), value: x.median,
        tip: `${x.label} THC: ${usd(x.median)}/g typical · middle half ${usd(x.p25)}–${usd(x.p75)} · ${commas(x.n)} listings` })),
    }));
    parts.push(tableView('Whole flower price per gram by THC %', ['THC', 'Typical $/g', 'Middle half', 'Listings'],
      b.map((x) => [x.label, usd(x.median), `${usd(x.p25)}–${usd(x.p75)}`, commas(x.n)])));
    if (ins.shake) parts.push(`<p class="note2">Shake &amp; ground flower (not charted): ${usd(ins.shake.median)}/g typical, mostly ${ins.shake.thcP25}–${ins.shake.thcP75}% THC.</p>`);
  }

  if (ins.flowerBySize?.length) {
    const s = ins.flowerBySize;
    const best = s.reduce((m, x, i) => (x.median < s[m].median ? i : m), 0);
    parts.push(columnChart({
      W, title: 'Whole flower: price per gram by package size',
      desc: 'Bigger isn’t always cheaper per gram.',
      fmt: (v, tick) => (tick ? `$${v}` : usd(v)),
      labelAt: [best],
      bars: s.map((x, i) => ({ label: `${x.size}g`, value: x.median,
        tip: `${x.size}g packages: ${usd(x.median)}/g typical · ${commas(x.n)} listings${i === best ? ' · best value' : ''}` })),
    }));
    parts.push(tableView('Price per gram by package size', ['Package', 'Typical $/g', 'Listings'], s.map((x) => [`${x.size}g`, usd(x.median), commas(x.n)])));
  }

  if (ins.thcValue?.length) {
    const v = ins.thcValue;
    parts.push(barChart({
      W, title: 'Cost per 100mg of THC, by product type',
      desc: 'Lower is more THC for your money.',
      fmt: usd,
      labelAt: [0, v.length - 1],
      bars: v.map((x) => ({ label: x.label, value: x.median, tip: `${x.label}: ${usd(x.median)} per 100mg THC typical · ${commas(x.n)} listings` })),
    }));
    parts.push(tableView('Cost per 100mg THC by product type', ['Type', 'Typical $ per 100mg THC', 'Listings'], v.map((x) => [x.label, usd(x.median), commas(x.n)])));
  }

  if (ins.operators?.length) {
    parts.push(`<h3>By dispensary chain</h3><div class="tiles">${ins.operators.map((o) => `
      <div class="tile"><div class="tlabel">${esc(o.name)}</div>
        <div class="tvalue">${o.flowerMedian != null ? `${usd(o.flowerMedian)}<small>/g</small>` : '—'}</div>
        <div class="tsub">whole flower, typical</div>
        <div class="tsub">${o.onSalePct}% of items on sale${o.medianOffPct != null ? `, usually ${o.medianOffPct}% off` : ''}</div></div>`).join('')}</div>`);
  }
  body.innerHTML = parts.join('');
  wireTooltips(sec);
}

// Redraw charts at the new width when the screen rotates or the window resizes.
let lastInsights = null, lastWidth = 0, resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const w = document.querySelector('#insightsBody')?.clientWidth ?? 0;
    if (lastInsights && Math.abs(w - lastWidth) > 30) { lastWidth = w; renderInsights(lastInsights); }
  }, 200);
});

export function renderDeals(ins) {
  const sec = document.querySelector('#deals');
  if (!ins?.deals) { sec.hidden = true; return; }
  const { current = [], weekly = [], bundles = [], upcoming = [] } = ins.deals;
  const now = Date.now();
  const live = current.filter((d) => !d.endsAt || Date.parse(d.endsAt) > now);
  const parts = [];
  const todayName = new Intl.DateTimeFormat('en-US', { timeZone: ET, weekday: 'long' }).format(new Date());

  // Coming-up first: it answers "should I wait?" at a glance.
  if (upcoming.length) {
    const fmt = (d) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(`${d}T12:00:00Z`));
    parts.push(`<h3>Big sale days coming up</h3><ul class="deallist upcoming">${upcoming.map((u) => `
      <li><span class="dname"><b>${esc(u.name)}</b> · ${fmt(u.date)} <span class="away">${u.daysAway === 0 ? 'today' : u.daysAway === 1 ? 'tomorrow' : `in ${u.daysAway} days`}</span></span>
        <span class="dmeta">${esc(u.note)}</span></li>`).join('')}</ul>`);
    const next = upcoming[0];
    if (next && next.daysAway <= 10 && next.daysAway > 0) parts.push(`<p class="note2"><b>Tip:</b> ${esc(next.name)} is ${next.daysAway === 1 ? 'tomorrow' : `${next.daysAway} days away`}. If you're not running low, it may be worth waiting.</p>`);
  }

  if (live.length) {
    const byOp = new Map();
    for (const d of live) (byOp.get(d.operatorName) ?? byOp.set(d.operatorName, []).get(d.operatorName)).push(d);
    parts.push(`<h3>On sale now</h3>${[...byOp].map(([op, ds]) => `
      <div class="dealgroup"><div class="dealop">${esc(op)}</div><ul class="deallist">${ds.map((d) => {
        const when = d.endsAt ? endsLabel(d.endsAt) : d.monthLong ? 'all month' : 'ongoing';
        const soon = d.endsAt && Date.parse(d.endsAt) - now < 48 * 3600_000;
        return `<li><span class="dname">${esc(d.name)}${d.medianOffPct != null ? ` <small>(typically ${d.medianOffPct}% off)</small>` : ''}</span>
          <span class="dmeta"><span class="when${soon ? ' soon' : ''}">${esc(when)}</span> · ${d.stores} store${d.stores === 1 ? '' : 's'}</span></li>`;
      }).join('')}</ul></div>`).join('')}`);
  }

  if (weekly.length) {
    parts.push(`<h3>Weekly deal days</h3><ul class="deallist">${weekly.map((w) => `
      <li><span class="dname"><b>${esc(w.day)}s</b>${w.day === todayName ? ' <span class="away today">today</span>' : ''} · ${esc(w.operatorName)} “${esc(w.name)}”</span><span class="dmeta">${commas(w.listings)} items in this collection now</span></li>`).join('')}</ul>`);
  }

  if (bundles.length) {
    const li = (b) => `<li><span class="dname">${esc(b.operatorName)} “${esc(b.name)}”</span><span class="dmeta">${commas(b.listings)} items · ${b.stores} store${b.stores === 1 ? '' : 's'}</span></li>`;
    parts.push(`<h3>Multi-buy bundles</h3><ul class="deallist">${bundles.slice(0, 4).map(li).join('')}</ul>
      ${bundles.length > 4 ? `<details class="more-deals"><summary>Show ${bundles.length - 4} more bundles</summary><ul class="deallist">${bundles.slice(4).map(li).join('')}</ul></details>` : ''}
      <p class="note2">Bundle prices apply at checkout, so they aren't reflected in the prices above.</p>`);
  }

  parts.push(`<p class="note2"><b>Always ask about:</b> new-patient discounts (chains have offered 40–60% off a first visit), plus veteran, senior and SNAP discounts. These usually aren't shown in online prices, and they can beat a sale.</p>`);
  parts.push(`<p class="fine">Sale names and end times come from the dispensaries' menus. Annual sale days are based on past years; exact deals are announced by each chain shortly before.</p>`);
  document.querySelector('#dealsBody').innerHTML = parts.join('');
  sec.hidden = false;
}
