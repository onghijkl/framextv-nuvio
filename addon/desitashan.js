/**
 * Desi Tashan (desitashan.su) — Nuvio / Stremio addon module.
 *
 * Mounted by worker.js at  /dts/*
 *
 *   GET /dts/manifest.json
 *   GET /dts/catalog/<type>/<id>.json[?skip=&search=]
 *   GET /dts/meta/<type>/<id>.json
 *   GET /dts/stream/<type>/<id>.json
 *   GET /dts/p?u=<b64url episode path>    -> 302 to a freshly signed CDN url
 *
 * Scene source (all verified 2026-11-12):
 *   /feed.xml                           50 latest episodes
 *   /sidebar-feed.php?limit=20&offset=N JSON { latest:[{title,url,image,alt}] }
 *   /sitemap.xml                        28k episode urls + 230 flat categories
 *   /category/<channel>/page/N/         20 episodes per page (+ their show links)
 *   /category/<slug>/                   show hub: og:image poster + channel
 *   /search/<query>                     episode results
 *
 * Stream chain — desktop browser, Referer and the whole ad-gate are NOT needed:
 *   1. episode page            -> getlink.php?v=<token>   (172 char base64)
 *   2. media_meta.php?v=<token>&type=player -> JSON .source.file =
 *        "play.php?v=<fresh signed token>&exp=<ts>&sig=.."   (mimeType video/mp4)
 *   3. play.php?v=..&exp=..&sig=..  -> 302 -> mds.storage.yandex.net/rdisk/.../<name>.mp4
 *        (206, video/mp4, Range supported)
 *
 * play.php tokens expire after ~60 min, so /dts/p re-resolves on every play and the
 * url handed to the player never goes stale.
 */

const SITE = "https://www.desitashan.su";
const SITE_REF = "https://www.desitashan.su/";
const FREEZOD_PLAY = "https://freezod.com/hls-synapsixto/";
const FREEZOD_META = "https://freezod.com/hls-synapsixto/media_meta.php";

const ADDON_VERSION = "1.2.1";
// The series-only add-on (/dss) is versioned independently from the add-on
// that carries channels + search (/dts).
const SERIES_VERSION = "1.2.1";

const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

/** Channels that have a /category/<slug>/ page (all verified 200). */
const CHANNELS = [
  { slug: "star-plus", name: "Star Plus" },
  { slug: "zee-tv", name: "Zee TV" },
  { slug: "sony-tv", name: "Sony TV" },
  { slug: "sab-tv", name: "SAB TV" },
  { slug: "colors-tv", name: "Colors TV" },
  { slug: "and-tv", name: "&TV" },
  { slug: "star-bharat", name: "Star Bharat" },
  { slug: "dangal-tv", name: "Dangal TV" },
  { slug: "mtv", name: "MTV" },
  { slug: "sun-neo", name: "Sun Neo" },
  { slug: "jiohotstar", name: "JioHotstar" },
  { slug: "amazon-mx-player", name: "Amazon MX Player" },
  { slug: "prime-video", name: "Prime Video" },
  { slug: "netflix", name: "Netflix" },
];

const CHANNEL_NAMES = Object.fromEntries(CHANNELS.map((c) => [c.slug, c.name]));
const PAGE_SIZE = 20;
const FALLBACK_POSTER = SITE + "/images/banner-v2.png";

/* ------------------------------------------------------------------ utils */

const MEM = new Map();

function memGet(key) {
  const hit = MEM.get(key);
  if (!hit) return null;
  if (hit.exp < Date.now()) {
    MEM.delete(key);
    return null;
  }
  return hit.value;
}

function memSet(key, value, ttlMs) {
  if (MEM.size > 400) MEM.clear();
  MEM.set(key, { value, exp: Date.now() + ttlMs });
  return value;
}

/** HTML entity decode + tag strip. */
function text(s) {
  return String(s == null ? "" : s)
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/\s+/g, " ")
    .trim();
}

function json(body, maxAge = 300, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": "public, max-age=" + maxAge,
    },
  });
}

function b64urlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str) {
  const s = String(str || "").replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** GET returning a live Response (never cached — for redirects/streams). */
async function fetchRaw(url, opts = {}) {
  const { referer, redirect = "follow", timeout = 15000, headers = {} } = opts;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    return await fetch(url, {
      redirect,
      signal: ctl.signal,
      headers: Object.assign(
        { "user-agent": UA, accept: "*/*", "accept-language": "en-US,en;q=0.9" },
        referer ? { referer } : {},
        headers
      ),
    });
  } finally {
    clearTimeout(timer);
  }
}

/** GET returning the body text, memoised in-isolate for ttlMs. */
async function fetchText(url, ttlMs = 0, referer = SITE_REF) {
  const key = ttlMs ? "t:" + url : null;
  if (key) {
    const hit = memGet(key);
    if (hit != null) return hit;
  }
  const res = await fetchRaw(url, { referer });
  const body = res.ok ? await res.text() : "";
  if (key && body) memSet(key, body, ttlMs);
  return body;
}

/** Absolute url for a site-relative asset path. */
function abs(path) {
  if (!path) return "";
  if (/^https?:/i.test(path)) return path;
  return SITE + (path.startsWith("/") ? path : "/" + path);
}

/** "anupama-12th-november-2026-full-episode-star-plus" -> "Anupama 12Th November 2026 Full Episode Star Plus" */
function prettify(slug) {
  return String(slug || "")
    .split("-")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

const HEX_ID = /^[a-f0-9]{16}$/;

function episodePath(slug, pid) {
  return "/" + slug + "/" + pid + "/";
}

function episodeId(slug, pid) {
  return "dts:ep:" + slug + "_" + pid;
}

function showId(slug, channel) {
  const key = channel ? channel + "~" + slug : slug;
  return "dts:show:" + key;
}

/* ---------------------------------------------------------------- parsers */

/** /feed.xml -> [{title, link, guid, pubDate, image}] */
function parseFeed(xml) {
  const out = [];
  const items = String(xml || "").split("<item>").slice(1);
  for (const raw of items) {
    const item = raw.split("</item>")[0];
    const pick = (tag) => {
      const m = item.match(new RegExp("<" + tag + ">(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</" + tag + ">"));
      return m ? m[1].trim() : "";
    };
    const link = pick("link");
    const m = link.match(/\/([a-z0-9][a-z0-9-]*)\/([a-f0-9]{16})\/?$/);
    if (!m) continue;
    const thumb = item.match(/<media:thumbnail[^>]*url="([^"]+)"/);
    out.push({
      slug: m[1],
      pid: m[2],
      title: text(pick("title")),
      image: abs(thumb ? thumb[1] : ""),
      released: pick("pubDate"),
    });
  }
  return out;
}

