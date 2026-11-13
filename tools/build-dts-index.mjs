#!/usr/bin/env node
/**
 * build-dts-index.mjs — regenerates the static Desi Tashan index that ships
 * with the /dss + /dts add-ons (addon/dss-data/).
 *
 * Source of truth: https://www.desitashan.su sitemaps.
 *   sitemap.xml          -> post-sitemap*.xml (every episode URL)
 *   category-sitemap.xml -> every /category/<slug>/ (channels + shows)
 *
 * Every episode URL has the shape
 *   /<show-slug>-<extra words>-<day><ord>-<month>-<year>-full-episode-<channel>/<pid>/
 * which gives us, without a single HTML fetch:
 *   show slug, episode date, episode slug (for the episode page + id) and the
 *   *real* channel the show airs on (the site nav/wrapper channel is wrong).
 *
 * Output:
 *   addon/dss-data/shows.json      { built, shows: { slug: [ch, n, newest, name, poster, [channels]] } }
 *   addon/dss-data/ep/<slug>.json  [ [seg, pid, "YYYY-MM-DD", "xx/<md5>.jpg"], ... ] newest first
 *
 * Usage: node tools/build-dts-index.mjs [outDir]
 */
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";

const SITE = "https://www.desitashan.su";
const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const OUT = path.resolve(process.argv[2] || "addon/dss-data");
const CONC = 8;

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
  august: 8, september: 9, october: 10, november: 11, december: 12,
};

/** Channels the site really publishes episodes under (first match wins). */
const KNOWN_CHANNELS = [
  "star-plus", "colors-tv", "zee-tv", "sony-tv", "sab-tv", "and-tv",
  "star-bharat", "dangal-tv", "mtv", "sun-neo", "netflix", "jiohotstar",
  "hotstar", "amazon-mx-player", "prime-video", "sonyliv", "star-maa",
  "vijay-television", "star-jalsha", "discovery-channel",
];

const log = (...a) => console.log(...a);

async function get(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        headers: { "user-agent": UA, accept: "*/*" },
        signal: AbortSignal.timeout(45000),
      });
      if (res.ok) return await res.text();
      if (res.status === 404) return "";
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 400 * (i + 1)));
  }
  return "";
}

/** Run fn over items with a fixed concurrency, order preserved. */
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      for (;;) {
        const k = i++;
        if (k >= items.length) return;
        out[k] = await fn(items[k], k);
      }
    }),
  );
  return out;
}

const locs = (xml) => [...String(xml).matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1].trim());

function normalizeChannel(raw) {
  let c = String(raw || "").toLowerCase().replace(/[^a-z0-9-]/g, "");
  if (!c) return "";
  c = c.replace(/-+$/g, "");
  if (/^\d+-hotstar$/.test(c)) return "hotstar";        // title-derived variant
  if (/-\d+$/.test(c)) c = c.replace(/-\d+$/, "");     // duplicate posts
  return c;
}

/**
 * Split an episode path segment into show/date/channel parts.
 * Returns null when the segment carries no date.
 */
function splitSegment(seg) {
  let rest = seg;
  let channel = "";
  let kind = "";
  const tail = rest.match(/-(full-episode|episode-preview|episode-promo|promo|episode)-([a-z0-9][a-z0-9-]*)$/);
  if (tail) {
    kind = tail[1];
    channel = normalizeChannel(tail[2]);
    rest = rest.slice(0, tail.index);
  }
  const dates = [...rest.matchAll(/-(\d{1,2})(?:st|nd|rd|th)?-([a-z]+)-(\d{4})(?=-|$)/g)];
  if (!dates.length) return null;
  const d = dates[dates.length - 1];
  const month = MONTHS[d[2]];
  if (!month) return null;
  const day = Number(d[1]);
  const year = Number(d[3]);
  if (day < 1 || day > 31) return null;
  const head = rest.slice(0, d.index).replace(/^-/, "");
  const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return { head, kind, channel, iso, date: `${day} ${d[2]} ${year}` };
}

const norm = (s) => String(s || "").replace(/[^a-z0-9]/g, "");

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * The site is inconsistent about slug spelling ({@code bhabi-ji-ghar-par-hai}
 * episodes vs {@code /category/bhabiji-ghar-par-hain/}) and about trailing
 * episode words ("…-grand-finale"), so fall back to a normalised match.
 */
