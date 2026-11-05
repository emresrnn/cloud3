#!/usr/bin/env node
// TechPulse feed aggregator: fetches every source in sources.json, normalizes,
// dedupes and merges with the previous snapshot, then writes site/data/*.json.
import Parser from 'rss-parser';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'site', 'data');
const NEWS_FILE = path.join(DATA_DIR, 'news.json');
const META_FILE = path.join(DATA_DIR, 'meta.json');

const MAX_AGE_DAYS = 30;
const MAX_ITEMS = 800;
const DEFAULT_PER_SOURCE = 30;
const TIMEOUT_MS = 20000;
const SUMMARY_LEN = 280;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; TechPulseBot/1.0; +https://github.com/emresrnn/cloud3)',
  Accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5',
};
const parser = new Parser({
  customFields: {
    item: [
      ['media:content', 'mediaContent', { keepArray: true }],
      ['media:thumbnail', 'mediaThumbnail'],
      ['content:encoded', 'contentEncoded'],
    ],
  },
});

// ---------- helpers ----------
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChar(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}
function safeChar(code) {
  try { return String.fromCodePoint(code); } catch { return ''; }
}
function stripHtml(html = '') {
  return decodeEntities(
    String(html)
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  ).replace(/\s+/g, ' ').trim();
}
function truncate(s, n) {
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  return cut.slice(0, Math.max(cut.lastIndexOf(' '), n - 30)).trim() + '…';
}
function normalizeUrl(u = '') {
  try {
    const url = new URL(u.trim());
    url.hash = '';
    for (const k of [...url.searchParams.keys()]) {
      if (/^(utm_|ref$|source$|fbclid|gclid|mc_)/i.test(k)) url.searchParams.delete(k);
    }
    url.hostname = url.hostname.replace(/^www\./, '');
    return url.toString().replace(/\/$/, '');
  } catch {
    return u.trim();
  }
}
const normTitle = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const hash = (s) => createHash('sha1').update(s).digest('hex').slice(0, 12);

