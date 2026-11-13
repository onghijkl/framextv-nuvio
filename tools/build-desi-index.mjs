#!/usr/bin/env node
/**
 * build-desi-index.mjs — regenerates the static show index that ships with the
 * /desi add-on (addon/desi-data/).
 *
 * Source of truth: https://www.desi-serials.to category sitemaps
 *   sitemap_index.xml -> category-sitemap.xml + category-sitemap2.xml
 *
 * Category URLs have the shape
 *   /watch-online/<channel>/<show>/
 *   /watch-online/<channel>/<channel>-completed-shows/<show>/
 * The second form is a *grouping level* (a channel's archive/rerun shelf) — its
 * leaf is still a real show, so we keep it and remember the group.
 *
 * Output:
 *   addon/desi-data/shows.json
 *     { built, shows: { "<channel>~[<group>~]<show>": [channel, group, title, poster, latestIso] } }
 *
 * Usage: node tools/build-desi-index.mjs [outDir] [--no-posters]
 */
import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import path from "node:path";

const SITE = "https://www.desi-serials.to";
const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const OUT = path.resolve(args[0] || "addon/desi-data");
const POSTERS = !process.argv.includes("--no-posters");
const CONC = 8;

/** Channels whose shows are archive-only: excluded from rows, kept in search. */
export const ARCHIVE_CHANNELS = ["life-ok", "zoo-of-all-old-shows"];

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
  august: 8, september: 9, october: 10, november: 11, december: 12,
};

function log(...a) {
  console.log(new Date().toISOString().slice(11, 19), ...a);
}

async function get(url, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, {
        headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,application/xml" },
        redirect: "follow",
      });
      if (r.ok) return await r.text();
      last = new Error(`HTTP ${r.status}`);
      if (r.status === 404) throw last;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 400 * (i + 1)));
  }
  throw last;
}