function fuzzyCategory(head, cats) {
  const h = norm(head);
  if (h.length < 5) return "";
  let best = "";
  let bestScore = 0;
  for (const c of cats) {
    const n = norm(c);
    if (n.length < 5) continue;
    if (h.startsWith(n)) return c; // "indias-best-dancer-5-grand-finale" -> indias-best-dancer-5
    let p = 0;
    while (p < h.length && p < n.length && h[p] === n[p]) p++;
    const score = p / Math.max(h.length, n.length);
    const close =
      Math.abs(h.length - n.length) <= 2 && levenshtein(h, n) <= 2 ? 1 : score;
    if (close > bestScore) {
      bestScore = close;
      best = c;
    }
  }
  return bestScore >= 0.8 ? best : "";
}

function cleanName(raw) {
  return String(raw || "")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .replace(/^(latest|watch|all)\s+/i, "")
    .replace(/\s+(full\s+)?episodes?\s+(on|of)\b.*$/i, "")
    .replace(/\s*(Episodes? and Desi Serial Updates|Desi Serial Updates)\s*\|.*$/i, "")
    .replace(/\s*\|.*$/, "")
    .replace(/\s+episodes?$/i, "")
    .replace(/\s+on\s+[A-Za-z0-9&.\- ]+$/i, "")
    .trim();
}

function hubName(html, slug) {
  const h = String(html || "");
  const h1 = h.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
  const title = h.match(/<title>([^<]*)<\/title>/);
  const og = h.match(/property="og:title"[^>]*content="([^"]+)"/);
  const name = cleanName(
    (h1 ? h1[1] : "") || (og ? og[1] : "") || (title ? title[1] : "") || "",
  ).replace(/<[^>]*>/g, "");
  if (name) return name;
  return slug.split("-").filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

function hubPoster(html) {
  const h = String(html || "");
  const og = h.match(/property="og:image"[^>]*content="([^"]+)"/);
  const img = h.match(/<img[^>]+src="(\/media-cache\/[^"]+)"/);
  const raw = og ? og[1] : img ? img[1] : "";
  if (!raw) return "";
  return /^https?:/.test(raw) ? raw : SITE + (raw.startsWith("/") ? raw : "/" + raw);
}