function pickImage(item) {
  const cands = [];
  if (item.enclosure?.url && /image|\.(jpe?g|png|webp|gif)/i.test(item.enclosure.type || item.enclosure.url)) cands.push(item.enclosure.url);
  for (const m of item.mediaContent || []) if (m?.$?.url && (!m.$.medium || m.$.medium === 'image')) cands.push(m.$.url);
  if (item.mediaThumbnail?.$?.url) cands.push(item.mediaThumbnail.$.url);
  const html = item.contentEncoded || item.content || '';
  const m = /<img[^>]+src=["']([^"']+)["']/i.exec(html);
  if (m) cands.push(m[1]);
  const img = cands.find((c) => /^https:\/\//.test(c) && !/(feedburner|pixel|tracking|gravatar|emoji)/i.test(c));
  return img ? decodeEntities(img) : null;
}

// ---------- classification ----------
const RULES = {
  ai: /\b(ai|a\.i\.|artificial intelligence|yapay zek[aâ]|machine learning|makine öğrenme|deep learning|llm|llms|gpt|chatgpt|openai|anthropic|claude|gemini|llama|mistral|copilot|neural|transformer|diffusion|agentic|ai agent|deepmind|hugging ?face)\b/i,
  security: /\b(security|güvenlik|siber|cyber|vulnerab\w*|güvenlik açığı|cve-\d{4}-\d+|zero[- ]day|exploit\w*|malware|ransomware|fidye|phishing|oltalama|breach|hack(ed|er|ers|ing)?|botnet|backdoor|trojan|spyware|ddos|apt\d*)\b/i,
};
const TAGS = [
  ['release', /\b(release[sd]?|released|launch(es|ed)?|now available|general availability|ga\b|v?\d+\.\d+(\.\d+)?\b|sürüm|yayınlandı|piyasaya|duyurdu|tanıttı|introducing|announc\w+)/i],
  ['vuln', /\b(cve-\d{4}-\d+|zero[- ]day|vulnerab\w*|güvenlik açığı|exploit\w*|patch(es|ed)?|yama)\b/i],
  ['breach', /\b(breach\w*|leak\w*|sızıntı|sızdırıldı|ransomware|fidye)\b/i],
  ['opensource', /\b(open[- ]source|açık kaynak)\b/i],
];

function classify(source, title, summary) {
  if (!source.autoCategory && source.lang !== 'tr') return source.category;
  const text = `${title} ${summary}`;
  if (RULES.security.test(text)) return 'security';
  if (RULES.ai.test(text)) return 'ai';
  return source.category;
}
function tagsFor(source, title, summary) {
  const tags = new Set();
  if (source.category === 'releases') tags.add('release');
  for (const [tag, re] of TAGS) if (re.test(tag === 'release' ? title : `${title} ${summary}`)) tags.add(tag);
  return [...tags];
}

// ---------- fetching ----------
async function fetchSource(source) {
  const started = Date.now();
  const res = await fetch(source.url, { headers: HEADERS, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = (await res.text()).replace(/^\uFEFF/, '').trimStart();
  const feed = await parser.parseString(xml);
  const limit = source.limit ?? DEFAULT_PER_SOURCE;
  const items = [];
  for (const it of (feed.items || []).slice(0, limit)) {
    let title = stripHtml(it.title || '').trim();
    // GitHub release titles are often just "v1.2.3": prefix the project name.
    if (source.category === 'releases' && title && !title.toLowerCase().includes(source.name.toLowerCase().split(' ')[0])) {
      title = `${source.name} ${title}`;
    }
    const link = (it.link || it.guid || '').trim();
    if (!title || !/^https?:\/\//.test(link)) continue;
    if (source.category === 'releases' && /nightly|canary|insiders/i.test(title)) continue;
    const rawDate = it.isoDate || it.pubDate || it.updated;
    const date = rawDate && !isNaN(Date.parse(rawDate)) ? new Date(rawDate) : new Date();
    if (date.getTime() > Date.now() + 36e5) date.setTime(Date.now()); // clamp future dates
    let summary = stripHtml(it.contentSnippet || it.summary || it.content || it.contentEncoded || '');
    if (summary.toLowerCase().startsWith(title.toLowerCase())) summary = summary.slice(title.length).trim();
    if (/^(article url|comments url)/i.test(summary)) summary = ''; // hnrss boilerplate
    summary = truncate(summary, SUMMARY_LEN);
    const url = normalizeUrl(link);
    items.push({
      id: hash(url),
      title,
      url: link,
      summary,
      image: pickImage(it),
      date: date.toISOString(),
      source: source.name,
      sourceId: source.id,
      site: source.site,
      lang: source.lang,
      category: classify(source, title, summary),
      tags: tagsFor(source, title, summary),
    });
  }
  return { items, ms: Date.now() - started };
}

async function withRetry(fn, tries = 2) {
  let err;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { err = e; await new Promise((r) => setTimeout(r, 1500)); }
  }
  throw err;
}

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; }
}

// ---------- main ----------
async function main() {
  const sourcesFile = process.env.SOURCES_FILE || path.join(ROOT, 'scripts', 'sources.json');
  const sources = JSON.parse(await readFile(sourcesFile, 'utf8'));
  const previous = await readJson(NEWS_FILE, { items: [] });
  const sourceIds = new Set(sources.map((s) => s.id));

  const results = await Promise.allSettled(sources.map((s) => withRetry(() => fetchSource(s))));
  const status = [];
  const fresh = [];
  results.forEach((r, i) => {
    const s = sources[i];
    if (r.status === 'fulfilled') {
      fresh.push(...r.value.items);
      status.push({ id: s.id, name: s.name, category: s.category, lang: s.lang, ok: true, count: r.value.items.length, ms: r.value.ms });
    } else {
      status.push({ id: s.id, name: s.name, category: s.category, lang: s.lang, ok: false, error: String(r.reason?.message || r.reason).slice(0, 160) });
    }
  });

  // Merge: fresh items win; keep previous items from sources still configured.
  const cutoff = Date.now() - MAX_AGE_DAYS * 864e5;
  const byUrl = new Map();
  const seenTitles = new Set();
  const prevById = new Map((previous.items || []).map((p) => [p.id, p]));
  const all = [...fresh, ...(previous.items || []).filter((p) => sourceIds.has(p.sourceId))];
  for (const item of all) {
    if (Date.parse(item.date) < cutoff) continue;
    const key = normalizeUrl(item.url);
    const tkey = normTitle(item.title);
    if (byUrl.has(key) || seenTitles.has(tkey)) continue;
    // Keep first-seen timestamp so "new" detection is stable across runs.
    const prev = prevById.get(item.id);
    item.firstSeen = prev?.firstSeen || new Date().toISOString();
    byUrl.set(key, item);
    seenTitles.add(tkey);
  }
  const items = [...byUrl.values()]
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
    .slice(0, MAX_ITEMS);

  const counts = items.reduce((acc, it) => ((acc[it.category] = (acc[it.category] || 0) + 1), acc), {});
  const now = new Date().toISOString();
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(NEWS_FILE, JSON.stringify({ updatedAt: now, count: items.length, items }));
  await writeFile(
    META_FILE,
    JSON.stringify({ updatedAt: now, total: items.length, counts, sourcesOk: status.filter((s) => s.ok).length, sourcesTotal: status.length, sources: status }, null, 2)
  );

  const failed = status.filter((s) => !s.ok);
  console.log(`✔ ${items.length} items (${fresh.length} fetched) from ${status.length - failed.length}/${status.length} sources`);
  console.log('  by category:', counts);
  for (const f of failed) console.warn(`✖ ${f.id}: ${f.error}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
