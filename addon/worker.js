// The providers are plain scripts whose footers expose a namespaced global,
// so they can be imported here and used as Stremio stream resolvers.
import "../providers/framextv.js";
import "../providers/pvrplay.js";
import "../providers/vidlink.js";

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
 *
 *   src   — "home" (PvrPlay home screen), "pvrplay" (a page), or "tmdb"
 *   row   — exact row title on the home screen   (home only)
 *   path  — PvrPlay page to read                 (pvrplay only)
 *   key   — array name in the RSC payload        (pvrplay only)
 *   query — TMDB discover params                 (tmdb only)
 *   types — which Stremio types this row serves
 *
 * The home rows mirror PvrPlay's own home screen exactly: its homepage payload
 * carries every row as {"items":[...TMDB objects...],"title":"Row Name"}, so a
 * single fetch yields all of them.
 */
const CATALOGS = [
  // --- PvrPlay home screen, row for row ---
  { id: "home-coming-soon", src: "home", row: "Coming Soon", name: "Coming Soon", types: ["movie"] },
  { id: "home-in-theatres", src: "home", row: "In Theatres", name: "In Theatres", types: ["movie"] },
  { id: "home-netflix", src: "home", row: "Trending on Netflix", name: "Trending on Netflix", types: ["movie"] },
  { id: "home-hotstar", src: "home", row: "Popular on Hotstar", name: "Popular on Hotstar", types: ["series"] },
  { id: "home-prime", src: "home", row: "Popular on Prime Video", name: "Popular on Prime Video", types: ["movie", "series"] },
  { id: "home-trending", src: "home", row: "Trending Now", name: "Trending Now", types: ["movie", "series"] },
  { id: "home-new", src: "home", row: "New Releases", name: "New Releases", types: ["movie", "series"] },

  // --- browse pages ---
  { id: "pvr-movies", path: "/movies", key: "initialMovies", name: "PvrPlay Movies", types: ["movie"], search: true },
  { id: "pvr-tvshows", path: "/tv-shows", key: "initialShows", name: "PvrPlay TV Shows", types: ["series"], search: true },
  { id: "pvr-tamil", path: "/tamil-blasters", key: "initialMovies", name: "Tamil / Telugu", types: ["movie"] },
  { id: "pvr-shudder", path: "/platform/99", key: "initialItems", name: "PvrPlay Shudder", types: ["movie"] },

  // --- Hindi rows. PvrPlay exposes no Hindi listing and its genre pages are
  // client-rendered, so these come from TMDB discover instead. Providers carry
  // Hindi audio so most resolve, but unlike the PvrPlay rows they are not
  // guaranteed playable.
  { id: "hi-movies", src: "tmdb", query: { with_original_language: "hi", sort_by: "popularity.desc" }, name: "Hindi Movies", types: ["movie"] },
  { id: "hi-movies-top", src: "tmdb", query: { with_original_language: "hi", sort_by: "vote_count.desc" }, name: "Hindi Movies \u2022 Most Voted", types: ["movie"] },
  { id: "hi-tvshows", src: "tmdb", query: { with_original_language: "hi", sort_by: "popularity.desc" }, name: "Hindi TV Shows", types: ["series"] }
];

/** Public TMDB key — the same one the source sites embed in their clients. */
const TMDB_API_KEY = "1865f43a0549ca50d341dd9ab8b29f49";

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

/* -------------------------------------------------------- playlist filter */

/**
 * Cap and codec filter for HLS master playlists.
 *
 * Why this exists: upstream ladders advertise a 4K HEVC (hvc1) rendition at the
 * highest bandwidth, and HLS clients select by bandwidth — so players pick a
 * rendition the device cannot decode and end up with audio and no picture.
 *
 * Simply handing the player one chosen variant is not an option: these masters
 * declare audio as a separate rendition (`#EXT-X-MEDIA:TYPE=AUDIO`) that the
 * video variants reference via `AUDIO="..."`. A variant playlist fetched on its
 * own carries no audio reference, so the result plays silently. The master has
 * to be kept intact and filtered instead.
 *
 * Only the small playlist passes through here; segments are fetched by the
 * player straight from the origin.
 */
