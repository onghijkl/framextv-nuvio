/**
 * frameXTV provider for Nuvio (Local Scraper / plugin format)
 *
 * Resolves a TMDB id to playable streams hosted by frameXTV (https://framextv.xyz).
 *
 * Contract (Nuvio QuickJS runtime):
 *   - getStreams(tmdbId, mediaType, seasonNum, episodeNum) -> Promise<Stream[]>
 *   - must NEVER throw; return [] on any failure
 *   - async/await is native, fetch() is available
 *   - no Node built-ins (fs/path/crypto/Buffer)
 *   - no console.* in shipped code
 *
 * Runtime notes:
 *   - The plugin QuickJS sandbox is cross-origin to framextv.xyz. Its own
 *     /api/stream service (a Cloudflare Worker) does not emit CORS headers
 *     for that origin, so a plugin cannot play the raw HLS playlist directly.
 *     This provider therefore returns frameXTV's public embed URLs, which the
 *     Nuvio player resolves. In a runtime that can reach the API without CORS
 *     (the CI test harness, for example) set direct = true to also emit the
 *     extracted HLS sources.
 *
 * Verified against the live site (Oct 2026):
 *   https://framextv.xyz/movie/<tmdbId>          details page
 *   https://framextv.xyz/tv/<tmdbId>             details page
 *   https://framextv.xyz/watch/<tmdbId>          movie playback
 *   https://framextv.xyz/watch/<tmdbId>/<s>/<e>  episode playback
 *   https://framextv.xyz/embed/<tmdbId>[/<s>/<e>]?autoplay=1&origin=internal
 *
 * Existence is decided by an actual extraction attempt, not by the search
 * index (which covers all of TMDB and therefore proves nothing).
 */

var SITE = "https://framextv.xyz";
var API_BASE = "https://api.framextv.tech";
var TMDB_API_KEY = "1865f43a0549ca50d341dd9ab8b29f49";
var TIMEOUT_MS = 12000;

var HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Referer": SITE + "/",
  "Origin": SITE
};

/* ------------------------------------------------------------------ utils */

function qs(obj) {
  var parts = [];
  for (var k in obj) {
    if (obj[k] === undefined || obj[k] === null || obj[k] === "") continue;
    parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(String(obj[k])));
  }
  return parts.join("&");
}