async function main() {
  log("→ sitemap index");
  const index = await get(`${SITE}/sitemap.xml`);
  const postMaps = locs(index).filter((u) => /post-sitemap\d*\.xml$/.test(u));
  log(`  ${postMaps.length} post sitemaps`);

  log("→ category sitemap");
  const catXml = await get(`${SITE}/category-sitemap.xml`);
  const catLocs = locs(catXml).filter((u) => /\/category\//.test(u));
  /** slug -> channel taken from nested /category/<ch>/<show>/ entries. */
  const nested = new Map();
  const categories = [];
  for (const u of catLocs) {
    const m = u.match(/\/category\/([a-z0-9][a-z0-9-]*)(?:\/([a-z0-9][a-z0-9-]*))?\/?$/);
    if (!m) continue;
    if (m[2]) {
      nested.set(m[2], m[1]);
      if (!categories.includes(m[2])) categories.push(m[2]);
    } else if (!categories.includes(m[1])) {
      categories.push(m[1]);
    }
  }
  log(`  ${categories.length} categories (${nested.size} nested with a channel)`);
  // Longest slug first: episode segments are matched by longest prefix.
  const catsByLen = [...categories].sort((a, b) => b.length - a.length);

  log("→ episode sitemaps");
  const xmls = await pool(postMaps, CONC, async (u) => {
    const x = await get(u);
    return x ? x : "";
  });
  const seenPid = new Set();
  const episodes = []; // {seg, pid, iso, channel, kind, img}
  for (const x of xmls) {
    for (const block of String(x).matchAll(/<url>([\s\S]*?)<\/url>/g)) {
      const b = block[1];
      const lm = b.match(/<loc>([^<]+)<\/loc>/);
      if (!lm) continue;
      const em = lm[1].match(/^https?:\/\/[^/]+\/([^/]+)\/([a-f0-9]{16})\/?$/);
      if (!em) continue;
      const seg = em[1];
      const pid = em[2];
      if (seenPid.has(pid)) continue;
      const parts = splitSegment(seg);
      if (!parts) continue;
      seenPid.add(pid);
      const im = b.match(/<image:loc>([^<]+)<\/image:loc>/);
      const img = im ? im[1].replace(/^https?:\/\/[^/]+/, "").replace(/^\/media-cache\//, "") : "";
      episodes.push({ seg, pid, iso: parts.iso, channel: parts.channel, kind: parts.kind, img });
    }
  }
  log(`  ${episodes.length} episodes (${seenPid.size} unique pids)`);

  // show slug = longest category slug that prefixes the episode segment
  const shows = new Map(); // slug -> {eps:[], channels:{}}
  let orphan = 0;
  const orphans = new Map();
  for (const ep of episodes) {
    let slug = "";
    for (const c of catsByLen) {
      if (ep.seg === c || ep.seg.startsWith(c + "-")) {
        slug = c;
        break;
      }
    }
    if (!slug) {
      // second pass: same slug, different spelling / extra episode words
      const head = splitSegment(ep.seg)?.head || "";
      slug = fuzzyCategory(head, categories);
      if (slug) {
        ep.fuzzy = true;
      } else {
        orphan++;
        orphans.set(head, (orphans.get(head) || 0) + 1);
        continue;
      }
    }
    let entry = shows.get(slug);
    if (!entry) shows.set(slug, (entry = { eps: [], channels: new Map() }));
    entry.eps.push(ep);
    if (ep.channel) entry.channels.set(ep.channel, (entry.channels.get(ep.channel) || 0) + 1);
  }
  log(`  ${shows.size} shows with episodes (${orphan} orphan episodes skipped)`);
  if (orphans.size) {
    log("  top orphans:", [...orphans.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8));
  }

  // keep only real shows: a category that never yields episodes is a channel/hub
  const showSlugs = [...shows.keys()].filter((s) => !KNOWN_CHANNELS.includes(s));
  for (const s of showSlugs) shows.get(s).eps.sort((a, b) => (a.iso < b.iso ? 1 : a.iso > b.iso ? -1 : 0));

  log(`→ hub pages for ${showSlugs.length} shows (names + posters)`);
  let done = 0;
  const hubs = await pool(showSlugs, CONC, async (slug) => {
    const html = await get(`${SITE}/category/${slug}/`);
    if (++done % 40 === 0) log(`  ${done}/${showSlugs.length}`);
    return html;
  });
  const hubBySlug = new Map(showSlugs.map((s, i) => [s, hubs[i]]));

  const outShows = {};
  const epDir = path.join(OUT, "ep");
  await rm(OUT, { recursive: true, force: true });
  await mkdir(epDir, { recursive: true });

  for (const slug of showSlugs) {
    const entry = shows.get(slug);
    const eps = entry.eps;
    const counts = [...entry.channels.entries()].sort((a, b) => b[1] - a[1]);
    const known = counts.filter(([c]) => KNOWN_CHANNELS.includes(c));
    const channel = nested.get(slug) || (known[0] && known[0][0]) || (counts[0] && counts[0][0]) || "";
    const allChannels = counts.map(([c]) => c);
    const newest = eps.length ? eps[0].iso : "";
    const hub = hubBySlug.get(slug) || "";
    const name = hubName(hub, slug);
    let poster = hubPoster(hub);
    // many hubs only advertise the site banner -> use the newest episode still
    if (!/\/media-cache\//.test(poster)) {
      poster = eps.length && eps[0].img ? `${SITE}/media-cache/${eps[0].img}` : poster;
    }
    outShows[slug] = [channel, eps.length, newest, name, poster, allChannels];
    await writeFile(
      path.join(epDir, `${slug}.json`),
      JSON.stringify(eps.map((e) => [e.seg, e.pid, e.iso, e.img])),
    );
  }

  await writeFile(
    path.join(OUT, "shows.json"),
    JSON.stringify({ built: new Date().toISOString(), site: SITE, shows: outShows }),
  );

  const byChannel = {};
  for (const [, v] of Object.entries(outShows)) {
    for (const c of v[5]) byChannel[c] = (byChannel[c] || 0) + 1;
  }
  log("→ channels:", JSON.stringify(byChannel));
  log(`✓ ${Object.keys(outShows).length} shows -> ${OUT}`);
}

main().catch((err) => {
  console.error("build failed:", err);
  process.exit(1);
});