async function filterPlaylist(target, cap) {
  const res = await fetch(target, {
    headers: { "User-Agent": UA },
    cf: { cacheTtl: 300, cacheEverything: true }
  });
  if (!res.ok) return null;

  const text = await res.text();
  if (text.indexOf("#EXTM3U") === -1) return null;
  // A media playlist needs no filtering — hand it straight back.
  if (text.indexOf("#EXT-X-STREAM-INF") === -1) return text;

  const lines = text.split("\n");
  const base = target;

  const abs = (rel) => {
    if (/^https?:\/\//i.test(rel)) return rel;
    const m = base.match(/^(https?:\/\/[^/]+)/);
    const origin = m ? m[1] : "";
    return rel.charAt(0) === "/" ? origin + rel : base.slice(0, base.lastIndexOf("/") + 1) + rel;
  };

  const out = [];
  const kept = [];
  const dropped = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Rewrite relative URIs inside EXT-X-MEDIA (the separate audio rendition).
    // Left relative, the player would resolve them against this Worker's origin
    // instead of the upstream host, and the audio track would 404.
    if (line.indexOf("#EXT-X-MEDIA") === 0 && line.indexOf('URI="') !== -1) {
      out.push(
        line.replace(/URI="([^"]+)"/, (whole, uri) => 'URI="' + abs(uri) + '"')
      );
      continue;
    }

    if (line.indexOf("#EXT-X-STREAM-INF") !== 0) {
      out.push(line);
      continue;
    }

    const next = (lines[i + 1] || "").trim();
    if (!next || next.charAt(0) === "#") {
      out.push(line);
      continue;
    }

    const res2 = line.match(/RESOLUTION=(\d+)x(\d+)/);
    const height = res2 ? parseInt(res2[2], 10) : 0;
    const codecs = (line.match(/CODECS="([^"]+)"/) || [])[1] || "";
    const hevc = /hvc1|hev1/i.test(codecs);
    const tooTall = height && height > cap;

    if (hevc || tooTall) {
      dropped.push({ index: i });
      i++; // also skip the URI line
      continue;
    }

    kept.push({ index: i });
    out.push(line);
    out.push(/^https?:\/\//i.test(next) ? next : abs(next));
    i++;
  }

  // Nothing worth removing: return the original untouched.
  if (!dropped.length) return text;

  // If the cap removes everything, keep the best of what was dropped rather
  // than returning a playlist the player cannot use. Rebuild from scratch in
  // that case, since the pass above already emitted the survivors.
  if (!kept.length) {
    const rebuilt = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.indexOf("#EXT-X-MEDIA") === 0 && line.indexOf('URI="') !== -1) {
        rebuilt.push(line.replace(/URI="([^"]+)"/, (w, uri) => 'URI="' + abs(uri) + '"'));
        continue;
      }
      if (line.indexOf("#EXT-X-STREAM-INF") !== 0) {
        rebuilt.push(line);
        continue;
      }
      const next = (lines[i + 1] || "").trim();
      if (!next || next.charAt(0) === "#") {
        rebuilt.push(line);
        continue;
      }
      rebuilt.push(line);
      rebuilt.push(/^https?:\/\//i.test(next) ? next : abs(next));
      i++;
    }
    return rebuilt.join("\n");
  }

  return out.join("\n");
}

/**
 * Serve metadata, including episode lists, so series opened from these rows do
 * not depend on another addon.
 *
 * Why this is needed: catalog items are emitted with `tmdb:` ids. Cinemeta only
 * understands `tt` ids and returns nothing for those, so unless the TMDB Addon
 * is installed and active, a series has no metadata source — no episode list —
 * and it behaves like a single video. Providing meta here removes that
 * dependency.
 */
