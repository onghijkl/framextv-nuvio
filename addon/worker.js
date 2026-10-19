/**
 * PvrPlay Catalogs — a Stremio-protocol addon for Nuvio
 *
 * Serves home-screen catalog rows sourced from PvrPlay's own lists, so every
 * title shown is one PvrPlay actually carries.
 *
 * Deploy: Cloudflare Workers (free tier). See addon/README.md.
 *
 * Endpoints
 *   GET /manifest.json
 *   GET /catalog/<type>/<id>.json
 *   GET /catalog/<type>/<id>/<extra>.json      (extra params ignored)
 *
 * How it gets data
 *   PvrPlay is a Next.js app; its lists are server-rendered into the React
 *   Server Component payload (`self.__next_f.push(...)`). That payload embeds
 *   complete TMDB objects, so no API key or scraping of markup is needed —
 *   just locate the item array and read it.
 *
 * Item ids are emitted as `tmdb:<id>`. Nuvio strips that prefix before calling
 * local scrapers (PluginContentIds.kt), so a row tapped here resolves straight
 * into the frameXTV / PvrPlay stream providers.
 */

const PVR_BASE =
  "https://dbhnmkjasgbvsdkjbskkvnskjbfckldsnckjbckjnxkjcsknxjvkjxnvcxknvku.pvrplay.fun";

const IMG = "https://image.tmdb.org/t/p/w500";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * Catalog definitions.
 *   path  — PvrPlay page to read
 *   key   — array name inside the RSC payload
 *   types — which Stremio types this row serves
 */
const CATALOGS = [
  { id: "pvr-trending", path: "/trending", key: "initialItems", name: "PvrPlay Trending", types: ["movie", "series"] },
  { id: "pvr-movies", path: "/movies", key: "initialMovies", name: "PvrPlay Movies", types: ["movie"] },
  { id: "pvr-tvshows", path: "/tv-shows", key: "initialShows", name: "PvrPlay TV Shows", types: ["series"] },
  { id: "pvr-netflix", path: "/platform/8", key: "initialItems", name: "PvrPlay Netflix", types: ["movie"] },
  { id: "pvr-prime", path: "/platform/9", key: "initialItems", name: "PvrPlay Prime Video", types: ["movie"] },
  { id: "pvr-disney", path: "/platform/337", key: "initialItems", name: "PvrPlay Disney+", types: ["movie"] },
  { id: "pvr-appletv", path: "/platform/350", key: "initialItems", name: "PvrPlay Apple TV+", types: ["movie"] },
  { id: "pvr-hulu", path: "/platform/15", key: "initialItems", name: "PvrPlay Hulu", types: ["movie"] },
  { id: "pvr-max", path: "/platform/1899", key: "initialItems", name: "PvrPlay Max", types: ["movie"] },
  { id: "pvr-paramount", path: "/platform/531", key: "initialItems", name: "PvrPlay Paramount+", types: ["movie"] }
];

/* ------------------------------------------------------------------ parse */

/** Concatenate and unescape the RSC payload chunks. */
function rscPayload(html) {
  const re = /self\.__next_f\.push\(\[1,"([\s\S]*?)"\]\)/g;
  let out = "";
  let m;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1];
    // The chunk is a JS string literal, so JSON-parsing it wrapped in quotes
    // performs the unescaping. Do NOT pre-escape quotes here: adding
    // backslashes before already-valid characters produces invalid JSON and
    // silently falls through to the raw (still-escaped) text.
    try {
      out += JSON.parse('"' + raw + '"');
    } catch (e) {
      out += raw;
    }
  }
  return out;
}

/** Pull one balanced JSON array out of the payload by key name. */
function extractArray(text, key) {
  const at = text.indexOf('"' + key + '":[');
  if (at < 0) return null;
  const start = text.indexOf("[", at);

  let depth = 0;
  let inStr = false;
  let esc = false;

  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch (e) {
          return null;
        }
      }
    }
  }
  return null;
}

/** A TMDB object is a series when it has a name (not title). */
function isSeries(o) {
  if (o.media_type === "tv") return true;
  if (o.media_type === "movie") return false;
  return !o.title && !!o.name;
}

/** TMDB object -> Stremio meta. */
function toMeta(o) {
  const series = isSeries(o);
  const date = series ? o.first_air_date : o.release_date;
  const meta = {
    id: "tmdb:" + o.id,
    type: series ? "series" : "movie",
    name: o.title || o.name || "Unknown"
  };
  if (o.poster_path) meta.poster = IMG + o.poster_path;
  if (o.backdrop_path) meta.background = "https://image.tmdb.org/t/p/w1280" + o.backdrop_path;
  if (date) meta.releaseInfo = String(date).slice(0, 4);
  if (o.vote_average) meta.imdbRating = String(Math.round(o.vote_average * 10) / 10);
  if (o.overview) meta.description = o.overview;
  return meta;
}

/* ---------------------------------------------------------------- handler */

function cors(body, status) {
  return new Response(body, {
    status: status || 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Cache-Control": "public, max-age=600"
    }
  });
}

function manifest() {
  const catalogs = [];
  for (const c of CATALOGS) {
    for (const t of c.types) {
      catalogs.push({ type: t, id: c.id, name: c.name });
    }
  }
  return {
    id: "org.ong.pvrplay.catalogs",
    version: "1.0.0",
    name: "PvrPlay Catalogs",
    description:
      "Home-screen rows from PvrPlay. Every title listed is one PvrPlay carries.",
    resources: [{ name: "catalog", types: ["movie", "series"] }],
    types: ["movie", "series"],
    idPrefixes: ["tmdb:"],
    catalogs: catalogs
  };
}

async function catalog(type, id) {
  const def = CATALOGS.find(function (c) {
    return c.id === id;
  });
  if (!def) return { metas: [] };

  const res = await fetch(PVR_BASE + def.path, {
    headers: { "User-Agent": UA, Accept: "text/html" },
    cf: { cacheTtl: 600, cacheEverything: true }
  });
  if (!res.ok) return { metas: [] };

  const html = await res.text();
  const items = extractArray(rscPayload(html), def.key);
  if (!items) return { metas: [] };

  const metas = [];
  for (const o of items) {
    if (!o || !o.id) continue;
    const series = isSeries(o);
    // Only surface rows matching the type the client asked for.
    if (type === "series" && !series) continue;
    if (type === "movie" && series) continue;
    metas.push(toMeta(o));
  }
  return { metas: metas };
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") {
      return cors("", 204);
    }

    try {
      if (path === "/" || path === "/manifest.json") {
        return cors(JSON.stringify(manifest()));
      }

      // /catalog/<type>/<id>.json  or  /catalog/<type>/<id>/<extra>.json
      const m = path.match(/^\/catalog\/([^/]+)\/([^/]+?)(?:\/[^/]*)?\.json$/);
      if (m) {
        const type = decodeURIComponent(m[1]);
        const id = decodeURIComponent(m[2]);
        const data = await catalog(type, id);
        return cors(JSON.stringify(data));
      }

      return cors(JSON.stringify({ error: "not found", path: path }), 404);
    } catch (e) {
      return cors(JSON.stringify({ error: String(e && e.message ? e.message : e) }), 500);
    }
  }
};