/**
 * Episode cards. The two card shapes on channel/show/search pages are
 *   <article class="post-card card has-date">      (grid)
 *   <article class="spotlight-item">               (spotlight row)
 * both of which put the href before the <img>, the date/number spans, the <h3>
 * and a <div class="post-meta"> carrying the show + channel category links.
 */
function parseCards(html) {
  const out = [];
  const seen = new Set();
  const parts = String(html || "").split("<article");
  for (const part of parts) {
    const chunk = part.slice(0, 3000);
    const m = chunk.match(/href="\/([a-z0-9][a-z0-9-]*)\/([a-f0-9]{16})\/"/);
    if (!m) continue;
    const slug = m[1];
    const pid = m[2];
    if (seen.has(pid)) continue;
    seen.add(pid);

    const img = chunk.match(/<img[^>]+src="(\/media-cache\/[^"]+)"/);
    const h3 = chunk.match(/<h3[^>]*>[\s\S]{0,80}?<a[^>]*>([\s\S]{0,200}?)<\/a>/) || chunk.match(/<h3[^>]*>([\s\S]{0,200}?)<\/h3>/);
    const date = chunk.match(/class="(?:episode-date-card|spotlight-date)"[^>]*>([\s\S]{0,60}?)<\//);
    const released = chunk.match(/itemprop="datePublished"[^>]*content="([^"]+)"/);
    const desc = chunk.match(/itemprop="description"[^>]*content="([^"]+)"/);

    // post-meta: /category/<channel>/ (channel) and /category/<channel>/<show>/ (show)
    let showKey = "";
    let channel = "";
    const catRe = /href="\/category\/([a-z0-9][a-z0-9-]*)(?:\/([a-z0-9][a-z0-9-]*))?\/"/g;
    let c;
    while ((c = catRe.exec(chunk))) {
      if (c[2]) showKey = c[1] + "/" + c[2];
      else channel = c[1];
    }

    out.push({
      slug,
      pid,
      id: episodeId(slug, pid),
      title: text(h3 ? h3[1] : "") || prettify(slug),
      image: abs(img ? img[1] : ""),
      date: text(date ? date[1] : ""),
      episode: 0, // the site exposes no reliable number; assigned by list order
      released: released ? released[1] : "",
      description: text(desc ? desc[1] : ""),
      showKey,
      showName: showKey ? prettify(showKey.split("/")[1]) : "",
      channel,
    });
  }
  return out;
}

/** /category-sitemap.xml -> ["vasudha", "bigg-boss-20", ...] minus channel slugs. */
function parseCategorySitemap(xml) {
  const out = [];
  const seen = new Set();
  const re = /<loc>[^<]*\/category\/([a-z0-9][a-z0-9-]+)(?:\/([a-z0-9][a-z0-9-]+))?\/<\/loc>/g;
  let m;
  while ((m = re.exec(String(xml || "")))) {
    const channel = m[2] ? m[1] : "";
    const slug = m[2] || m[1];
    if (CHANNEL_NAMES[slug] && !m[2]) continue;
    const key = channel ? channel + "~" + slug : slug;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/** Show hub page -> {name, poster, channel} */
function parseShowHub(html, slug) {
  const h = String(html || "");
  const og = h.match(/property="og:image"[^>]*content="([^"]+)"/);
  const img = h.match(/<img[^>]+src="(\/media-cache\/[^"]+)"/);
  const title = h.match(/<title>([^<]*)<\/title>/);
  const h1 = h.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
  // Site nav always links /category/<ch>/ first, so when we know the show slug
  // only accept a channel that actually hosts *this* show.
  let channel = slug
    ? h.match(new RegExp('href="/category/([a-z0-9][a-z0-9-]*)/' + slug + '/"'))
    : null;
  if (!channel) channel = h.match(/href="\/category\/([a-z0-9][a-z0-9-]*)\/"/);
  let name = text(h1 ? h1[1] : title ? title[1] : "");
  name = name
    .replace(/^(latest|watch|all)\s+/i, "")
    .replace(/\s+(full\s+)?episodes?\s+(on|of)\b.*$/i, "")
    .replace(/\s*(Episodes? and Desi Serial Updates|Desi Serial Updates)\s*\|.*$/i, "")
    .replace(/\s*\|.*$/, "")
    .replace(/\s+episodes?$/i, "")
    .trim();
  return {
    name: name || "",
    poster: abs(og ? og[1] : img ? img[1] : ""),
    channel: channel ? channel[1] : "",
  };
}

/** Episode page -> {title, image, slug, pid, token} */
function parseEpisodePage(html) {
  const h = String(html || "");
  let data = null;
  const block = h.match(/<script type="application\/json" id="episode-client-data">([\s\S]*?)<\/script>/);
  if (block) {
    try {
      data = JSON.parse(block[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
    } catch {
      data = null;
    }
  }
  const og = h.match(/property="og:image"[^>]*content="([^"]+)"/);
  const title = h.match(/<title>([^<]*)<\/title>/);
  const desc = h.match(/name="description"[^>]*content="([^"]+)"/);
  const tokens = [];
  const tokRe = /getlink\.php\?v=([A-Za-z0-9+/=_-]+)/g;
  let m;
  while ((m = tokRe.exec(h))) {
    if (!tokens.includes(m[1])) tokens.push(m[1]);
  }
  const name = data && data.title ? text(data.title) : text(title ? title[1] : "");
  return {
    name,
    slug: data && data.slug ? data.slug : "",
    pid: data && data.publicId ? data.publicId : "",
    image: abs(data && data.image ? data.image : og ? og[1] : ""),
    description: text(desc ? desc[1] : ""),
    tokens,
  };
}

/* ------------------------------------------------------------- resolvers */

/** episode page -> freezod token (cached 10 min). */
async function episodeToken(path) {
  const key = "tok:" + path;
  const hit = memGet(key);
  if (hit) return hit;
  const html = await fetchText(SITE + path, 10 * 60 * 1000, SITE_REF);
  const page = parseEpisodePage(html);
  if (!page.tokens.length) return null;
  return memSet(key, { token: page.tokens[0], page }, 10 * 60 * 1000);
}

