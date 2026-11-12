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

const ADDON_VERSION = "1.0.0";

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
  { slug: "and-tv", name: "& TV" },
  { slug: "star-bharat", name: "Star Bharat" },
  { slug: "dangal-tv", name: "Dangal TV" },
  { slug: "mtv", name: "MTV" },
  { slug: "sun-neo", name: "Sun Neo" },
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
function parseShowHub(html) {
  const h = String(html || "");
  const og = h.match(/property="og:image"[^>]*content="([^"]+)"/);
  const img = h.match(/<img[^>]+src="(\/media-cache\/[^"]+)"/);
  const title = h.match(/<title>([^<]*)<\/title>/);
  const h1 = h.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
  const channel = h.match(/href="\/category\/([a-z0-9][a-z0-9-]*)\/"/);
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

async function episodeMeta(id) {
  const m = String(id).match(/^dts:ep:(.+)_([a-f0-9]{16})$/);
  if (!m) return null;
  const slug = m[1];
  const pid = m[2];
  const html = await fetchText(SITE + episodePath(slug, pid), 30 * 60 * 1000, SITE_REF);
  const page = parseEpisodePage(html);
  const name = page.name || prettify(slug);
  return {
    id,
    type: "movie",
    name,
    poster: page.image || FALLBACK_POSTER,
    posterShape: "landscape",
    description: page.description || name,
    behaviorHints: { defaultVideoId: id },
  };
}

/** slug -> owning channel, derived from the nested /category/<ch>/<show>/ sitemap. */
async function showChannelMap() {
  const xml = (await fetchText(SITE + "/category-sitemap.xml", 6 * 60 * 60 * 1000, SITE_REF)) || "";
  const map = {};
  const re = /<loc>[^<]*\/category\/([a-z0-9][a-z0-9-]+)\/([a-z0-9][a-z0-9-]+)\/<\/loc>/g;
  let m;
  while ((m = re.exec(xml))) if (!map[m[2]]) map[m[2]] = m[1];
  return map;
}

/** Show hub + its channel listing -> series meta with videos[]. */
async function showMeta(id) {
  const raw = String(id).replace(/^dts:show:/, "");
  const parts = raw.split("~");
  const slug = parts.length > 1 ? parts[1] : parts[0];
  let channel = parts.length > 1 ? parts[0] : "";
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) return null;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(channel)) channel = "";

  const map = await showChannelMap();
  // The sitemap knows which channel hosts a show; the id is just a hint.
  const resolved = map[slug] || channel;
  const cands = [resolved, channel, ""].filter((c, i, a) => c !== undefined && a.indexOf(c) === i);

  let hubHtml = "";
  let hub = { name: "", poster: "", channel: "" };
  for (const ch of cands) {
    const url = SITE + "/category/" + (ch ? ch + "/" : "") + slug + "/";
    const html = await fetchText(url, 6 * 60 * 60 * 1000, SITE_REF);
    if (!html) continue;
    const parsed = parseShowHub(html);
    if (!hub.poster && parsed.poster) {
      hubHtml = html;
      hub = parsed;
      channel = parseShowHub(html).channel || ch || "";
      if (hub.name) break;
    }
  }
  if (!hubHtml) return null;
  const listingUrl = channel
    ? SITE + "/category/" + channel + "/" + slug + "/"
    : SITE + "/category/" + slug + "/";
  const listHtml = await fetchText(listingUrl, 30 * 60 * 1000, SITE_REF);
  let eps = parseCards(listHtml);
  if (!eps.length) eps = parseCards(hubHtml);

  const videos = eps.map((e, i) => ({
    id: e.id,
    title: e.title,
    season: 1,
    episode: e.episode || eps.length - i,
    thumbnail: e.image || "",
    released: e.released || undefined,
  }));

  return {
    id: showId(slug, channel),
    type: "series",
    name: hub.name || prettify(slug),
    poster: hub.poster || (eps[0] && eps[0].image) || FALLBACK_POSTER,
    posterShape: "landscape",
    description:
      (hub.name || prettify(slug)) + (channel ? " — " + (CHANNEL_NAMES[channel] || channel) : "") +
      ", latest episodes.",
    videos,
  };
}

/* -------------------------------------------------------------- catalogs */

