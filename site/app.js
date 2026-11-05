import { t } from './i18n.js';

const PAGE = 36;
const REFRESH_MS = 10 * 60 * 1000;
const NEW_WINDOW_MS = 3 * 60 * 60 * 1000; // "NEW" badge for items first seen in the last 3h
const CATS = ['ai', 'software', 'security', 'releases'];
const TABS = ['all', ...CATS, 'turkish', 'saved'];

const $ = (s) => document.querySelector(s);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const state = {
  lang: store.get('tp-lang', (navigator.language || 'en').toLowerCase().startsWith('tr') ? 'tr' : 'en'),
  tab: TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'all',
  q: '',
  source: '',
  days: 0,
  shown: PAGE,
  data: null,
  meta: null,
  pending: null,
  saved: new Map(store.get('tp-saved', []).map((i) => [i.id, i])),
};

// ---------- utils ----------
const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fold = (s = '') => s.toLocaleLowerCase('tr').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ı/g, 'i');
function highlight(text, q) {
  const safe = esc(text);
  if (!q) return safe;
  const words = q.split(/\s+/).filter((w) => w.length > 1).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!words.length) return safe;
  return safe.replace(new RegExp(`(${words.join('|')})`, 'gi'), '<mark>$1</mark>');
}
function relTime(iso) {
  const diff = (Date.parse(iso) - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(state.lang, { numeric: 'auto', style: 'short' });
  const units = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
  for (const [u, s] of units) if (Math.abs(diff) >= s) return rtf.format(Math.round(diff / s), u);
  return rtf.format(0, 'minute');
}
const absTime = (iso) => new Date(iso).toLocaleString(state.lang === 'tr' ? 'tr-TR' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' });
const favicon = (site) => `https://icons.duckduckgo.com/ip3/${encodeURIComponent(site)}.ico`;

// ---------- i18n ----------
function applyI18n() {
  document.documentElement.lang = state.lang;
  document.querySelectorAll('[data-i18n]').forEach((el) => (el.textContent = t(state.lang, el.dataset.i18n)));
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => (el.placeholder = t(state.lang, el.dataset.i18nPlaceholder)));
  document.querySelectorAll('[data-i18n-aria]').forEach((el) => el.setAttribute('aria-label', t(state.lang, el.dataset.i18nAria)));
  document.querySelectorAll('[data-i18n-title]').forEach((el) => (el.title = t(state.lang, el.dataset.i18nTitle)));
  document.querySelectorAll('.lang-toggle button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.lang === state.lang)));
}

// ---------- filtering ----------
function baseItems() {
  return state.tab === 'saved' ? [...state.saved.values()].sort((a, b) => Date.parse(b.date) - Date.parse(a.date)) : state.data?.items || [];
}
function filtered() {
  let items = baseItems();
  if (CATS.includes(state.tab)) items = items.filter((i) => i.category === state.tab);
  if (state.tab === 'turkish') items = items.filter((i) => i.lang === 'tr');
  if (state.source) items = items.filter((i) => i.sourceId === state.source);
  if (state.days) {
    const cut = Date.now() - state.days * 864e5;
    items = items.filter((i) => Date.parse(i.date) >= cut);
  }
  if (state.q) {
    const words = fold(state.q).split(/\s+/).filter(Boolean);
    items = items.filter((i) => {
      const hay = fold(`${i.title} ${i.summary} ${i.source}`);
      return words.every((w) => hay.includes(w));
    });
  }
  return items;
}
function highlights(items) {
  const cut = Date.now() - 2 * 864e5;
  const out = [];
  const usedSources = new Set();
  const usedCats = new Map();
  for (const i of items) {
    if (Date.parse(i.date) < cut || !i.image || usedSources.has(i.sourceId)) continue;
    if ((usedCats.get(i.category) || 0) >= 2) continue;
    out.push(i);
    usedSources.add(i.sourceId);
    usedCats.set(i.category, (usedCats.get(i.category) || 0) + 1);
    if (out.length === 6) break;
  }
  return out.length >= 3 ? out : [];
}

// ---------- rendering ----------
const STAR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/></svg>';
function card(i, { withImage = true } = {}) {
  const saved = state.saved.has(i.id);
  const isNew = i.firstSeen && Date.now() - Date.parse(i.firstSeen) < NEW_WINDOW_MS;
  const tags = (i.tags || []).filter((tg) => !(tg === 'release' && i.category === 'releases'));
  return `
  <article class="card cat-${esc(i.category)}">
    ${withImage && i.image ? `<img class="thumb" src="${esc(i.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}
    <div class="card-body">
      <div class="meta">
        <img src="${favicon(i.site)}" alt="" loading="lazy" width="16" height="16" onerror="this.style.visibility='hidden'">
        <span class="src">${esc(i.source)}</span>
        <time datetime="${esc(i.date)}" title="${esc(absTime(i.date))}">${esc(relTime(i.date))}</time>
      </div>
      <h3><a href="${esc(i.url)}" target="_blank" rel="noopener noreferrer" title="${esc(t(state.lang, 'readMore'))}">${highlight(i.title, state.q)}</a></h3>
      ${i.summary ? `<p>${highlight(i.summary, state.q)}</p>` : ''}
      <div class="badges">
        ${isNew ? `<span class="badge new">${t(state.lang, 'isNew')}</span>` : ''}
        <span class="badge">${esc(t(state.lang, i.category))}</span>
        ${tags.map((tg) => `<span class="badge tag ${esc(tg)}">${esc(t(state.lang, 'tag_' + tg))}</span>`).join('')}
        ${i.lang === 'tr' ? '<span class="badge lang">TR</span>' : ''}
        <button type="button" class="save-btn" data-save="${esc(i.id)}" aria-pressed="${saved}" aria-label="${esc(t(state.lang, saved ? 'unsave' : 'save'))}" title="${esc(t(state.lang, saved ? 'unsave' : 'save'))}">${STAR}</button>
      </div>
    </div>
  </article>`;
}

function renderTabs() {
  const items = state.data?.items || [];
  const count = {
    all: items.length,
    turkish: items.filter((i) => i.lang === 'tr').length,
    saved: state.saved.size,
  };
  for (const c of CATS) count[c] = items.filter((i) => i.category === c).length;
  $('#tabs').innerHTML = TABS.map(
    (k) => `<button type="button" role="tab" class="tab cat-${k}" data-tab="${k}" aria-selected="${state.tab === k}">
      <span class="dot"></span>${esc(t(state.lang, k))}<span class="count">${count[k]}</span></button>`
  ).join('');
  $('#tabs').setAttribute('role', 'tablist');
}

function renderStats() {
  const items = state.data?.items || [];
  if (!items.length) { $('#statsRow').innerHTML = ''; return; }
  const day = Date.now() - 864e5;
  $('#statsRow').innerHTML = CATS.map((c) => {
    const n = items.filter((i) => i.category === c && Date.parse(i.date) >= day).length;
    return `<button type="button" class="stat cat-${c}" data-tab="${c}"><b>${n}</b><span>${esc(t(state.lang, c))} · ${esc(t(state.lang, 'last24h'))}</span></button>`;
  }).join('');
}

function renderSourceFilter() {
  const sources = new Map();
  for (const i of state.data?.items || []) if (!sources.has(i.sourceId)) sources.set(i.sourceId, i.source);
  const opts = [...sources].sort((a, b) => a[1].localeCompare(b[1]));
  if (state.source && !sources.has(state.source)) state.source = '';
  $('#sourceFilter').innerHTML = `<option value="">${esc(t(state.lang, 'allSources'))}</option>` +
    opts.map(([id, name]) => `<option value="${esc(id)}"${id === state.source ? ' selected' : ''}>${esc(name)}</option>`).join('');
  $('#timeFilter').value = String(state.days);
}

function renderUpdated() {
  const u = state.data?.updatedAt;
  const m = state.meta;
  let txt = u ? `${t(state.lang, 'updated')} ${relTime(u)}` : t(state.lang, 'notUpdated');
  if (m?.sourcesTotal) txt += ` · ${t(state.lang, 'sourcesActive', { ok: m.sourcesOk, total: m.sourcesTotal })}`;
  $('#updated').textContent = txt;
  if (u) $('#updated').title = absTime(u);
}

function renderSources() {
  const list = state.meta?.sources || [];
  $('#sourcesDetails').hidden = !list.length;
  $('#sourcesList').innerHTML = list
    .map((s) => `<li title="${esc(s.ok ? `${s.count} · ${s.ms} ms` : s.error)}"><span class="${s.ok ? 'ok' : 'err'}"></span>${esc(s.name)} <span class="muted">${esc(t(state.lang, s.category))}</span></li>`)
    .join('');
}

function renderList() {
  const items = filtered();
  const plain = state.tab === 'all' && !state.q && !state.source && !state.days;
  const hl = plain ? highlights(items) : [];
  const hlIds = new Set(hl.map((i) => i.id));
  $('#trendingSec').hidden = !hl.length;
  $('#trending').innerHTML = hl.map((i) => card(i)).join('');

  const rest = items.filter((i) => !hlIds.has(i.id));
  const page = rest.slice(0, state.shown);
  $('#grid').innerHTML = page.map((i) => card(i)).join('');
  $('#showing').textContent = rest.length ? t(state.lang, 'showing', { n: page.length, total: rest.length }) : '';
  $('#moreBtn').hidden = page.length >= rest.length;
  $('#listTitle').textContent = state.tab === 'all' ? t(state.lang, 'latest') : t(state.lang, state.tab);

  const empty = $('#emptyState');
  if (!items.length) {
    empty.hidden = false;
    const noData = state.tab !== 'saved' && !(state.data?.items || []).length;
    empty.textContent = t(state.lang, state.tab === 'saved' ? 'emptySaved' : noData ? 'noData' : 'empty');
  } else empty.hidden = true;
}

function render() {
  applyI18n();
  renderTabs();
  renderStats();
  renderSourceFilter();
  renderUpdated();
  renderSources();
  renderList();
}

function showSkeleton() {
  $('#grid').innerHTML = Array.from({ length: 9 }, () => '<div class="skeleton"></div>').join('');
}

function showError() {
  $('#grid').innerHTML = '';
  const empty = $('#emptyState');
  empty.hidden = false;
  empty.innerHTML = `${esc(t(state.lang, 'loadError'))}<br><button type="button" class="btn" id="retryBtn">${esc(t(state.lang, 'retry'))}</button>`;
  $('#retryBtn').onclick = () => load();
}

// ---------- data ----------
async function getJson(url) {
  const res = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(res.status);
  return res.json();
}
async function load() {
  showSkeleton();
  try {
    const [data, meta] = await Promise.all([getJson('data/news.json'), getJson('data/meta.json').catch(() => null)]);
    state.data = data;
    state.meta = meta;
    render();
  } catch (e) {
    console.error(e);
    applyI18n();
    showError();
  }
}
async function poll() {
  if (document.hidden || !state.data) return;
  try {
    const [data, meta] = await Promise.all([getJson('data/news.json'), getJson('data/meta.json').catch(() => state.meta)]);
    if (data.updatedAt === state.data.updatedAt) { renderUpdated(); return; }
    const known = new Set(state.data.items.map((i) => i.id));
    const fresh = data.items.filter((i) => !known.has(i.id)).length;
    state.pending = { data, meta };
    if (fresh > 0) {
      const pill = $('#newPill');
      pill.textContent = t(state.lang, 'newItems', { n: fresh });
      pill.hidden = false;
    } else applyPending();
  } catch {}
}
function applyPending() {
  if (!state.pending) return;
  state.data = state.pending.data;
  state.meta = state.pending.meta;
  state.pending = null;
  $('#newPill').hidden = true;
  render();
}

// ---------- events ----------
function setTab(tab) {
  state.tab = tab;
  state.shown = PAGE;
  history.replaceState(null, '', tab === 'all' ? location.pathname : `#${tab}`);
  renderTabs();
  renderList();
}
document.addEventListener('click', (e) => {
  const tabBtn = e.target.closest('[data-tab]');
  if (tabBtn) return setTab(tabBtn.dataset.tab);
  const saveBtn = e.target.closest('[data-save]');
  if (saveBtn) {
    e.preventDefault();
    const id = saveBtn.dataset.save;
    if (state.saved.has(id)) state.saved.delete(id);
    else {
      const item = (state.data?.items || []).find((i) => i.id === id);
      if (item) state.saved.set(id, item);
    }
    store.set('tp-saved', [...state.saved.values()]);
    renderTabs();
    renderList();
    return;
  }
  const langBtn = e.target.closest('[data-lang]');
  if (langBtn) {
    state.lang = langBtn.dataset.lang;
    store.set('tp-lang', state.lang);
    render();
  }
});
let searchTimer;
$('#search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.q = e.target.value.trim(); state.shown = PAGE; renderList(); }, 150);
});
$('#sourceFilter').addEventListener('change', (e) => { state.source = e.target.value; state.shown = PAGE; renderList(); });
$('#timeFilter').addEventListener('change', (e) => { state.days = Number(e.target.value); state.shown = PAGE; renderList(); });
$('#moreBtn').addEventListener('click', () => { state.shown += PAGE; renderList(); });
$('#newPill').addEventListener('click', () => { applyPending(); window.scrollTo({ top: 0, behavior: 'smooth' }); });
$('#themeBtn').addEventListener('click', () => {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.theme = dark ? 'light' : 'dark';
  try { localStorage.setItem('tp-theme', root.dataset.theme); } catch {}
});
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement?.tagName !== 'INPUT') { e.preventDefault(); $('#search').focus(); }
  if (e.key === 'Escape' && document.activeElement === $('#search')) { $('#search').value = ''; state.q = ''; renderList(); }
});
window.addEventListener('hashchange', () => { const h = location.hash.slice(1); if (TABS.includes(h)) setTab(h); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
setInterval(poll, REFRESH_MS);
setInterval(() => { if (state.data) renderUpdated(); }, 60 * 1000);

applyI18n();
load();