/** token -> signed relative play.php url (cached 2 min; the token lives ~60). */
async function playFile(token) {
  const key = "meta:" + token;
  const hit = memGet(key);
  if (hit) return hit;
  const body = await fetchText(
    FREEZOD_META + "?v=" + encodeURIComponent(token) + "&type=player",
    2 * 60 * 1000,
    // media_meta.php 403s when the Referer is the Desi Tashan site; the
    // freezod origin (or no Referer at all) is accepted.
    FREEZOD_PLAY
  );
  if (!body) return null;
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    return null;
  }
  const file = data && data.source && data.source.file;
  if (!file) return null;
  return memSet(
    key,
    { file, title: (data.source && data.source.title) || "", image: data.source && data.source.image },
    2 * 60 * 1000
  );
}

/** play.php -> Location header of the CDN redirect (never cached). */
async function playLocation(file) {
  const target = /^https?:/i.test(file) ? file : FREEZOD_PLAY + file;
  // No Referer here: play.php 403s when one is sent from a foreign origin.
  const res = await fetchRaw(target, { redirect: "manual", timeout: 15000 });
  const loc = res.headers.get("location");
  if (loc) return new URL(loc, FREEZOD_PLAY).toString();
  // Depending on the edge node play.php answers 302 to the signed CDN url or
  // proxies the file itself (200 + Accept-Ranges). Both are playable.
  if (res.status === 200 || res.status === 206) return target;
  return "";
}

/* -------------------------------------------------------------- metadata */

/** Episode slugs sometimes carry the whole card title, e.g.
 *  "bigg-boss-malayalam-season-8-..-full-episode-jiohotstar". */
function slugChannel(slug) {
  const m = String(slug || "").match(/-full-episode-([a-z0-9]+(?:-[a-z0-9]+)*)$/i);
  return m ? m[1] : "";
}

function slugName(slug) {
  return prettify(String(slug || "").replace(/-?full-episode(-[a-z0-9-]+)?$/i, ""));
}

async function episodeMeta(id) {
  const m = String(id).match(/^dts:ep:(.+)_([a-f0-9]{16})$/);
  if (!m) return null;
  const slug = m[1];
  const pid = m[2];
  const html = await fetchText(SITE + episodePath(slug, pid), 30 * 60 * 1000, SITE_REF);
  const page = parseEpisodePage(html);
  const raw = page.name || "";
  const name = cleanEpisodeTitle(raw) || slugName(slug) || prettify(slug);
  const ch = titleChannel(raw) || slugChannel(slug);
  const label = ch ? channelLabel(ch) : "";
  return {
    id,
    type: "movie",
    name,
    poster: page.image || FALLBACK_POSTER,
    posterShape: "landscape",
    description: label && label !== name ? label : name,
    releaseInfo: label || undefined,
    behaviorHints: { defaultVideoId: id },
  };
}

/** slug -> owning channel, derived from the nested /category/<ch>/<show>/ sitemap. */
/* ------------------------------------------------------------ series index --
 * /category-sitemap.xml nests only ~50 of the ~207 serials the site carries and
 * the "Watch by Channel" pages advertise just the shows that aired in the last
 * few weeks, so the add-on reads a snapshot of the site's sitemap built by
 * tools/build-dts-index.mjs and published with this deployment:
 *
 *   /dss-data/shows.json      every serial: channel, episode count, name, poster
 *   /dss-data/ep/<slug>.json  every episode of one serial (seg + public id)
 *
 * The live hub page is always merged on top, so episodes appear the day they air.
 */
const DTS_DATA_DIR = "/dss-data";
const DTS_INDEX_TTL = 6 * 60 * 60 * 1000;
const DTS_MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
const DTS_MONTH_LABELS = DTS_MONTHS.map((n) => n[0].toUpperCase() + n.slice(1));
const DTS_MONTH_INDEX = {};
DTS_MONTHS.forEach((n, i) => {
  DTS_MONTH_INDEX[n.slice(0, 3)] = i;
});
let DTS_INDEX_MEM = null;

function isoFromParts(day, monthName, year) {
  const at = DTS_MONTH_INDEX[String(monthName || "").toLowerCase().slice(0, 3)];
  if (at === undefined) return "";
  return year + "-" + String(at + 1).padStart(2, "0") + "-" + String(day).padStart(2, "0");
}

function prettyDate(iso) {
  const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return "";
  const label = DTS_MONTH_LABELS[Number(m[2]) - 1];
  if (!label) return "";
  return Number(m[3]) + " " + label + " " + m[1];
}

/**
 * Episode segments look like
 * `naagin-7-14th-june-2026-full-episode-colors-tv` — the date is the last
 * `-<day><ordinal>-<month>-<year>` group and anything between the serial slug
 * and that date ("written-update", "maha-episode", …) is episode specific.
 */
function segInfo(seg, serialSlug) {
  const raw = String(seg || "");
  const re = /-(\d{1,2})(?:st|nd|rd|th)?-([a-z]+)-(\d{4})(?=-|$)/g;
  let m;
  let last = null;
  while ((m = re.exec(raw))) last = m;
  if (!last) return { iso: "", extra: "" };
  let head = raw.slice(0, last.index);
  if (serialSlug && head.indexOf(serialSlug) === 0) head = head.slice(serialSlug.length);
  return { iso: isoFromParts(last[1], last[2], last[3]), extra: head.replace(/^-+|-+$/g, "") };
}

function indexEntry(slug, row) {
  const channels = Array.isArray(row[5]) && row[5].length ? row[5] : row[0] ? [row[0]] : [];
  return {
    slug: slug,
    channel: row[0] || channels[0] || "",
    channels: channels,
    count: Number(row[1]) || 0,
    newest: row[2] || "",
    name: row[3] || prettify(slug),
    poster: row[4] ? abs(row[4]) : "",
  };
}

function indexFromShows(shows) {
  const index = new Map();
  for (const slug of Object.keys(shows || {})) index.set(slug, indexEntry(slug, shows[slug]));
  return index;
}