async function meta(type, rawId) {
  let id = String(rawId).trim();

  // Stremio asks for series meta as <id>:<season>:<episode>. That suffix has
  // to come off before the id is resolved, or a tt... id never matches the
  // numeric-only branch and the lookup 404s - which is why series resolved
  // nowhere and no streams were ever requested.
  const suffix = id.match(/^(.*):(\d+):(\d+)$/);
  if (suffix) id = suffix[1];

  // Remember the id as the caller wrote it, so the meta and its videos come
  // back with matching ids.
  const requestedId = id;

  // Nuvio converts a tmdb: id to an IMDb id before looking meta up
  // (resolveMetaLookupId -> TmdbService.tmdbToImdb), so this handler is reached
  // with either form. Accept both.
  if (/^tt\d+$/i.test(id)) {
    const f = await fetch(
      "https://api.themoviedb.org/3/find/" + id +
        "?api_key=" + TMDB_API_KEY + "&external_source=imdb_id",
      { headers: { Accept: "application/json" }, cf: { cacheTtl: 3600, cacheEverything: true } }
    );
    if (!f.ok) return { meta: null };
    const found = await f.json();
    const list =
      type === "series" ? found.tv_results : found.movie_results;
    if (!list || !list.length) return { meta: null };
    id = String(list[0].id);
  } else {
    id = id.replace(/^tmdb[:\/]/, "").split(":")[0];
  }

  if (!/^\d+$/.test(id)) return { meta: null };

  const kind = type === "series" ? "tv" : "movie";
  const base = "https://api.themoviedb.org/3/" + kind + "/" + id;
  const key = "?api_key=" + TMDB_API_KEY;

  const r = await fetch(base + key, {
    headers: { Accept: "application/json" },
    cf: { cacheTtl: 3600, cacheEverything: true }
  });
  if (!r.ok) return { meta: null };
  const d = await r.json();

  // Use the id the caller asked with, so the meta id and the video ids line up
  // with what the client is holding.
  const baseId = /^(tt\d+)$/i.test(requestedId) ? requestedId : "tmdb:" + id;

  const meta = {
    id: baseId,
    type: type === "series" ? "series" : "movie",
    name: (kind === "tv" ? d.name : d.title) || "",
    description: d.overview || "",
    poster: d.poster_path ? IMG + d.poster_path : undefined,
    background: d.backdrop_path ? "https://image.tmdb.org/t/p/w1280" + d.backdrop_path : undefined,
    releaseInfo: String((kind === "tv" ? d.first_air_date : d.release_date) || "").slice(0, 4),
    imdbRating: d.vote_average ? String(Math.round(d.vote_average * 10) / 10) : undefined,
    genres: (d.genres || []).map(function (g) {
      return g.name;
    }),
    runtime: d.episode_run_time && d.episode_run_time.length ? d.episode_run_time[0] + "min" : undefined
  };

  if (kind !== "tv") return { meta: meta };

  // Episodes. Seasons are fetched in parallel; a show with many seasons costs
  // one request each, so results are cached for an hour.
  const seasons = (d.seasons || []).filter(function (s) {
    return s.season_number > 0;
  });
  const wanted = seasons.slice(0, 20);

  const results = await Promise.all(
    wanted.map(function (s) {
      return fetch(base + "/season/" + s.season_number + key, {
        headers: { Accept: "application/json" },
        cf: { cacheTtl: 3600, cacheEverything: true }
      })
        .then(function (x) {
          return x.ok ? x.json() : null;
        })
        .catch(function () {
          return null;
        });
    })
  );

  const videos = [];
  for (const season of results) {
    if (!season || !season.episodes) continue;
    for (const ep of season.episodes) {
      if (!ep || ep.episode_number == null) continue;
      videos.push({
        id: baseId + ":" + season.season_number + ":" + ep.episode_number,
        name: ep.name || "Episode " + ep.episode_number,
        season: season.season_number,
        episode: ep.episode_number,
        number: ep.episode_number,
        overview: ep.overview || undefined,
        thumbnail: ep.still_path ? "https://image.tmdb.org/t/p/w500" + ep.still_path : undefined,
        released: ep.air_date || undefined,
        runtime: ep.runtime ? ep.runtime + "min" : undefined,
        rating: ep.vote_average ? String(Math.round(ep.vote_average * 10) / 10) : undefined
      });
    }
  }

  if (videos.length) meta.videos = videos;
  return { meta: meta };
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
      const entry = { type: t, id: c.id, name: c.name };
      // Declaring the search extra is what makes a catalog searchable — without
      // it the client never offers a search field for the row.
      if (c.search) entry.extra = [{ name: "search", isRequired: false }];
      catalogs.push(entry);
    }
  }
  return {
    id: "org.ong.pvrplay.catalogs",
    version: "1.3.0",
    name: "PvrPlay Catalogs",
    logo: PVR_BASE + "/pvrplay-icon.png",
    description:
      "Home-screen rows from PvrPlay, mirroring the site. Every title listed is one PvrPlay carries.",
    resources: [
      { name: "catalog", types: ["movie", "series"] },
      { name: "stream", types: ["movie", "series"] },
      // No idPrefixes here on purpose. Nuvio rewrites a tmdb: id to an IMDb
      // id before resolving meta, then filters addons by idPrefixes — so
      // declaring "tmdb:" means this resource is never consulted.
      { name: "meta", types: ["movie", "series"] }
    ],
    types: ["movie", "series"],
    idPrefixes: ["tmdb:"],
    catalogs: catalogs
  };
}

