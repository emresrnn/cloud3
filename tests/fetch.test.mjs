// Offline tests for scripts/fetch-feeds.mjs: serves fixture feeds from a local
// HTTP server and runs the aggregator against them with SOURCES_FILE/DATA_DIR.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/fetch-feeds.mjs');
const now = new Date();
const old = new Date(Date.now() - 45 * 864e5);

const FEEDS = {
  '/rss.xml': `<?xml version="1.0"?><rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>T</title>
    <item><title>Critical CVE-2026-1234 zero-day exploited</title><link>https://example.com/a?utm_source=rss</link>
      <pubDate>${now.toUTCString()}</pubDate><description>&lt;p&gt;Attackers &amp;amp; ransomware&lt;/p&gt;</description>
      <media:content url="https://example.com/i.jpg" medium="image"/></item>
    <item><title>Duplicate of A</title><link>https://www.example.com/a</link><pubDate>${now.toUTCString()}</pubDate></item>
    <item><title>Too old story</title><link>https://example.com/old</link><pubDate>${old.toUTCString()}</pubDate></item>
    <item><title>No link</title></item>
  </channel></rss>`,
  '/tr.xml': `<?xml version="1.0"?><rss version="2.0"><channel><title>TR</title>
    <item><title>Yeni yapay zeka modeli yayınlandı</title><link>https://example.com/tr-ai</link><pubDate>${now.toUTCString()}</pubDate><description>Model</description></item>
    <item><title>Bankada büyük veri sızıntısı</title><link>https://example.com/tr-sec</link><pubDate>${now.toUTCString()}</pubDate></item>
    <item><title>SİBER SALDIRI uyarısı</title><link>https://example.com/tr-upper</link><pubDate>${now.toUTCString()}</pubDate></item>
    <item><title>Tarayıcı güvenlik açığını kapatan yamayı yayınladı</title><link>https://example.com/tr-vuln</link><pubDate>${now.toUTCString()}</pubDate></item>
    <item><title>Şirket 3.5 milyon kullanıcıya ulaştı</title><link>https://example.com/tr-num</link><pubDate>${now.toUTCString()}</pubDate></item>
    <item><title>Yeni AI asistanı tanıttı</title><link>https://example.com/tr-upper-ai</link><pubDate>${now.toUTCString()}</pubDate></item>
    <item><title>Raid kurulumu ve said değerleri</title><link>https://example.com/tr-noai</link><pubDate>${now.toUTCString()}</pubDate></item>
    <item><title>Yeni telefon incelemesi</title><link>https://example.com/tr-phone</link><pubDate>${now.toUTCString()}</pubDate></item>
  </channel></rss>`,
  '/atom.xml': `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>R</title>
    <entry><title>v9.9.9</title><link href="https://example.com/rel/1"/><updated>${now.toISOString()}</updated><content type="html">&lt;ul&gt;&lt;li&gt;Fixes&lt;/li&gt;&lt;/ul&gt;</content></entry>
    <entry><title>v10.0.0-nightly</title><link href="https://example.com/rel/2"/><updated>${now.toISOString()}</updated></entry>
  </feed>`,
  '/broken.xml': '<html>not a feed',
};