async function latestCatalog(skip) {
  const url = SITE + "/sidebar-feed.php?limit=" + PAGE_SIZE + "&offset=" + skip;
  let items = [];
  const body = await fetchText(url, 5 * 60 * 1000, SITE_REF);
  if (body) {
    try {
      const data = JSON.parse(body);
      items = Array.isArray(data.latest) ? data.latest : [];
    } catch {
      items = [];
    }
  }

  if (!items.length && skip === 0) {
    const feed = parseFeed(await fetchText(SITE + "/feed.xml", 5 * 60 * 1000, SITE_REF));
    return feed.slice(0, 50).map((e) =>
      metaCard(e.slug, e.pid, e.title, e.image, e.released)
    );
  }

  return items
    .map((it) => {
      const m = String(it.url || "").match(/\/([a-z0-9][a-z0-9-]*)\/([a-f0-9]{16})\/?$/);
      if (!m) return null;
      return metaCard(m[1], m[2], text(it.title) || prettify(m[1]), abs(it.image || ""), "");
    })
    .filter(Boolean);
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

async function channelCatalog(slug, skip) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) return [];
  const page = Math.floor(skip / PAGE_SIZE) + 1;
  const url = page === 1 ? SITE + "/category/" + slug + "/" : SITE + "/category/" + slug + "/page/" + page + "/";
  const html = await fetchText(url, 10 * 60 * 1000, SITE_REF);
  return parseCards(html).map((e) => metaCard(e.slug, e.pid, e.title, e.image, e.released));
}

async function searchCatalog(query, skip) {
  const q = String(query || "").trim();
  if (!q) return [];
  const page = Math.floor(skip / PAGE_SIZE) + 1;
  const base = SITE + "/search/" + encodeURIComponent(q).replace(/%20/g, "+");
  const url = page === 1 ? base : base + "/page/" + page + "/";
  const html = await fetchText(url, 5 * 60 * 1000, SITE_REF);
  return parseCards(html).map((e) => metaCard(e.slug, e.pid, e.title, e.image, e.released));
}

/**
 * Shows catalog: every flat /category/<slug>/ in the sitemap is a show hub.
 * Posters come from the hub page (og:image); the hub also names its channel,
 * which showMeta() then reuses for the full episode list.
 */
async function showsCatalog(skip) {
  const xml = await fetchText(SITE + "/category-sitemap.xml", 12 * 60 * 60 * 1000, SITE_REF);
  const slugs = parseCategorySitemap(xml);
  const page = slugs.slice(skip, skip + PAGE_SIZE);
  if (!page.length) return [];

  const enriched = await Promise.all(
    page.map(async (key) => {
      const channel = key.includes("~") ? key.split("~")[0] : "";
      const slug = key.includes("~") ? key.split("~")[1] : key;
      const hubHtml = await fetchText(
        SITE + "/category/" + (channel ? channel + "/" : "") + slug + "/",
        6 * 60 * 60 * 1000,
        SITE_REF
      );
      const hub = hubHtml ? parseShowHub(hubHtml) : { name: "", poster: "", channel: "" };
      return {
        id: showId(slug, channel),
        type: "series",
        name: hub.name || prettify(slug),
        poster: hub.poster || FALLBACK_POSTER,
        posterShape: "landscape",
        description: channel ? CHANNEL_NAMES[channel] || prettify(channel) : undefined,
      };
    })
  );
  return enriched;
}

/* ---------------------------------------------------------------- streams */