/** Extract one balanced JSON array starting at `start`. */
function balancedArray(text, start) {
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
          return { arr: JSON.parse(text.slice(start, i + 1)), end: i };
        } catch (e) {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Read every row off the PvrPlay home screen.
 *
 * The homepage payload carries each row as {"items":[...],"title":"Row Name"},
 * so one fetch yields all of them — no per-row request, and the rows match the
 * site exactly.
 */
function parseHomeRows(payload) {
  const out = [];
  let idx = 0;
  while (true) {
    const at = payload.indexOf('"items":[', idx);
    if (at < 0) break;
    const start = payload.indexOf("[", at);
    const b = balancedArray(payload, start);
    if (!b) {
      idx = at + 9;
      continue;
    }
    const tail = payload.slice(b.end, b.end + 400);
    const tm = tail.match(/"title":"([^"]{2,50})"/);
    if (tm && b.arr.length) out.push({ title: tm[1], items: b.arr });
    idx = b.end;
  }
  return out;
}

/**
 * Search PvrPlay directly. The site's own search returns complete TMDB objects
 * under `initialResults`, so results match what the site would show.
 */
async function searchPvrPlay(query, type) {
  const r = await fetch(PVR_BASE + "/search?q=" + encodeURIComponent(query), {
    headers: { "User-Agent": UA, Accept: "text/html" },
    cf: { cacheTtl: 600, cacheEverything: true }
  });
  if (!r.ok) return { metas: [] };

  const items = extractArray(rscPayload(await r.text()), "initialResults");
  if (!items) return { metas: [] };

  const metas = [];
  for (const o of items) {
    if (!o || !o.id) continue;
    const series = isSeries(o);
    if (type === "series" && !series) continue;
    if (type === "movie" && series) continue;
    metas.push(toMeta(o));
  }
  return { metas: metas };
}