async function pool(items, worker, conc = CONC) {
  const out = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(conc, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = await worker(items[i], i);
      } catch (e) {
        out[i] = { error: String(e && e.message) };
      }
    }
  });
  await Promise.all(runners);
  return out;
}
function classify(paths) {
  const shows = [];
  const channels = new Set();
  for (const p of paths) {
    const seg = p.replace(/^\/watch-online\//, "").split("/").filter(Boolean);
    if (!seg.length) continue;
    const [ch] = seg;
    channels.add(ch);
    if (seg.length === 1) continue;
    const leaf = seg[seg.length - 1];
    if (/^[a-z0-9-]+-completed-shows$/.test(leaf) || leaf === ch) continue;
    if (seg.length > 3) continue;
    const group = seg.length === 3 ? seg[1] : "";
    shows.push({ channel: ch, group, leaf, path: seg.join("~") });
  }
  const seen = new Set();
  return { channels: [...channels].sort(), shows: shows.filter((s) => !seen.has(s.path) && seen.add(s.path)) };
}

const FETCH_TITLES = !process.argv.includes("--no-titles");
function slugDate(slug) {
  const m = slug.match(/(\d{1,2})(?:st|nd|rd|th)?-([a-z]{3,})[a-z]*-(20\d{2})/);
  if (!m) return "";
  const mo = MONTHS[m[2].slice(0, 3)];
  if (!mo) return "";
  return `${m[3]}-${String(mo).padStart(2, "0")}-${String(+m[1]).padStart(2, "0")}`;
}

function parseShowPage(html) {
  const h1 = html.match(/<h1[^>]*class="[^"]*page-title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i) || html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  let title = h1 ? h1[1].replace(/<[^>]*>/g, "").trim() : "";
  if (!title) {
    const t = html.match(/<title>([^<]*)/i);
    title = t ? t[1].replace(/\s*Watch Latest.*$/i, "").trim() : "";
  }
  let latestId = 0, latestSlug = "";
  for (const m of html.matchAll(/href="https?:\/\/(?:www\.)?desi-serials\.to\/([a-z0-9-]+)\/(\d{4,})\/"/g)) {
    const id = +m[2];
    if (id > latestId) { latestId = id; latestSlug = m[1]; }
  }
  const dates = [...html.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Z][a-z]+)\s+(20\d{2})\b/g)]
    .map((m) => `${m[3]}-${String(MONTHS[m[2].slice(0, 3).toLowerCase()] || 0).padStart(2, "0")}-${String(+m[1]).padStart(2, "0")}`)
    .filter((d) => !d.includes("-00-")).sort();
  const latestIso = slugDate(latestSlug) || dates[dates.length - 1] || "";
  const thumb = (html.match(/"thumbnailUrl":"([^"]+)"/) || [])[1] || "";
  let poster = thumb.replace(/\\\//g, "/").replace(/&amp;/g, "&");
  if (!poster) {
    for (const m of html.matchAll(/<img[^>]+src="([^"]+wp-content\/uploads\/[^"]+)"/g)) {
      if (/fav|logo|cropped|\/2020\/09\/|\.png/i.test(m[1])) continue;
      poster = m[1]; break;
    }
  }
  return { title, latestIso, latestId, poster };
}
async function harvestPosters(pages) {
  const map = new Map();
  await pool(pages, async (page) => {
    let html;
    try { html = await get(`${SITE}${page}/`); } catch (e) { return; }
    const re = /<a[^>]*href=['"]https?:\/\/(?:www\.)?desi-serials\.to\/watch-online\/([^'"]+?)\/?['"][^>]*>[\s\S]{0,900}?<img[^>]*class=['"]img-icon['"][^>]*src=['"]([^'"]+)['"]/g;
    for (const m of html.matchAll(re)) {
      const key = m[1].split("/").filter(Boolean).join("~");
      const src = m[2].startsWith("//") ? `https:${m[2]}` : m[2].startsWith("/") ? `${SITE}${m[2]}` : m[2];
      if (key && src) map.set(key, src);
    }
  });
  return map;
}

function prettify(leaf, channel) {
  let s = leaf;
  const suffix = `-${channel}`;
  if (s.endsWith(suffix)) s = s.slice(0, -suffix.length);
  return s.split("-").filter(Boolean)
    .map((w) => (/^\d+$/.test(w) ? w : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
}
async function main() {
  const idxXml = await get(`${SITE}/sitemap_index.xml`);
  const maps = [...idxXml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1])
    .filter((u) => /category-sitemap\d*\.xml$/.test(u));
  console.log(`category sitemaps: ${maps.length}`);
  const locs = [];
  for (const u of maps) {
    const xml = await get(u);
    for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) locs.push(m[1].replace(/^https?:\/\/[^/]+/, ""));
    console.log(`  ${u.split("/").pop()}: ${(xml.match(/<loc>/g) || []).length} locs`);
  }
  const { channels: allChannels, shows } = classify(locs);
  const limArg = process.argv.find((a) => /^--limit=\d+$/.test(a));
  const LIMIT = limArg ? +limArg.split("=")[1] : 0;
  const work = LIMIT ? shows.slice(0, LIMIT) : shows;
  const byCh = new Map();
  for (const s of shows) byCh.set(s.channel, (byCh.get(s.channel) || 0) + 1);
  console.log(`shows: ${shows.length}`);
  for (const [ch, n] of [...byCh].sort((a, b) => b[1] - a[1])) console.log(`  ${ch}: ${n}`);

  const posters = await harvestPosters(await channelPages());
  console.log(`posters from channel pages: ${posters.size}`);

  let done = 0;
  await pool(work, async (s) => {
    const path = s.group ? `${s.channel}/${s.group}/${s.leaf}` : `${s.channel}/${s.leaf}`;
    const key = path.replace(/\//g, "~");
    s.key = key;
    s.title = prettify(s.leaf, s.channel);
    const p = posters.get(path) || posters.get(path.split('~')[0] + '~' + path.split('~').pop());
    if (p) s.poster = p;
    if (!FETCH_TITLES) return;
    try {
      const html = await get(`${SITE}/watch-online/${path}/`);
      const info = parseShowPage(html);
      if (info.title) s.title = info.title;
      if (info.latestIso) s.latestIso = info.latestIso;
      if (info.latestId) s.latestId = info.latestId;
      if (info.poster) s.poster = info.poster;
    } catch (e) { s.err = String(e && e.message).slice(0, 60); }
    if (++done % 100 === 0) console.log(`  fetched ${done}/${work.length}`);
  });
  console.log(`fetched ${done}/${work.length} pages, title errors: ${shows.filter((s) => s.err).length}`);

  await mkdir(OUT, { recursive: true });
  const out = { built: new Date().toISOString().slice(0, 10), site: SITE, shows: {} };
  for (const s of shows) {
    out.shows[s.key] = [s.channel, s.group, s.title, s.poster, s.latestIso, s.latestId];
  }
  const file = path.join(OUT, "shows.json");
  const body = JSON.stringify(out);
  await writeFile(file, body);
  const bytes = Buffer.byteLength(body);
  console.log(`wrote ${OUT}/shows.json (${shows.length} shows, ${(bytes / 1024).toFixed(0)} KB)`);
  const withPoster = shows.filter((s) => s.poster).length;
  const withDate = shows.filter((s) => s.latestIso).length;
  console.log(`posters: ${withPoster} | with latest date: ${withDate}`);
}

main().catch((e) => { console.error("FAILED", e); process.exit(1); });
/** Channel archive pages (the only place the site publishes show posters). */
async function channelPages() {
  const file = new URL("../addon/desi.js", import.meta.url);
  const src = await readFile(file, "utf8");
  const at = src.indexOf("const CHANNELS");
  const block = src.slice(at, src.indexOf("];", at));
  const pages = [...block.matchAll(/path:\s*['"]([^'"]+)['"]/g)].map((m) => m[1].replace(/\/$/, ""));
  console.log(`channel archive pages: ${pages.length}`);
  return pages;
}