/** Every serial on the site, newest episode first (falls back to the sitemap). */
async function dtsIndex(origin) {
  if (DTS_INDEX_MEM && Date.now() - DTS_INDEX_MEM.at < DTS_INDEX_TTL) return DTS_INDEX_MEM;
  let shows = new Map();
  let built = "";
  if (origin) {
    try {
      const res = await fetchRaw(new URL(DTS_DATA_DIR + "/shows.json", origin).toString(), { timeout: 12000 });
      if (res && res.ok) {
        const raw = await res.json();
        shows = indexFromShows(raw && raw.shows);
        built = (raw && raw.built) || "";
      }
    } catch (err) {
      // snapshot unavailable (plain worker deploy) -> degraded sitemap mode
    }
  }
  if (!shows.size) {
    for (const key of await parseCategorySitemap()) {
      if (typeof key !== "string" || !key) continue;
      const at = key.indexOf("~");
      const channel = at > 0 ? key.slice(0, at) : "";
      const slug = at > 0 ? key.slice(at + 1) : key;
      if (!slug || shows.has(slug)) continue;
      shows.set(slug, {
        slug: slug,
        channel: channel,
        channels: channel ? [channel] : [],
        count: 0,
        newest: "",
        name: prettify(slug),
        poster: "",
      });
    }
  }
  DTS_INDEX_MEM = { at: Date.now(), built: built, shows: shows };
  return DTS_INDEX_MEM;
}

async function indexShows(origin) {
  return [...(await dtsIndex(origin)).shows.values()];
}

function byNewest(a, b) {
  return String(b.newest || "").localeCompare(String(a.newest || "")) || a.name.localeCompare(b.name);
}