async function catalog(type, id, extra) {
  const def = CATALOGS.find(function (c) {
    return c.id === id;
  });
  if (!def) return { metas: [] };

  // A search on a searchable catalog goes straight to PvrPlay's own search.
  if (extra && extra.search) {
    return searchPvrPlay(extra.search, type);
  }

  // Rows lifted from the PvrPlay home screen.
  if (def.src === "home") {
    const r = await fetch(PVR_BASE + "/", {
      headers: { "User-Agent": UA, Accept: "text/html" },
      cf: { cacheTtl: 900, cacheEverything: true }
    });
    if (!r.ok) return { metas: [] };
    const rows = parseHomeRows(rscPayload(await r.text()));
    const row = rows.find(function (x) {
      return x.title === def.row;
    });
    if (!row) return { metas: [] };

    const metas = [];
    for (const o of row.items) {
      if (!o || !o.id) continue;
      const series = isSeries(o);
      if (type === "series" && !series) continue;
      if (type === "movie" && series) continue;
      metas.push(toMeta(o));
    }
    return { metas: metas };
  }

  // TMDB-backed rows (the Hindi ones).
  if (def.src === "tmdb") {
    const kind = type === "series" ? "tv" : "movie";
    const params = new URLSearchParams(
      Object.assign({}, def.query, { api_key: TMDB_API_KEY, page: "1" })
    );
    const r = await fetch("https://api.themoviedb.org/3/discover/" + kind + "?" + params, {
      headers: { Accept: "application/json" },
      cf: { cacheTtl: 900, cacheEverything: true }
    });
    if (!r.ok) return { metas: [] };
    const data = await r.json();
    const metas = [];
    for (const o of data.results || []) {
      if (!o || !o.id) continue;
      metas.push(toMeta(Object.assign({}, o, { media_type: kind === "tv" ? "tv" : "movie" })));
    }
    return { metas: metas };
  }

  const res = await fetch(PVR_BASE + def.path, {
    headers: { "User-Agent": UA, Accept: "text/html" },
    cf: { cacheTtl: 600, cacheEverything: true }
  });
  if (!res.ok) return { metas: [] };

  const html = await res.text();
  const items = extractArray(rscPayload(html), def.key);
  if (!items) return { metas: [] };

  const metas = [];
  for (const raw of items) {
    if (!raw) continue;
    // Some PvrPlay pages (e.g. /tamil-blasters) key the item as tmdb_id rather
    // than id, and carry a display title with the year and audio languages
    // already appended.
    const o = Object.assign({}, raw);
    if (!o.id && o.tmdb_id) o.id = o.tmdb_id;
    if (!o.id) continue;

    const series = isSeries(o);
    // Only surface rows matching the type the client asked for.
    if (type === "series" && !series) continue;
    if (type === "movie" && series) continue;

    const meta = toMeta(o);
    // "Minions & Monsters (2026) [Tam + Eng]" -> drop the redundant year, the
    // row already shows it, but keep the language tag as it is useful.
    meta.name = String(meta.name)
      .replace(/\s*\((19|20)\d{2}\)\s*/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
    metas.push(meta);
  }
  return { metas: metas };
}

/**
 * Resolve streams from every provider.
 *
 * Stremio series ids arrive as <id>:<season>:<episode>, so the tail is split
 * off before calling a provider, which takes them separately.
 */
// Per-provider cap. Stremio clients give up around 8s, so the slowest
// provider must not drag the whole response past that.
const PROVIDER_TIMEOUT_MS = 6000;

async function resolveStreams(type, rawId) {
  let id = rawId;
  let season = null;
  let episode = null;

  if (type === "series") {
    const m = id.match(/^(.*):(\d+):(\d+)$/);
    if (m) {
      id = m[1];
      season = parseInt(m[2], 10);
      episode = parseInt(m[3], 10);
    }
  }

  const providers = [
    { global: "__ONGserv1", name: "ongserv1" },
    { global: "__ONGserv2", name: "ongserv2" },
    { global: "__ONGserv3", name: "vidlink" }
  ];

  // Run the providers in parallel: each does its own upstream scraping, and
  // doing them in sequence meant the slowest one set the response time.
  const results = await Promise.all(
    providers.map(async function (p) {
      const mod = globalThis[p.global];
      if (!mod || typeof mod.getStreams !== "function") return { p: p, streams: [] };
      // Cap each provider: one slow upstream should not hold the whole
      // response past what a Stremio client will wait for.
      let timer = null;
      try {
        const work = mod.getStreams(id, type, season, episode).then(function (v) {
          return v || [];
        });
        const capped = new Promise(function (resolve) {
          timer = setTimeout(function () { resolve([]); }, PROVIDER_TIMEOUT_MS);
        });
        return { p: p, streams: (await Promise.race([work, capped])) || [] };
      } catch (e) {
        return { p: p, streams: [] };
      } finally {
        if (timer) clearTimeout(timer);
      }
    })
  );

  const out = [];
  for (const r of results) {
    for (const st of r.streams) {
      if (!st || !st.url) continue;
      out.push({
        name: r.p.name,
        title: st.title || r.p.name,
        url: st.url,
        quality: st.quality || "Auto",
        size: st.size && st.size !== "Unknown" ? st.size : undefined,
        behaviorHints: { notWebReady: false, bingeGroup: r.p.name }
      });
    }
  }
  return out;
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

      // Stremio stream endpoint. The id may be tt123, tmdb:123 or a bare
      // number; for series Stremio appends :season:episode.
      const str = path.match(/^\/stream\/([^/]+)\/(.+)\.json$/);
      if (str) {
        return cors(
          JSON.stringify({ streams: await resolveStreams(str[1], decodeURIComponent(str[2])) })
        );
      }
      // /meta/<type>/<id>.json
      const mm = path.match(/^\/meta\/([^/]+)\/(.+?)\.json$/);
      if (mm) {
        const data = await meta(decodeURIComponent(mm[1]), decodeURIComponent(mm[2]));
        // 404 rather than {"meta":null}: Nuvio stops at the first addon that
        // returns a parseable meta, and an empty one would suppress the
        // episode list that the metadata addons provide.
        if (!data || !data.meta) {
          return new Response("not found", {
            status: 404,
            headers: { "Access-Control-Allow-Origin": "*" }
          });
        }
        return cors(JSON.stringify(data));
      }

      // /hls?u=<encoded master playlist>&cap=1080
      if (path === "/hls") {
        const target = url.searchParams.get("u");
        const cap = parseInt(url.searchParams.get("cap") || "1080", 10) || 1080;
        if (!target) return cors(JSON.stringify({ error: "missing u" }), 400);

        const filtered = await filterPlaylist(target, cap);
        if (filtered === null) {
          return new Response("upstream playlist unavailable", { status: 502 });
        }
        return new Response(filtered, {
          status: 200,
          headers: {
            "Content-Type": "application/vnd.apple.mpegurl",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=300"
          }
        });
      }

      // /catalog/<type>/<id>.json
      // /catalog/<type>/<id>/<extra>.json   where extra is e.g. search=avatar
      //                                     or genre=Action&skip=100
      const m = path.match(/^\/catalog\/([^/]+)\/([^/]+?)(?:\/(.+?))?\.json$/);
      if (m) {
        const type = decodeURIComponent(m[1]);
        const id = decodeURIComponent(m[2]);
        const extra = {};
        if (m[3]) {
          for (const part of m[3].split("&")) {
            const eq = part.indexOf("=");
            if (eq > 0) {
              extra[decodeURIComponent(part.slice(0, eq))] = decodeURIComponent(part.slice(eq + 1));
            }
          }
        }
        const data = await catalog(type, id, extra);
        return cors(JSON.stringify(data));
      }

      return cors(JSON.stringify({ error: "not found", path: path }), 404);
    } catch (e) {
      return cors(JSON.stringify({ error: String(e && e.message ? e.message : e) }), 500);
    }
  }
};