let server, base, dir;
before(async () => {
  server = http.createServer((req, res) => {
    const body = FEEDS[req.url];
    res.writeHead(body ? 200 : 404, { 'Content-Type': 'application/xml' });
    res.end(body || 'nope');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  dir = await mkdtemp(path.join(os.tmpdir(), 'techpulse-'));
});
after(async () => {
  server.close();
  await rm(dir, { recursive: true, force: true });
});

async function aggregate(sources) {
  const file = path.join(dir, 'sources.json');
  await writeFile(file, JSON.stringify(sources));
  const env = { ...process.env, SOURCES_FILE: file, DATA_DIR: dir };
  delete env.HTTPS_PROXY; delete env.https_proxy; delete env.HTTP_PROXY; delete env.http_proxy;
  await run(process.execPath, [SCRIPT], { env });
  return {
    news: JSON.parse(await readFile(path.join(dir, 'news.json'), 'utf8')),
    meta: JSON.parse(await readFile(path.join(dir, 'meta.json'), 'utf8')),
  };
}

const SOURCES = () => [
  { id: 'sec', name: 'SecFeed', url: `${base}/rss.xml`, category: 'security', lang: 'en', site: 'example.com' },
  { id: 'tr', name: 'TrFeed', url: `${base}/tr.xml`, category: 'software', lang: 'tr', site: 'example.com' },
  { id: 'rel', name: 'Node.js', url: `${base}/atom.xml`, category: 'releases', lang: 'en', site: 'github.com' },
  { id: 'broken', name: 'Broken', url: `${base}/broken.xml`, category: 'ai', lang: 'en', site: 'x' },
  { id: 'missing', name: 'Missing', url: `${base}/missing.xml`, category: 'ai', lang: 'en', site: 'x' },
];

test('parses, cleans, dedupes and filters items', async () => {
  const { news, meta } = await aggregate(SOURCES());
  const titles = news.items.map((i) => i.title);
  const a = news.items.find((i) => i.sourceId === 'sec');
  assert.equal(news.items.filter((i) => i.sourceId === 'sec').length, 1, 'URL duplicate removed');
  assert.ok(!titles.includes('Too old story'), 'items older than 30 days dropped');
  assert.ok(!titles.includes('No link'), 'items without links dropped');
  assert.equal(a.summary, 'Attackers & ransomware', 'HTML stripped and entities decoded');
  assert.equal(a.image, 'https://example.com/i.jpg');
  assert.deepEqual(a.tags.sort(), ['breach', 'vuln']);
  const dates = news.items.map((i) => Date.parse(i.date));
  assert.deepEqual(dates, [...dates].sort((x, y) => y - x), 'sorted newest first');
  assert.equal(meta.sourcesOk, 3);
  assert.equal(meta.sourcesTotal, 5);
});

test('re-categorizes Turkish items by keywords', async () => {
  const { news } = await aggregate(SOURCES());
  const cat = (id) => news.items.find((i) => i.url.endsWith(id)).category;
  assert.equal(cat('tr-ai'), 'ai');
  assert.equal(cat('tr-sec'), 'security');
  assert.equal(cat('tr-phone'), 'software');
  assert.equal(cat('tr-upper'), 'security', 'uppercase İ handled');
  assert.equal(cat('tr-vuln'), 'security', 'suffixed Turkish words match');
  assert.equal(cat('tr-upper-ai'), 'ai', 'uppercase AI still matches');
  assert.equal(cat('tr-noai'), 'software', '"ai" inside other words does not match');
});

test('tags Turkish and English keywords without false positives', async () => {
  const { news } = await aggregate(SOURCES());
  const tags = (id) => news.items.find((i) => i.url.endsWith(id)).tags;
  assert.ok(tags('tr-vuln').includes('vuln'));
  assert.ok(tags('tr-sec').includes('breach'));
  assert.ok(tags('tr-ai').includes('release'), '"yayınlandı" marks a release');
  assert.ok(!tags('tr-num').includes('release'), 'plain numbers are not versions');
});

test('release titles get the project name and nightlies are skipped', async () => {
  const { news } = await aggregate(SOURCES());
  const rel = news.items.filter((i) => i.category === 'releases');
  assert.deepEqual(rel.map((i) => i.title), ['Node.js v9.9.9']);
  assert.ok(rel[0].tags.includes('release'));
});

test('failing sources are reported and do not fail the run', async () => {
  const { meta } = await aggregate(SOURCES());
  const bad = meta.sources.filter((s) => !s.ok).map((s) => s.id).sort();
  assert.deepEqual(bad, ['broken', 'missing']);
  assert.match(meta.sources.find((s) => s.id === 'missing').error, /404/);
});

test('keeps previous items when a source goes down, preserving firstSeen', async () => {
  const first = await aggregate(SOURCES());
  const seen = first.news.items.find((i) => i.sourceId === 'rel').firstSeen;
  const down = SOURCES().map((s) => (s.id === 'rel' ? { ...s, url: `${base}/missing.xml` } : s));
  const second = await aggregate(down);
  const kept = second.news.items.find((i) => i.sourceId === 'rel');
  assert.ok(kept, 'item from the failing source is kept');
  assert.equal(kept.firstSeen, seen);
});

test('drops items from sources removed from the config', async () => {
  await aggregate(SOURCES());
  const { news } = await aggregate(SOURCES().filter((s) => s.id !== 'tr'));
  assert.ok(!news.items.some((i) => i.sourceId === 'tr'));
});