/** Serials that air on / were posted under one channel, A-Z. */
function channelIndexShows(index, channelSlug) {
  const out = [];
  for (const show of index.values()) {
    if (show.channel === channelSlug || show.channels.indexOf(channelSlug) >= 0) out.push(show);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function searchIndexShows(index, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return [];
  const out = [];
  for (const show of index.values()) {
    const names = [show.name, show.slug, channelLabel(show.channel)]
      .concat(show.channels.map((c) => channelLabel(c)))
      .join(" ")
      .toLowerCase();
    if (names.indexOf(q) >= 0) out.push(show);
  }
  return out.sort(byNewest);
}

/** Series card for a catalog row — no network, the index has name + poster. */
function indexCard(show, label) {
  const channel = label || channelLabel(show.channel) || "Desi Tashan";
  const bits = [channel];
  if (show.newest) bits.push(prettyDate(show.newest));
  if (show.count) bits.push(show.count + (show.count === 1 ? " episode" : " episodes"));
  return {
    id: showId(show.slug, show.channel),
    type: "series",
    name: show.name || prettify(show.slug),
    poster: show.poster || FALLBACK_POSTER,
    posterShape: "landscape",
    description: bits.join(" · "),
    releaseInfo: channel,
  };
}

/**
 * Snapshot rows `[segment, publicId, "YYYY-MM-DD", "xx/<md5>.jpg"]` -> episode
 * records. Older snapshots only carried `[segment, publicId, imagePath]`, so
 * pick the fields by shape instead of by position.
 */
function parseEpisodesPayload(rows) {
  const out = [];
  if (!Array.isArray(rows)) return out;
  for (const row of rows) {
    if (!Array.isArray(row) || !row[0] || !row[1]) continue;
    let iso = "";
    let img = "";
    for (let i = 2; i < row.length; i++) {
      const v = row[i] == null ? "" : String(row[i]).trim();
      if (!v) continue;
      if (/^\d{4}-\d{2}-\d{2}/.test(v)) {
        if (!iso) iso = v.slice(0, 10);
        continue;
      }
      if (!img && (/\.(?:jpe?g|png|webp)$/i.test(v) || v.indexOf("/") > -1)) img = v;
    }
    out.push({
      seg: String(row[0]),
      pid: String(row[1]),
      iso: iso,
      image: img ? SITE + "/media-cache/" + img.replace(/^\/?media-cache\//, "") : "",
    });
  }
  return out;
}

/**
 * The complete episode list of one serial: the snapshot (every episode the site
 * ever indexed) merged with the live hub page, newest first. The site's own
 * episode numbers are unreliable, so numbers are assigned by date, newest =
 * highest — showMeta and pathForStreamId share this list so they always agree.
 */
async function showEpisodes(serialSlug, channel, origin) {
  const found = new Map();
  const add = (seg, pid, image, live, iso) => {
    if (!seg || !pid) return;
    const prev = found.get(pid);
    if (prev) {
      if (live) {
        if (live.title) prev.title = live.title;
        if (live.image) prev.image = abs(live.image);
      }
      if (iso && !prev.date) prev.date = iso;
      return;
    }
    found.set(pid, {
      seg: seg,
      pid: pid,
      image: abs(image || ""),
      title: live && live.title ? live.title : "",
      date: iso || segInfo(seg, serialSlug).iso,
    });
  };
  if (origin) {
    try {
      const res = await fetchRaw(new URL(DTS_DATA_DIR + "/ep/" + serialSlug + ".json", origin).toString(), {
        timeout: 12000,
      });
      if (res && res.ok) {
        for (const row of parseEpisodesPayload(await res.json()))
          add(row.seg, row.pid, row.image, null, row.iso);
      }
    } catch (err) {
      // no snapshot for this serial (brand new show) -> live pages only
    }
  }
  const cards = parseCards(await fetchShowHub(serialSlug, channel));
  for (const card of cards) {
    if (!card.slug || !card.pid) continue;
    if (card.slug !== serialSlug && card.slug.indexOf(serialSlug + "-") !== 0) continue;
    add(card.slug, card.pid, card.image, { title: cleanEpisodeTitle(card.title), image: card.image });
  }
  const list = [...found.values()].sort((a, b) => {
    return String(b.date || "").localeCompare(String(a.date || "")) || a.seg.localeCompare(b.seg);
  });
  const total = list.length;
  return list.map((ep, i) => ({
    id: episodeId(ep.seg, ep.pid),
    season: 1,
    episode: total - i,
    title: ep.title || (prettify(serialSlug) + " " + prettyDate(ep.date)).trim(),
    released: ep.date ? ep.date + "T00:00:00.000Z" : "",
    thumbnail: ep.image || "",
    seg: ep.seg,
    pid: ep.pid,
  }));
}

/** Hub (serial landing) page, channel-qualified when we know the channel. */
async function fetchShowHub(serialSlug, channel) {
  const paths = channel
    ? ["/category/" + channel + "/" + serialSlug + "/", "/category/" + serialSlug + "/"]
    : ["/category/" + serialSlug + "/"];
  for (const path of paths) {
    const html = await fetchText(SITE + path, 6 * 60 * 60 * 1000, SITE_REF);
    if (html) return html;
  }
  return "";
}

/** Serial slug of an episode segment: `…-12th-november-2026-full-episode-x-tv`. */
function segShowSlug(seg) {
  const raw = String(seg || "");
  const re = /-(\d{1,2})(?:st|nd|rd|th)?-([a-z]+)-(\d{4})(?=-|$)/g;
  let m;
  let last = null;
  while ((m = re.exec(raw))) last = m;
  const head = last ? raw.slice(0, last.index) : raw;
  return head.replace(/^-+|-+$/g, "");
}

/** Series card for a serial the snapshot does not know yet (brand new show). */

/** Show hub + its channel listing -> series meta with videos[]. */
/**
 * Series meta for `dts:show:<channel>~<slug>[:<season>:<episode>]` carrying the
 * COMPLETE episode list of the serial (snapshot + live hub page).
 */
async function showMeta(id, origin) {
  const m = String(id).match(/^dts:show:(?:(.+?)~)?(.+?)(?::(.*))?$/);
  if (!m) return null;
  const slug = m[2];
  const index = await dtsIndex(origin);
  const entry = index.shows.get(slug);
  let channel = m[1] || (entry ? entry.channel : "");
  let hub = null;
  if (!entry || !entry.name || !entry.poster) {
    hub = parseShowHub(await fetchShowHub(slug, channel), slug);
  }
  if (!channel && hub) channel = hub.channel;
  const name = (entry && entry.name) || (hub && hub.name) || prettify(slug);
  const poster = (entry && entry.poster) || (hub && hub.poster) || FALLBACK_POSTER;
  const label = channelLabel(channel) || "Desi Tashan";
  const videos = await showEpisodes(slug, channel, origin);
  const release = entry && entry.newest ? "Latest " + prettyDate(entry.newest) : label;
  return {
    id: showId(slug, channel),
    type: "series",
    name: name,
    poster: poster,
    posterShape: "landscape",
    background: poster,
    logo: poster,
    description:
      label +
      " · " +
      videos.length +
      (videos.length === 1 ? " episode" : " episodes") +
      " · complete episode list, no ads",
    releaseInfo: release,
    genres: [label],
    videos: videos,
  };
}

/* -------------------------------------------------------------- catalogs */

/** /dts "Latest" row — serials ordered by their newest episode. */
async function latestCatalog(skip, origin) {
  const shows = (await indexShows(origin)).sort(byNewest);
  return showRowCatalog(shows, skip, "", origin);
}

function metaCard(slug, pid, name, poster, released) {
  return {
    id: episodeId(slug, pid),
    type: "movie",
    name,
    poster: poster || FALLBACK_POSTER,
    posterShape: "landscape",
    releaseInfo: released ? String(released).slice(0, 10) : undefined,
  };
}

/** /dts per-channel row — every serial of that channel, A-Z. */
async function channelCatalog(slug, skip, origin) {
  const index = await dtsIndex(origin);
  return showRowCatalog(channelIndexShows(index.shows, slug), skip, "", origin);
}

/** /dts search — serials whose name, slug or channel matches. */
async function searchCatalog(query, skip, origin) {
  const index = await dtsIndex(origin);
  return showRowCatalog(searchIndexShows(index.shows, query), skip, "", origin);
}

/**
 * Shows catalog: every flat /category/<slug>/ in the sitemap is a show hub.
 * Posters come from the hub page (og:image); the hub also names its channel,
 * which showMeta() then reuses for the full episode list.
 */
/** /dts "All serials" row — the whole library, A-Z. */
async function showsCatalog(skip, origin) {
  const shows = (await indexShows(origin)).sort((a, b) => a.name.localeCompare(b.name));
  return showRowCatalog(shows, skip, "", origin);
}

/* ---------------------------------------------------------------- streams */

/** Resolve a playable episode path out of any id form a client may send. */
/** Resolve a stream id to the on-site episode path (used by handleStream). */
async function pathForStreamId(id, origin) {
  const raw = String(id || "");

  // dts:ep:<episode-segment>_<publicId>
  let m = raw.match(/dts:ep:(.+)_([a-f0-9]{16})$/);
  if (m) return episodePath(m[1], m[2]);

  // dts:show:<channel>~<slug>[:<season>:<episode>]
  m = raw.match(/dts:show:([a-z0-9][a-z0-9-]*(?:~[a-z0-9][a-z0-9-]*)?)(?::(.*))?$/);
  if (m) {
    const parts = m[1].split("~");
    const slug = parts.length > 1 ? parts[1] : parts[0];
    const channel = parts.length > 1 ? parts[0] : "";
    const sel = (m[2] || "").split(":").filter(Boolean);
    const pid = sel.find((s) => HEX_ID.test(s));
    if (pid) return episodePath(slug, pid);

    // exactly the list (and numbering) showMeta returned
    const videos = await showEpisodes(slug, channel, origin);
    if (!videos.length) return "";
    const nums = sel.map(Number).filter((n) => Number.isFinite(n) && n > 0);
    const want = nums.length ? nums[nums.length - 1] : 1;
    const hit = videos.find((v) => v.episode === want) || videos[0];
    return episodePath(hit.seg, hit.pid);
  }

  // bare public id — only usable if we saw it in a listing this isolate
  m = raw.match(/([a-f0-9]{16})$/);
  if (m) {
    const idx = memGet("pid:" + m[1]);
    if (idx) return episodePath(idx, m[1]);
  }
  return "";
}

/* ----------------------------------------------------------------- router */

/* --------------------------------------------- series-only add-on (/dss)
 * A second manifest so the serial library can be installed as its own add-on:
 *   <origin>/dss/manifest.json
 * Its rows are ordered by channel name ("Serials — By Channel") and by
 * publish time, newest first ("Serials — New Updates"). Meta/stream reuse the
 * /dts implementation, so ids stay interchangeable between both add-ons.
 */

const SERIES_MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** "12th November 2026" -> UTC ms (0 when the title has no date). */
function titleDate(title) {
  const m = String(title || "").match(/(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\.?\s*(\d{4})/i);
  if (!m) return 0;
  const mon = SERIES_MONTHS[m[2].slice(0, 3).toLowerCase()];
  if (mon === undefined) return 0;
  return Date.UTC(Number(m[3]), mon, Number(m[1]));
}

/** "… Full Episode | Zee TV" -> "Zee TV" */
function titleChannel(title) {
  const parts = String(title || "").split("|");
  return parts.length > 1 ? text(parts[parts.length - 1]) : "";
}

function channelLabel(slug) {
  return slug ? CHANNEL_NAMES[slug] || prettify(slug) : "Other";
}

/**
 * Every show hub exactly once, tagged with its channel, sorted by channel
 * name and then show name. Channel-qualified sitemap keys win over flat ones,
 * because they already carry the hub path.
 */
/** Every serial the site carries, plus channel/count/newest metadata. */
async function seriesShowKeys(origin) {
  return indexShows(origin);
}

/** Row 1 — shows ordered by channel name, then show name. */
/** Hidden fallback row: every serial grouped by channel then name. */
async function showsByChannelCatalog(skip, origin) {
  const shows = await indexShows(origin);
  shows.sort((a, b) => {
    const ca = channelLabel(a.channel) || "zzz";
    const cb = channelLabel(b.channel) || "zzz";
    return ca.localeCompare(cb) || a.name.localeCompare(b.name);
  });
  return showRowCatalog(shows, skip, "", origin);
}

/** Row 2 — newest episodes across every channel, newest first. */
/** Hidden fallback row: serials ordered by their newest episode. */
async function updatesCatalog(skip, origin) {
  const shows = (await indexShows(origin)).sort(byNewest);
  return showRowCatalog(shows, skip, "", origin);
}

/** "Anupama 12th November 2026 Full Episode | Star Plus" -> "Anupama 12 November 2026" */
function cleanEpisodeTitle(title) {
  return String(title || "")
    .split("|")[0]
    .replace(/\s+(full\s+)?episode\b/i, "")
    .replace(/(\d{1,2})(st|nd|rd|th)\s+/i, "$1 ")
    .trim();
}

/* ---------------------------------------------------------------------------
 * Dashboard clone (/dss) — the catalogs below are cloned one-for-one from the
 * desitashan.su dashboard (homepage), keeping its order and labels:
 *   "New Episode Spotlight"         -> dss:spotlight  (series: the shows it highlights)
 *   "Latest Desi Tashan Episodes"   -> dss:latest     (series, 32/page)
 *   "Watch by Channel" (8 tiles)    -> dss:ch:<slug>  (series: that channel's shows)
 *   search box + full index         -> dss:search / dss:all
 *
 * Every row is `series`: a card is always a show hub (tap -> that show's episode
 * list), never a bare episode, so the client never has to guess what a card is.
 * Episode ids stay identical to /dts, so meta/stream resolve from either addon.

/** "Watch by Channel" tiles, exactly as the dashboard lists them (order + labels). */
const DASH_TILES = [
  { slug: "star-plus", name: "Star Plus", tag: "Family drama episodes" },
  { slug: "colors-tv", name: "Colors TV", tag: "Drama and reality hits" },
  { slug: "zee-tv", name: "Zee TV", tag: "Daily Desi serial updates" },
  { slug: "sony-tv", name: "Sony TV", tag: "Fiction and event shows" },
  { slug: "sab-tv", name: "SAB TV", tag: "Comedy and light drama" },
  { slug: "and-tv", name: "And TV", tag: "Entertainment and serials" },
  { slug: "dangal-tv", name: "Dangal TV", tag: "Featured Desi Tashan picks" },
  { slug: "bigg-boss-20", name: "Bigg Boss 20", tag: "Reality show episodes" },
];
const DASH_PAGE_SIZE = 32; // the dashboard's "Latest Desi Tashan Episodes" grid renders 32 cards
const DASH_SPOTLIGHT_MAX = 12; // "New Episode Spotlight" highlights ~10-12 cards

/** The dashboard's episode grid also ships as a JSON-LD ItemList — cheaper than scraping cards. */
function parseJsonLdEpisodes(html) {
  const out = [];
  const blocks = String(html || "").match(/<script[^>]*type="application\/ld\+json"[^>]*>[\s\S]*?<\/script>/gi) || [];
  for (const block of blocks) {
    const body = block.replace(/^[^>]*>/, "").replace(/<\/script>$/i, "");
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      continue;
    }
    const nodes = Array.isArray(data) ? data : data && data["@graph"] ? data["@graph"] : [data];
    for (const node of nodes) {
      if (!node || node["@type"] !== "ItemList" || !Array.isArray(node.itemListElement)) continue;
      for (const entry of node.itemListElement) {
        const item = entry && entry.item ? entry.item : entry;
        if (!item) continue;
        const hit = String(item.url || "").match(/\/([a-z0-9-]+)\/([a-f0-9]{16})\/?$/i);
        if (!hit) continue;
        let image = item.image;
        if (Array.isArray(image)) image = image[0];
        if (image && typeof image === "object") image = image.url;
        out.push({ slug: hit[1], pid: hit[2].toLowerCase(), title: item.name || "", image: image || "", released: "" });
      }
    }
  }
  return out;
}

/**
 * Map an episode card (or a dashboard JSON-LD entry) to the serial it belongs
 * to, by matching the episode slug against the index (longest show slug wins).
 */
function matchShowSlug(card, index) {
  if (!card) return "";
  if (card.showKey) {
    const slug = String(card.showKey).split("/").pop();
    if (index.has(slug)) return slug;
  }
  const seg = String(card.slug || "");
  let best = "";
  for (const slug of index.keys()) {
    if ((seg === slug || seg.startsWith(`${slug}-`)) && slug.length > best.length) best = slug;
  }
  return best;
}

/** "Latest Desi Tashan Episodes" — the dashboard's main episode grid. */
/** "Latest Desi Tashan Episodes" — every serial, newest episode first. */
async function dashLatestCatalog(skip, origin) {
  const shows = (await indexShows(origin)).sort(byNewest);
  return showRowCatalog(shows, skip, "", origin);
}

/** "New Episode Spotlight" — the highlighted row at the top of the dashboard. */
/**
 * "New Episode Spotlight" — the serials behind the homepage's spotlight cards,
 * in the order the dashboard shows them, as complete series entries.
 */
async function dashSpotlightCatalog(origin) {
  const index = (await dtsIndex(origin)).shows;
  const html = await fetchText(`${SITE}/`, 5 * 60 * 1000, SITE_REF);
  const rows = [];
  const seen = new Set();
  for (const card of [...parseJsonLdEpisodes(html), ...parseCards(html)]) {
    const slug = matchShowSlug(card, index);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    rows.push(index.get(slug));
    if (rows.length >= DASH_SPOTLIGHT_MAX) break;
  }
  if (!rows.length) rows.push(...(await indexShows(origin)).sort(byNewest).slice(0, DASH_SPOTLIGHT_MAX));
  return rows.map((show) => indexCard(show, ""));
}

/** One show of a channel as a series card (shared by the channel rows + search). */
/**
 * One serial as a series card. Everything comes from the index, so a row of 32
 * cards costs a single request; only a serial missing from the snapshot (brand
 * new show) falls back to its hub page.
 */
async function showCard(slug, channel, label, origin) {
  const index = (await dtsIndex(origin)).shows;
  const show = index.get(slug);
  return show ? indexCard(show, label) : hubCard(slug, channel, label);
}

/** One page of a catalog row built from show entries. */
async function showRowCatalog(rows, skip, label, origin) {
  const page = (rows || []).slice(skip, skip + PAGE_SIZE);
  const index = (await dtsIndex(origin)).shows;
  const cards = [];
  for (const row of page) {
    const show = index.get(row.slug);
    cards.push(show ? indexCard(show, label) : await hubCard(row.slug, row.channel, label));
  }
  return cards;
}

/** Series card for a serial missing from the snapshot (fetches its hub page). */
async function hubCard(slug, channel, label) {
  const parsed = parseShowHub(await fetchShowHub(slug, channel), slug);
  const ch = channel || parsed.channel || "";
  const name = parsed.name || prettify(slug);
  const shownAs = label || channelLabel(ch) || "Desi Tashan";
  return {
    id: showId(slug, ch),
    type: "series",
    name,
    poster: parsed.poster || FALLBACK_POSTER,
    posterShape: "landscape",
    description: `${shownAs} · ${name} full episodes`,
    releaseInfo: shownAs,
  };
}

/** "Anupama 12th November 2026 Full Episode | Star Plus" -> "Anupama" */
function dashShowName(title) {
  return cleanEpisodeTitle(title)
    .replace(/\b\d{1,2}(?:st|nd|rd|th)?\s+[a-z]{3,9}\.?,?\s*\d{4}\b/i, "")
    .replace(/\s+/g, " ")
    .replace(/[\s\u2013\u2014:·,.-]+$/, "")
    .trim();
}

function dashShowSlug(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Shows of one "Watch by Channel" tile: sitemap membership first, then the show
 *  names the tile's own page lists (covers tiles the category sitemap never nests,
 *  e.g. Dangal TV or the Bigg Boss 20 hub). */
/**
 * Serials carried by a channel. The snapshot knows every serial that ever aired
 * on a channel; tiles that are really single shows (e.g. Bigg Boss 20) have no
 * episodes of their own, so they fall back to the tile page.
 */
async function dashTileShows(tileSlug, origin) {
  const index = (await dtsIndex(origin)).shows;
  const found = channelIndexShows(index, tileSlug);
  if (found.length) return found;
  return legacyTileShows(tileSlug, index);
}

/** Tile page fallback: the shows its spotlight cards point at. */
async function legacyTileShows(tileSlug, index) {
  const out = new Map();
  const html = await fetchText(`${SITE}/category/${tileSlug}/`, 30 * 60 * 1000, SITE_REF);
  for (const card of parseCards(html)) {
    const slug = matchShowSlug(card, index) || segShowSlug(card.slug);
    if (!slug) continue;
    out.set(slug, index.get(slug) || { slug, channel: tileSlug, name: prettify(slug) });
  }
  return [...out.values()];
}

/** "Watch by Channel" tile -> that channel's serials (shows), sorted by show name. */
/** One dashboard channel tile: its serials as series cards. */
async function dashChannelCatalog(channelSlug, skip, search, origin) {
  const tile = DASH_TILES.find((t) => t.slug === channelSlug);
  const label = tile ? tile.name : channelLabel(channelSlug) || prettify(channelSlug);
  let rows = await dashTileShows(channelSlug, origin);
  const q = String(search || "").trim().toLowerCase();
  if (q) {
    rows = rows.filter((row) => `${row.slug} ${row.name || ""}`.toLowerCase().includes(q));
  }
  return showRowCatalog(rows, skip, label, origin);
}

/** Search box -> serials across every channel of the dashboard. */
/** Search every serial the site carries (name, slug or channel). */
async function dashSearchCatalog(search, skip, origin) {
  const index = (await dtsIndex(origin)).shows;
  return showRowCatalog(searchIndexShows(index, search), skip, "", origin);
}

/**
 * Rows of the /dss add-on. Series only — desitashan.su carries serials, there is
 * no film section on the site, so nothing is tagged as a movie.
 */
const DSS_TILE_CHANNEL_SLUGS = DASH_TILES.map((tile) => tile.slug);
const DSS_EXTRA_CHANNELS = CHANNELS.filter((c) => DSS_TILE_CHANNEL_SLUGS.indexOf(c.slug) < 0);

export function dssManifest(origin) {
  const catalogs = [
    { type: "series", id: "dss:spotlight", name: "New Episode Spotlight" },
    { type: "series", id: "dss:latest", name: "Latest Desi Tashan Episodes" },
  ];
  for (const tile of DASH_TILES) {
    catalogs.push({ type: "series", id: "dss:ch:" + tile.slug, name: tile.name });
  }
  for (const channel of DSS_EXTRA_CHANNELS) {
    catalogs.push({ type: "series", id: "dss:ch:" + channel.slug, name: channel.name });
  }
  catalogs.push({ type: "series", id: "dss:all", name: "All Serials (A–Z)" });
  catalogs.push({
    type: "series",
    id: "dss:search",
    name: "Serials · Search",
    extra: [{ name: "search", isRequired: true }],
  });
  return {
    id: "org.pvrplay.desitashan.series",
    version: SERIES_VERSION,
    name: "Desi Tashan — Serials",
    description:
      "Every serial on desitashan.su: 200+ shows, complete episode lists, newest first, no ads. " +
      "All rows are series — the source has no films.",
    resources: ["catalog", "meta", "stream"],
    types: ["series", "movie"],
    idPrefixes: ["dts:"],
    catalogs: catalogs,
  };
}


/** Rows of the /dts add-on — serials every step of the way, no movie rows. */
export function dtsManifest(origin) {
  const catalogs = [{ type: "series", id: "dts:latest", name: "Latest Serials" }];
  for (const channel of CHANNELS) {
    catalogs.push({ type: "series", id: "dts:ch:" + channel.slug, name: channel.name });
  }
  catalogs.push({ type: "series", id: "dts:shows", name: "All Serials (A–Z)" });
  catalogs.push({
    type: "series",
    id: "dts:search",
    name: "Serials · Search",
    extra: [{ name: "search", isRequired: true }],
  });
  return {
    id: "org.pvrplay.desitashan",
    version: ADDON_VERSION,
    name: "Desi Tashan",
    description:
      "Serial episodes from desitashan.su — 200+ shows with their full episode lists, newest first, no ads.",
    resources: ["catalog", "meta", "stream"],
    types: ["series", "movie"],
    idPrefixes: ["dts:"],
    catalogs: catalogs,
  };
}

async function handleCatalog(type, id, url, variant = "dts", origin = "") {
  const skip = Math.max(0, Number(url.searchParams.get("skip")) || 0);
  const search = (url.searchParams.get("search") || "").trim();
  let metas = [];
  try {
    metas = await catalogCards(id, { search, skip, variant, origin });
  } catch {
    metas = [];
  }
  // remember slug<->pid so a bare-id stream request can still be served
  for (const m of metas) {
    const e = String(m.id).match(/^dts:ep:(.+)_([a-f0-9]{16})$/);
    if (e) memSet("pid:" + e[2], e[1], 6 * 60 * 60 * 1000);
  }
  const noCache = id.includes("search");
  return json({ metas }, noCache ? 60 : 600);
}

/**
 * Catalog id -> cards. Every row is a SERIES row: desitashan.su only carries
 * serials (per-episode posts of TV serials, including its Netflix/Hotstar/MX
 * Player sections) and has no films at all, so nothing is tagged as a movie.
 */
async function catalogCards(id, { search, skip, variant, origin }) {
  const key = String(id).replace(/^dss:/, "").replace(/^dts:/, "");
  const isDss = String(id).startsWith("dss:");
  if (key === "spotlight") return dashSpotlightCatalog(origin);
  if (key === "latest" || key === "updates") {
    return isDss ? dashLatestCatalog(skip, origin) : latestCatalog(skip, origin);
  }
  if (key === "all" || key === "shows") return showsCatalog(skip, origin);
  if (key === "by-channel") return showsByChannelCatalog(skip, origin);
  if (key === "search") {
    // `search` is declared required, but a bare hit on the row should still show
    // something rather than an empty screen.
    if (!search) return showsCatalog(skip, origin);
    return isDss ? dashSearchCatalog(search, skip, origin) : searchCatalog(search, skip, origin);
  }
  if (key.startsWith("ch:")) {
    const channel = key.slice(3);
    return isDss
      ? dashChannelCatalog(channel, skip, search, origin)
      : channelCatalog(channel, skip, origin);
  }
  return [];
}

async function handleMeta(type, id, origin) {
  try {
    const meta = String(id).startsWith("dts:show:") ? await showMeta(id, origin) : await episodeMeta(id);
    if (meta) return json({ meta }, 600);
  } catch {
    /* fall through */
  }
  return json({ meta: null }, 60);
}

async function handleStream(type, id, origin) {
  let streams = [];
  try {
    const path = await pathForStreamId(id, origin);
    if (path) {
      const hit = await episodeToken(path);
      const page = hit ? hit.page : null;
      let label = page && page.name ? page.name : prettify(String(path).split("/")[1] || "");
      const file = hit ? await playFile(hit.token) : null;
      if (file && file.title) label = file.title;
      streams = [
        {
          name: "DesiTashan",
          title: label + "\nAuto · MP4 · ad-free",
          url: origin + "/dts/p?u=" + b64urlEncode(path),
          behaviorHints: { filename: label.replace(/[^\w\s.-]/g, "").trim() + ".mp4" },
        },
      ];
    }
  } catch {
    streams = [];
  }
  return json({ streams }, 300);
}

async function handleRelay(url) {
  let path = "";
  try {
    path = b64urlDecode(url.searchParams.get("u") || "");
  } catch {
    path = "";
  }
  if (!/^\/[a-z0-9][a-z0-9-]*\/[a-f0-9]{16}\/$/.test(path)) {
    return json({ err: "bad u" }, 60, 400);
  }
  try {
    const hit = await episodeToken(path);
    if (!hit) return json({ err: "no token" }, 60, 502);
    const file = await playFile(hit.token);
    if (!file) return json({ err: "no source" }, 60, 502);
    const loc = await playLocation(file.file);
    if (!loc) return json({ err: "no location" }, 30, 502);
    return new Response(null, {
      status: 302,
      headers: { location: loc, "cache-control": "no-store", "access-control-allow-origin": "*" },
    });
  } catch (err) {
    return json({ err: String(err && err.message ? err.message : err) }, 30, 502);
  }
}

/**
 * Router for /dts/*. Returns a Response, or null when the path is not ours.
 */
export async function handleDesiTashan(request, url, origin) {
  return routeAddon(url, origin, "/dts", "dts");
}

/** Series-only add-on: same module, separate manifest + catalogs at /dss. */
export async function handleDesiSeries(request, url, origin) {
  return routeAddon(url, origin, "/dss", "dss");
}

async function routeAddon(url, origin, mount, variant) {
  const path = url.pathname;
  if (path !== mount && path.indexOf(mount + "/") !== 0) return null;
  const rest = path.slice(mount.length) || "/";

  if (rest === "/" || rest === "/manifest.json") {
    return json(variant === "dss" ? dssManifest(origin) : dtsManifest(origin), 600);
  }
  if (rest === "/p") return handleRelay(url);

  let m = rest.match(/^\/catalog\/([^/]+)\/(.+)\.json$/);
  if (m) return handleCatalog(m[1], decodeURIComponent(m[2]), url, variant, origin);

  m = rest.match(/^\/meta\/([^/]+)\/(.+)\.json$/);
  if (m) return handleMeta(m[1], decodeURIComponent(m[2]), origin);

  m = rest.match(/^\/stream\/([^/]+)\/(.+)\.json$/);
  if (m) return handleStream(m[1], decodeURIComponent(m[2]), origin);

  return null;
}

export const _test = {
  text,
  prettify,
  b64urlEncode,
  b64urlDecode,
  parseFeed,
  parseCards,
  parseCategorySitemap,
  parseShowHub,
  parseEpisodePage,
  episodePath,
  episodeId,
  showId,
  dtsManifest,
  dssManifest,
  channelLabel,
  titleDate,
  titleChannel,
  pathForStreamId,
  CHANNELS,
  DASH_TILES,
  parseJsonLdEpisodes,
  dashShowName,
  dashShowSlug,
  seriesShowKeys,
  indexFromShows,
  indexEntry,
  indexCard,
  segInfo,
  segShowSlug,
  prettyDate,
  channelIndexShows,
  searchIndexShows,
  matchShowSlug,
  parseEpisodesPayload,
  byNewest,
  catalogCards,
  dashSpotlightCatalog,
  dashLatestCatalog,
  dashChannelCatalog,
  dashSearchCatalog,
};
