import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mod = await import(ROOT + '/addon/desi.js');
const { parseEpisodePage, extractEmbed, extractM3u8 } = mod._test;
const INDEX = ROOT + '/addon/desi-data/shows.json';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const REF = 'https://tvarticles.org/';
const SITE = 'https://www.desi-serials.to';
const CONC = parseInt(process.env.CONC || '10', 10);
async function grab(url, referer) {
  const headers = { 'User-Agent': UA, Accept: 'text/html,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' };
  if (referer) headers.Referer = referer;
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, { headers, redirect: 'follow', signal: ctrl.signal });
    const ct = res.headers.get('content-type') || '';
    const body = res.ok && !/^image\//i.test(ct) ? await res.text() : '';
    return { ok: res.ok, ct, body };
  } catch (e) { return { ok: false, ct: '', body: '' }; }
  finally { clearTimeout(to); }
}
async function isLive(postId) {
  const page = await grab(SITE + '/?p=' + postId);
  if (!page.ok) return false;
  const ep = parseEpisodePage(page.body);
  if (!ep.players.length) return false;
  const hits = await Promise.all(ep.players.slice(0, 6).map(async (p) => {
    const fr = await grab(p, REF);
    if (!fr.ok) return false;
    if (extractM3u8(fr.body)) return true;
    const emb = extractEmbed(fr.body);
    if (!emb) return false;
    const e2 = await grab(emb, REF);
    return e2.ok && !!extractM3u8(e2.body);
  }));
  return hits.some(Boolean);
}
const data = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
const rows = Object.entries(data.shows);
let list = rows;
if (process.argv.includes('--unprobed')) list = rows.filter(([k, v]) => v[6] !== 0 && v[6] !== 1);
if (process.argv.includes('--dead')) list = rows.filter(([k, v]) => v[6] === 0);
const ks = process.argv.find((a) => a.startsWith('--keys='));
if (ks) { const set = new Set(ks.slice(7).split(',')); list = list.filter(([k]) => set.has(k)); }
const lim = process.argv.find((a) => a.startsWith('--limit='));
if (lim) list = list.slice(0, parseInt(lim.split('=')[1], 10));
console.log('probing ' + list.length + ' of ' + rows.length + ' concurrency=' + CONC);
let done = 0, live = 0;
const keepAlive = setInterval(() => {}, 5000);
const write = () => { const t = INDEX + '.tmp'; fs.writeFileSync(t, JSON.stringify(data)); fs.renameSync(t, INDEX); };
async function worker(queue) {
  while (queue.length) {
    const [key, v] = queue.shift();
    let ok = false;
    try { ok = v[5] ? await isLive(v[5]) : false; } catch (e) { ok = false; }
    v[6] = ok ? 1 : 0;
    if (ok) live++;
    done++;
    if (done % 25 === 0) { write(); console.log(done + '/' + list.length + ' live=' + live); }
  }
}
const q = list.slice();
await Promise.all(Array.from({ length: CONC }, () => worker(q)));
clearInterval(keepAlive);
write();
console.log('DONE probed=' + done + ' live=' + live + ' dead=' + (done - live));

