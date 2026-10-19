/**
 * pvrplay - built from src/pvrplay/index.js
 * Regenerate with: node tools/build.js
 */
/**
 * PvrPlay provider for Nuvio (Local Scraper / plugin format)
 *
 * Resolves a TMDB id to playable streams from PvrPlay.
 *
 * How the site works (verified Oct 2026):
 *   - Next.js frontend; detail URLs carry the TMDB id
 *       /movie/<slug>-<tmdbId>   /watch/movie/<tmdbId>
 *   - Playback is delegated to a third-party player:
 *       https://embed.reelsdownload.online/player/<tmdbId>?key=<signed>
 *   - That player fires several extractor endpoints in parallel and takes
 *     whichever answers:
 *       /api/cinemaos-extract   <- the reliable one
 *       /api/vidrift-extract /api/vsx-extract /api/animesalt-extract
 *       /api/moviebox /api/stream
 *   - No auth needed: the endpoints answer unsigned for arbitrary titles, so
 *     the embed token is not reproduced here.
 *
 * Why a plugin can reach these despite their missing CORS headers:
 *   Nuvio's plugin sandbox fetch() is NOT a browser fetch. FetchBridge binds
 *   __native_fetch -> httpRequestRaw -> a Ktor/URLSession client. There is no
 *   origin check, no preflight, so cross-origin rules do not apply. The
 *   returned mirror URLs do send Access-Control-Allow-Origin: * anyway.
 *
 * Sources come back as hls (.m3u8), mp4 or dash (.mpd); the player handles
 * all three.
 */

var PLAYER = "https://embed.reelsdownload.online";
var SITE = "https://pvrplay.fun";
var TMDB_API_KEY = "1865f43a0549ca50d341dd9ab8b29f49";
var TIMEOUT_MS = 15000;

var HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Referer": PLAYER + "/",
  "Origin": PLAYER
};

/**
 * Extractor endpoints, in preference order. cinemaos answers most
 * consistently; the rest are kept as failover but usually return found:false.
 */
var EXTRACTORS = [
  "cinemaos-extract",
  "vidrift-extract",
  "vsx-extract",
  "moviebox"
];

/* ------------------------------------------------------------------ utils */

function qs(obj) {
  var parts = [];
  for (var k in obj) {
    if (obj[k] === undefined || obj[k] === null || obj[k] === "") continue;
    parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(String(obj[k])));
  }
  return parts.join("&");
}

function qualityRank(q) {
  var s = String(q || "").toLowerCase();
  if (s.indexOf("4k") !== -1 || s.indexOf("2160") !== -1) return 2160;
  var m = s.match(/(\d{3,4})/);
  return m ? parseInt(m[1], 10) : 0;
}

function timedFetch(url, opts) {
  var options = opts || {};
  if (!options.headers) options.headers = HEADERS;
  var work = fetch(url, options);
  if (Promise && Promise.race) {
    return Promise.race([
      work,
      new Promise(function (_, reject) {
        setTimeout(function () {
          reject(new Error("timeout"));
        }, TIMEOUT_MS);
      })
    ]);
  }
  return work;
}

/**
 * Some responses carry trailing junk after the JSON object, so a plain
 * res.json() throws. Parse the first complete object instead.
 */
function readJsonLoose(res) {
  if (!res || !res.ok) return null;
  return res
    .text()
    .then(function (t) {
      if (!t) return null;
      try {
        return JSON.parse(t);
      } catch (e) {
        // Trim to the first balanced object.
        var depth = 0;
        var started = false;
        for (var i = 0; i < t.length; i++) {
          var c = t.charAt(i);
          if (c === "{") {
            depth++;
            started = true;
          } else if (c === "}") {
            depth--;
            if (started && depth === 0) {
              try {
                return JSON.parse(t.slice(0, i + 1));
              } catch (e2) {
                return null;
              }
            }
          }
        }
        return null;
      }
    })
    .catch(function () {
      return null;
    });
}

/* --------------------------------------------------------------- metadata */

/** TMDB lookup: title, year and imdb id (the extractors want imdb). */
function tmdbMeta(tmdbId, mediaType) {
  var type = mediaType === "tv" ? "tv" : "movie";
  var url =
    "https://api.themoviedb.org/3/" + type + "/" + tmdbId +
    "?api_key=" + TMDB_API_KEY + "&append_to_response=external_ids";
  return timedFetch(url)
    .then(function (r) {
      return r && r.ok ? r.json() : null;
    })
    .then(function (d) {
      if (!d) return null;
      var date = type === "tv" ? d.first_air_date : d.release_date;
      return {
        title: (type === "tv" ? d.name : d.title) || "",
        year: date ? String(date).slice(0, 4) : "",
        imdbId: (d.external_ids && d.external_ids.imdb_id) || ""
      };
    })
    .catch(function () {
      return null;
    });
}