/** Resolve a playable episode path out of any id form a client may send. */
async function pathForStreamId(id) {
  const raw = String(id || "");

  // dts:ep:<slug>_<pid>
  let m = raw.match(/dts:ep:(.+)_([a-f0-9]{16})$/);
  if (m) return episodePath(m[1], m[2]);

  // dts:show:<slug>[:<season>:<episode>]
  m = raw.match(/dts:show:([a-z0-9][a-z0-9-]*)(?::(.*))?$/);
  if (m) {
    const slug = m[1];
    const sel = (m[2] || "").split(":").filter(Boolean);
    const pid = sel.find((s) => HEX_ID.test(s));
    if (pid) return episodePath(pid && slug, pid);

    const hubHtml = await fetchText(SITE + "/category/" + slug + "/", 6 * 60 * 60 * 1000, SITE_REF);
    const channel = parseShowHub(hubHtml).channel;
    const listUrl = channel
      ? SITE + "/category/" + channel + "/" + slug + "/"
      : SITE + "/category/" + slug + "/";
    const eps = parseCards(await fetchText(listUrl, 30 * 60 * 1000, SITE_REF));
    if (!eps.length) return "";
    const nums = sel.map(Number).filter((n) => Number.isFinite(n) && n > 0);
    const want = nums.length ? nums[nums.length - 1] : 1;
    const byNumber = eps.find((e) => e.episode === want);
    if (byNumber) return episodePath(byNumber.slug, byNumber.pid);
    const byIndex = eps[want - 1] || eps[0];
    return episodePath(byIndex.slug, byIndex.pid);
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

export function dtsManifest(origin) {
  const catalogs = [
    { type: "movie", id: "dts:latest", name: "Desi Tashan — Latest", extra: [{ name: "skip", isRequired: false }] },
  ];
  for (const ch of CHANNELS) {
    catalogs.push({
      type: "movie",
      id: "dts:ch:" + ch.slug,
      name: "Desi Tashan — " + ch.name,
      extra: [{ name: "skip", isRequired: false }],
    });
  }
  catalogs.push({
    type: "series",
    id: "dts:shows",
    name: "Desi Tashan — Shows",
    extra: [{ name: "skip", isRequired: false }, { name: "search", isRequired: false }],
  });
  catalogs.push({
    type: "search",
    id: "dts:search",
    name: "Desi Tashan — Search",
    extra: [{ name: "search", isRequired: true }, { name: "skip", isRequired: false }],
  });

  return {
    id: "org.pvrplay.desitashan",
    version: ADDON_VERSION,
    name: "Desi Tashan",
    description:
      "Latest Desi serial episodes from desitashan.su — Anupama, Vasudha, Pushpa Impossible, Dilon Ki Ram Leela and more. Direct MP4, no ads.",
    resources: ["catalog", "meta", "stream"],
    types: ["movie", "series"],
    idPrefixes: ["dts:"],
    catalogs: catalogs.map((c) => (c.type === "search" ? Object.assign({}, c, { type: "movie" }) : c)),
    behaviorHints: { configurable: false },
  };
}

async function handleCatalog(type, id, url) {
  const skip = Math.max(0, Number(url.searchParams.get("skip")) || 0);
  const search = (url.searchParams.get("search") || "").trim();
  let metas = [];

  try {
    if (id === "dts:latest") metas = await latestCatalog(skip);
    else if (id.startsWith("dts:ch:")) metas = await channelCatalog(id.slice(7), skip);
    else if (id === "dts:shows") metas = await showsCatalog(skip);
    else if (id.startsWith("dts:search")) metas = await searchCatalog(search, skip);
  } catch {
    metas = [];
  }

  // remember slug<->pid so a bare-id stream request can still be served
  for (const m of metas) {
    const e = String(m.id).match(/^dts:ep:(.+)_([a-f0-9]{16})$/);
    if (e) memSet("pid:" + e[2], e[1], 6 * 60 * 60 * 1000);
  }

  return json({ metas }, id.startsWith("dts:search") ? 60 : 600);
}

async function handleMeta(type, id) {
  try {
    const meta = id.startsWith("dts:show:") ? await showMeta(id) : await episodeMeta(id);
    if (meta) return json({ meta }, 600);
  } catch {
    /* fall through */
  }
  return json({ meta: null }, 60);
}

async function handleStream(type, id, origin) {
  let streams = [];
  try {
    const path = await pathForStreamId(id);
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
  const path = url.pathname;
  if (path !== "/dts" && !path.startsWith("/dts/")) return null;

  if (path === "/dts" || path === "/dts/" || path === "/dts/manifest.json") {
    return json(dtsManifest(origin), 600);
  }
  if (path === "/dts/p") return handleRelay(url);

  let m;
  if ((m = path.match(/^\/dts\/catalog\/([^/]+)\/(.+)\.json$/))) {
    return handleCatalog(m[1], decodeURIComponent(m[2]), url);
  }
  if ((m = path.match(/^\/dts\/meta\/([^/]+)\/(.+)\.json$/))) {
    return handleMeta(m[1], decodeURIComponent(m[2]));
  }
  if ((m = path.match(/^\/dts\/stream\/([^/]+)\/(.+)\.json$/))) {
    return handleStream(m[1], decodeURIComponent(m[2]), origin);
  }
  return json({ err: "not found" }, 60, 404);
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
  pathForStreamId,
  CHANNELS,
};