function normTitle(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** "4K" | "1080p" | "720p" | "480p" | "Unknown" -> sortable rank. */
function qualityRank(q) {
  var s = String(q || "").toLowerCase();
  if (s.indexOf("4k") !== -1 || s.indexOf("2160") !== -1) return 2160;
  var m = s.match(/(\d{3,4})/);
  return m ? parseInt(m[1], 10) : 0;
}

/** fetch with hard timeout; the runtime gives no AbortController guarantee. */
function timedFetch(url, opts) {
  var options = opts || {};
  if (!options.headers) options.headers = HEADERS;
  var work = fetch(url, options);
  if (typeof Promise !== "undefined" && Promise.race) {
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

function readJson(res) {
  if (!res || !res.ok) return null;
  return res
    .json()
    .then(function (j) {
      return j;
    })
    .catch(function () {
      return null;
    });
}

/* --------------------------------------------------------------- metadata */

/** TMDB lookup; also yields imdbId for the stream API. */
function tmdbMeta(tmdbId, mediaType) {
  var type = mediaType === "tv" ? "tv" : "movie";
  var url =
    "https://api.themoviedb.org/3/" + type + "/" + tmdbId +
    "?api_key=" + TMDB_API_KEY + "&append_to_response=external_ids";
  return timedFetch(url)
    .then(readJson)
    .then(function (d) {
      if (!d) return null;
      var date = type === "tv" ? d.first_air_date : d.release_date;
      return {
        title: type === "tv" ? d.name : d.title,
        year: date ? String(date).slice(0, 4) : "",
        imdbId: (d.external_ids && d.external_ids.imdb_id) || d.imdb_id || ""
      };
    })
    .catch(function () {
      return null;
    });
}

/** `tt123` / 123 / "123" -> numeric TMDB id, or null. */
function resolveTmdbId(tmdbId, mediaType) {
  var raw = String(tmdbId == null ? "" : tmdbId).trim();
  if (!raw) return Promise.resolve(null);
  if (raw.toLowerCase().indexOf("tt") === 0) {
    return timedFetch(
      "https://api.themoviedb.org/3/find/" + raw +
        "?api_key=" + TMDB_API_KEY + "&external_source=imdb_id"
    )
      .then(readJson)
      .then(function (d) {
        var results = d && (mediaType === "tv" ? d.tv_results : d.movie_results);
        if (results && results.length) return String(results[0].id);
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

/* ------------------------------------------------------- site id agreement */

function yearsClose(a, b, tol) {
  var t = tol === undefined ? 1 : tol;
  if (!a || !b) return true; // an unknown year is not evidence of a mismatch
  return Math.abs(parseInt(a, 10) - parseInt(b, 10)) <= t;
}

/**
 * The site's search index covers all of TMDB, so a search hit alone proves
 * nothing about frameXTV's library. The decisive test is whether a stream can
 * be extracted for this exact id.
 *
 * Observed API shapes (Oct 2026):
 *   in library     -> {"success":true,"provider":"miner","sources":[...]}
 *   not in library -> {"success":false,"error":"TMDB returned HTTP 404"}
 *   undecided      -> {"success":true,"sources":[]}
 *
 * Returns "yes" | "no" | "unknown". "unknown" must not block the result —
 * a transient API failure should not hide a title frameXTV does carry.
 */
function streamAvailability(tmdbId, mediaType, season, episode, meta) {
  var url = API_BASE + "/api/stream?" + qs({
    id: tmdbId,
    type: mediaType,
    season: mediaType === "tv" ? season : undefined,
    episode: mediaType === "tv" ? episode : undefined,
    title: meta.title,
    year: meta.year,
    imdb_id: meta.imdbId
  });
  return timedFetch(url)
    .then(readJson)
    .then(function (d) {
      if (!d) return "unknown";
      if (d.success === false) return "no";
      if (d.sources && d.sources.length > 0) return "yes";
      return "unknown";
    })
    .catch(function () {
      return "unknown";
    });
}

/**
 * Search the site index, both to corroborate that frameXTV indexes this title
 * and to recover the id it actually uses. Exact title match only — a substring
 * match is far too loose ("Fight Club" also hits "Jurassic Fight Club").
 */
function searchIndexMatch(title, year, mediaType) {
  var url = API_BASE + "/api/search?" + qs({ query: title });
  return timedFetch(url)
    .then(readJson)
    .then(function (d) {
      var list = (d && d.results) || [];
      var want = normTitle(title);
      if (!want) return null;

      var exact = null;
      var wrongYear = null;

      for (var i = 0; i < list.length; i++) {
        var item = list[i];
        if (normTitle(item.title) !== want) continue;
        if (mediaType && item.type && item.type !== mediaType) continue;
        if (yearsClose(item.year, year)) {
          if (!exact) exact = item;
        } else if (!wrongYear) {
          wrongYear = item;
        }
      }
      if (exact) return exact;
      // accept the only 1-2 year drift when the requested year was unknown
      if (!year && wrongYear) return wrongYear;

      for (var j = 0; j < list.length; j++) {
        var g = normTitle(list[j].title);
        if (g.indexOf(want) === 0 && yearsClose(list[j].year, year) &&
            (!mediaType || !list[j].type || list[j].type === mediaType)) {
          return list[j];
        }
      }
      return null;
    })
    .catch(function () {
      return null;
    });
}

/* ------------------------------------------------------------ stream URL */

function embedUrl(tmdbId, mediaType, season, episode) {
  var base = SITE + "/embed/" + tmdbId;
  if (mediaType === "tv") {
    base += "/" + (season || 1) + "/" + (episode || 1);
  }
  return base + "?" + qs({ autoplay: 1, origin: "internal" });
}

function watchUrl(tmdbId, mediaType, season, episode) {
  var base = SITE + "/watch/" + tmdbId;
  if (mediaType === "tv") {
    base += "/" + (season || 1) + "/" + (episode || 1);
  }
  return base;
}

/**
 * Extraction sources, used only when direct = true. frameXTV's own player
 * calls this same worker; a plugin can only match that where CORS does not
 * apply.
 */
function directSources(tmdbId, mediaType, season, episode, meta) {
  var url = API_BASE + "/api/stream?" + qs({
    id: tmdbId,
    type: mediaType,
    season: mediaType === "tv" ? season || 1 : undefined,
    episode: mediaType === "tv" ? episode || 1 : undefined,
    title: meta.title,
    year: meta.year,
    imdb_id: meta.imdbId
  });
  return timedFetch(url)
    .then(readJson)
    .then(function (d) {
      var srcs = (d && d.sources) || [];
      var out = [];
      for (var i = 0; i < srcs.length; i++) {
        var s = srcs[i];
        if (!s || !s.url) continue;
        out.push({
          name: "frameXTV",
          title: s.server || "frameXTV",
          url: s.url,
          quality: s.quality || "Unknown",
          size: "Unknown",
          headers: HEADERS,
          subtitles: []
        });
      }
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
        return { id: id, meta: meta || {} };
      });
    })
    .then(function (ctx) {
      if (!ctx) return [];

      var title = ctx.meta.title || "";

      // No TMDB metadata means no title to check; fall back to the requested
      // id rather than refusing to return anything.
      if (!title) {
        return streamAvailability(ctx.id, type, season, episode, ctx.meta).then(
          function (avail) {
            if (avail === "no") return [];
            return { id: ctx.id, meta: ctx.meta };
          }
        );
      }

      return searchIndexMatch(title, ctx.meta.year, type).then(function (hit) {
        var targetId = ctx.id;

        // The index knows frameXTV's own id for this title. If it disagrees
        // with the requested one, the index wins only when the title matches
        // exactly — which searchIndexMatch has already enforced.
        if (hit && hit.id) targetId = String(hit.id);

        var notIndexed = !hit && !getStreams.lenient;
        return streamAvailability(targetId, type, season, episode, ctx.meta).then(
          function (avail) {
            if (avail === "no") return [];
            // Indexed nowhere and extraction is undecided: stay quiet rather
            // than offer a stream that will not play.
            if (notIndexed && avail !== "yes") return [];
            return { id: targetId, meta: ctx.meta };
          }
        );
      });
    })
    .then(function (ctx) {
      if (!ctx || !ctx.id) return [];

      var label = type === "tv" ? "S" + season + "E" + episode : ctx.meta.year || "Movie";

      var streams = [
        {
          name: "frameXTV",
          title: "frameXTV — " + label,
          url: embedUrl(ctx.id, type, season, episode),
          quality: "Auto",
          size: "Unknown",
          headers: HEADERS,
          subtitles: [],
          behaviorHints: { notWebReady: false }
        },
        {
          name: "frameXTV",
          title: "frameXTV page — " + label,
          url: watchUrl(ctx.id, type, season, episode),
          quality: "Auto",
          size: "Unknown",
          headers: HEADERS,
          subtitles: [],
          behaviorHints: { notWebReady: false }
        }
      ];

      if (getStreams.direct) {
        return directSources(ctx.id, type, season, episode, ctx.meta).then(function (direct) {
          var merged = direct.concat(streams);
          merged.sort(function (a, b) {
            return qualityRank(b.quality) - qualityRank(a.quality);
          });
          return merged;
        });
      }

      return streams;
    })
    .catch(function () {
      return [];
    });
}

getStreams.direct = false;
getStreams.lenient = false;

if (typeof module !== "undefined" && module.exports) {
  module.exports = { getStreams: getStreams };
} else {
  global.getStreams = getStreams;
}