function resolveTmdbId(tmdbId, mediaType) {
  var raw = String(tmdbId == null ? "" : tmdbId).trim();
  if (!raw) return Promise.resolve(null);
  if (raw.toLowerCase().indexOf("tt") === 0) {
    return timedFetch(
      "https://api.themoviedb.org/3/find/" + raw +
        "?api_key=" + TMDB_API_KEY + "&external_source=imdb_id"
    )
      .then(function (r) {
        return r && r.ok ? r.json() : null;
      })
      .then(function (d) {
        var res = d && (mediaType === "tv" ? d.tv_results : d.movie_results);
        if (res && res.length) return String(res[0].id);
        var other = d && (d.movie_results || d.tv_results);
        return other && other.length ? String(other[0].id) : null;
      })
      .catch(function () {
        return null;
      });
  }
  var n = parseInt(raw.replace(/[^0-9]/g, ""), 10);
  return Promise.resolve(isFinite(n) && n > 0 ? String(n) : null);
}

/* ------------------------------------------------------------- extraction */

/** One extractor call. Returns a normalized stream, or null. */
function tryExtractor(endpoint, tmdbId, mediaType, season, episode, meta) {
  var params = {
    type: mediaType,
    tmdb_id: tmdbId,
    title: meta.title,
    year: meta.year,
    imdb_id: meta.imdbId,
    platform: "ios"
  };
  if (mediaType === "tv") {
    params.season = season;
    params.episode = episode;
  }

  return timedFetch(PLAYER + "/api/" + endpoint + "?" + qs(params))
    .then(readJsonLoose)
    .then(function (d) {
      if (!d) return null;

      // Two shapes: a single {source:{...}} or a {sources:[...]} list.
      var list = [];
      if (d.source && d.source.url) list.push(d.source);
      if (d.sources && d.sources.length) list = list.concat(d.sources);
      if (!list.length) return null;

      var best = null;
      for (var i = 0; i < list.length; i++) {
        var s = list[i];
        if (!s || !s.url || typeof s.url !== "string") continue;
        if (!best || qualityRank(s.quality) > qualityRank(best.quality)) best = s;
      }
      if (!best) return null;

      // The extractors return root-relative paths for their own HLS proxy
      // (/api/ios-hls/master.m3u8?src=...). A player needs an absolute URL.
      if (best.url.charAt(0) === "/") {
        best = {
          url: PLAYER + best.url,
          quality: best.quality,
          scraperName: best.scraperName,
          label: best.label,
          type: best.type
        };
      }
      return best;
    })
    .catch(function () {
      return null;
    });
}

/**
 * Fan out across the extractors, in parallel. The site does the same.
 *
 * Timing matters here: cinemaos usually answers in ~1.7s while vidrift can
 * take 7s+ and still return nothing. Running them sequentially meant a slow
 * miss could delay a fast hit. Racing them all and taking the best answer
 * costs one round-trip instead of four.
 */
function extract(tmdbId, mediaType, season, episode, meta) {
  var pending = EXTRACTORS.map(function (ep) {
    return tryExtractor(ep, tmdbId, mediaType, season, episode, meta);
  });

  return Promise.all(pending)
    .then(function (results) {
      var seen = {};
      var out = [];
      for (var i = 0; i < results.length; i++) {
        var s = results[i];
        if (!s || !s.url || seen[s.url]) continue;
        seen[s.url] = true;
        out.push({
          name: "PvrPlay",
          title: "PvrPlay \u2022 " + (s.quality || "Auto") +
            (s.scraperName ? " \u2022 " + s.scraperName : "") +
            (s.label ? " \u2022 " + s.label : ""),
          url: s.url,
          quality: s.quality || "Auto",
          size: "Unknown",
          headers: HEADERS,
          subtitles: []
        });
      }
      out.sort(function (a, b) {
        return qualityRank(b.quality) - qualityRank(a.quality);
      });
      return out;
    })
    .catch(function () {
      return [];
    });
}

/* ------------------------------------------------------------------ entry */

function getStreams(tmdbId, mediaType, seasonNum, episodeNum) {
  var type = mediaType === "tv" ? "tv" : "movie";
  var season = parseInt(seasonNum, 10) || 1;
  var episode = parseInt(episodeNum, 10) || 1;

  return resolveTmdbId(tmdbId, type)
    .then(function (id) {
      if (!id) return null;
      return tmdbMeta(id, type).then(function (meta) {
        return { id: id, meta: meta || { title: "" } };
      });
    })
    .then(function (ctx) {
      if (!ctx) return [];
      return extract(ctx.id, type, season, episode, ctx.meta);
    })
    .catch(function () {
      return [];
    });
}

getStreams.loose = false;

if (typeof module !== "undefined" && module.exports) {
  module.exports = { getStreams: getStreams };
} else {
  global.getStreams = getStreams;
}