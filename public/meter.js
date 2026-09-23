
const $ = s => document.querySelector(s);
const fmt = n => n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 1 : 2) + 'M'
             : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + 'k' : String(Math.round(n || 0));
const money = n => (n >= 100 ? n.toFixed(1) : (n || 0).toFixed(2));
function hms(ms) {
  if (!ms || ms < 0) return '0:00:00';
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// checkbox state persists; ?show=claude+codex overrides on load
const KEY = 'vibedeck-meter-picks';
const qs = new URLSearchParams(location.search).get('show');
let picks = qs ? qs.split(/[+,]/) : JSON.parse(localStorage.getItem(KEY) || '["claude","codex","grok"]');
document.querySelectorAll('#picks input').forEach(cb => {
  cb.checked = picks.includes(cb.dataset.k);
  cb.addEventListener('change', () => {
    picks = [...document.querySelectorAll('#picks input:checked')].map(c => c.dataset.k);
    if (!picks.length) { cb.checked = true; picks = [cb.dataset.k]; }
    localStorage.setItem(KEY, JSON.stringify(picks));
    draw();
  });
});

// odometer: tween displayed numbers toward their target
const tweens = new Map();
function odometer(el, target, format) {
  const from = tweens.get(el.dataset.oid) ?? target;
  tweens.set(el.dataset.oid, target);
  const t0 = performance.now(), dur = 700;
  (function step(t) {
    const p = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - p, 3);
    el.textContent = format(from + (target - from) * e);
    if (p < 1) requestAnimationFrame(step);
  })(t0);
}

let data = null;
function tile(lb, vl) { return `<div class="tile"><div class="lb">${lb}</div><div class="vl">${vl}</div></div>`; }

function draw() {
  if (!data) return;
  const now = Date.now();
  const cards = [];
  const Z = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, cached: 0, estIn: 0, estOut: 0, estTokens: 0,
              calls: 0, sessions: 0, messages: 0, cost: 0, models: [], planPct: null };
  if (picks.includes('claude')) {
    const s = data.claude.session || Z, day = data.claude.daily;
    const el = data.since.claude ? now - data.since.claude : 0;
    const rate = el > 60000 ? s.cost / (el / 36e5) : 0;
    cards.push(`
      <div class="card" style="--accent:var(--claude)">
        <div class="head" style="color:var(--claude)"><span class="dot"></span>CLAUDE METER<span class="live">LIVE</span>
          <span class="badge">${((s.models[0] || day.models[0])?.name || 'claude').toUpperCase()}</span></div>
        <div class="big"><span class="cur">$</span><span class="num" data-oid="cl$"></span></div>
        <div class="sub">this session · <b>$${rate.toFixed(2)}/hr</b> · ${hms(el)} · <b>${s.calls}</b> calls</div>
        <div class="tiles">
          ${tile('output tokens', `<span data-oid="clo"></span>`)}
          ${tile('input tokens', `<span data-oid="cli"></span>`)}
          ${tile('cache read', fmt(s.cacheRead))}
          ${tile('cache write', fmt(s.cacheWrite))}
        </div>
        <div class="foot">${s.models.map(m =>
          `<span class="m">${m.name}</span> <span class="money">$${money(m.cost)}</span> <small>(${m.calls})</small>`).join(' · ') || (data.since.claude ? 'nothing this session yet' : 'no claude pane running')}</div>
        <div class="daily">today total <span class="money">$${money(day.cost)}</span> · ${day.calls} calls <small>(fleet incl.)</small></div>
        <div class="note">api-rate value — Max plan is flat, not billed per token · session resets on pane restart</div>
      </div>`);
  }
  if (picks.includes('codex')) {
    const s = data.codex.session || Z, day = data.codex.daily;
    const el = data.since.codex ? now - data.since.codex : 0;
    const rate = el > 60000 ? s.cost / (el / 36e5) : 0;
    cards.push(`
      <div class="card" style="--accent:var(--codex)">
        <div class="head" style="color:var(--codex)"><span class="dot"></span>CODEX METER<span class="live">LIVE</span>
          <span class="badge">GPT-5.X</span></div>
        <div class="big"><span class="cur">$</span><span class="num" data-oid="cx$"></span></div>
        <div class="sub">this session · <b>$${rate.toFixed(2)}/hr</b> est · ${hms(el)}</div>
        <div class="tiles">
          ${tile('output tokens', `<span data-oid="cxo"></span>`)}
          ${tile('input tokens', `<span data-oid="cxi"></span>`)}
          ${tile('cached input', fmt(s.cached))}
          ${tile('plan used', day.planPct != null ? `${day.planPct}% <small>of ${day.planWindowDays}d</small>` : '—')}
        </div>
        ${day.planPct != null ? `<div class="planbar"><i style="width:${Math.min(100, day.planPct)}%"></i></div>` : ''}
        <div class="daily">today total <span class="money">$${money(day.cost)}</span> · ${day.sessions} sessions</div>
        <div class="note">est api-rate — codex prices are estimates · session resets on pane restart</div>
      </div>`);
  }
  if (picks.includes('grok')) {
    const s = data.grok.session || Z, day = data.grok.daily;
    const el = data.since.grok ? now - data.since.grok : 0;
    cards.push(`
      <div class="card" style="--accent:var(--grok)">
        <div class="head" style="color:var(--grok)"><span class="dot"></span>GROK METER<span class="live">LIVE</span>
          <span class="badge">GROK 4.5</span></div>
        <div class="big"><span class="cur">$</span><span class="num" data-oid="gk$"></span></div>
        <div class="sub">this session · <b>$${(el > 60000 ? s.cost / (el / 36e5) : 0).toFixed(2)}/hr</b> est · ${hms(el)}</div>
        <div class="tiles">
          ${tile('output tokens', '~' + fmt(s.estOut))}
          ${tile('input tokens', '~' + fmt(s.estIn))}
          ${tile('messages', s.messages)}
          ${tile('billing', '<small>flat sub</small>')}
        </div>
        <div class="daily">today total <span class="money">$${money(day.cost)}</span> · ${day.messages} msgs</div>
        <div class="note">est api-rate — grok logs no token counts, char-based estimate · session resets on pane restart</div>
      </div>`);
  }
  $('#cards').innerHTML = cards.join('');
  // animate the headline numbers
  const cl = data.claude.session || Z, cx = data.codex.session || Z, gk = data.grok.session || Z;
  document.querySelectorAll('[data-oid]').forEach(el => {
    const id = el.dataset.oid;
    if (id === 'cl$') odometer(el, cl.cost, money);
    else if (id === 'cx$') odometer(el, cx.cost, money);
    else if (id === 'gk$') odometer(el, gk.cost, money);
    else if (id === 'clo') odometer(el, cl.out, fmt);
    else if (id === 'cli') odometer(el, cl.in, fmt);
    else if (id === 'cxo') odometer(el, cx.out, fmt);
    else if (id === 'cxi') odometer(el, cx.in, fmt);
  });
}

async function tick() {
  try {
    data = await (await fetch('/api/meter')).json();
    draw();
  } catch {}
}
tick();
setInterval(tick, 10000);
