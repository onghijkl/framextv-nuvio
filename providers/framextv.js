/**
 * framextv - built from src/framextv/index.js
 * Regenerate with: node tools/build.js
 */
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
var TIMEOUT_MS = 6500;
// Playlist filter (the Cloudflare Worker in addon/) — caps resolution and
// strips HEVC while preserving the separate audio rendition.
var FILTER_BASE = "https://pvrplay-catalogs.pages.dev";
// Dead sources are dropped fast so the player is not kept waiting.
var VALIDATE_TIMEOUT_MS = 3500;

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
function timedFetch(url, opts, ms) {
  var options = opts || {};
  if (!options.headers) options.headers = HEADERS;
  var limit = ms || TIMEOUT_MS;
  var work = fetch(url, options);
  if (typeof Promise !== "undefined" && Promise.race) {
    return Promise.race([
      work,
      new Promise(function (_, reject) {
        setTimeout(function () {
          reject(new Error("timeout"));
        }, limit);
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

/** Resolve a possibly-relative URL against a base. */
function absUrl(base, rel) {
  if (rel.indexOf("http://") === 0 || rel.indexOf("https://") === 0) return rel;
  var m = base.match(/^(https?:\/\/[^\/]+)/);
  var origin = m ? m[1] : "";
  if (rel.charAt(0) === "/") return origin + rel;
  return base.substring(0, base.lastIndexOf("/") + 1) + rel;
}


/**
 * Validate one source and reduce it to something playable.
 *
 * Two jobs:
 *   1. Drop sources that do not answer. The upstream API lists sources that are
 *      simply dead, and handing one to the player is what makes playback sit
 *      there before falling back.
 *   2. For HLS, hand back a single suitable variant rather than the master.
 *
 * Returns the adjusted source, or null to discard it.
 */
/**
 * Does this master playlist contain anything the device should not be offered?
 * True when any variant is HEVC or taller than the cap.
 */
function needsFilter(text) {
  var cap = getStreams.maxHeight || 1080;
  var lines = text.split("\n");
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i];
    if (l.indexOf("#EXT-X-STREAM-INF") !== 0) continue;
    var res = l.match(/RESOLUTION=(\d+)x(\d+)/);
    var h = res ? parseInt(res[2], 10) : 0;
    var cod = (l.match(/CODECS="([^"]+)"/) || [])[1] || "";
    if (/hvc1|hev1/i.test(cod)) return true;
    if (h && h > cap) return true;
  }
  return false;
}

/**
 * Validate one source and reduce it to something playable.
 *
 * Three jobs:
 *   1. Drop sources that do not answer. Upstream lists sources that are simply
 *      dead, and handing one to the player is what makes playback sit there
 *      before falling back.
 *   2. Drop responses that are not really playlists (CDNs return error pages
 *      with a playlist-ish content type).
 *   3. When a master advertises HEVC or >cap renditions, route it through the
 *      playlist filter.
 *
 * Note on why the master is not simply replaced by one variant: these ladders
 * declare audio as a separate rendition (`#EXT-X-MEDIA:TYPE=AUDIO`) referenced
 * by `AUDIO="..."` on each variant. A variant playlist fetched on its own has no
 * audio reference, so the result plays silently. The master has to be kept and
 * filtered instead.
 *
 * Returns the adjusted source, or null to discard it.
 */
function prepareSource(s) {
  var isHls =
    s.type === "hls" || /\.m3u8(\?|$)/i.test(s.url) || s.url.indexOf("index-s") !== -1;

  if (!isHls) return Promise.resolve(s);

  return timedFetch(s.url, null, VALIDATE_TIMEOUT_MS)
    .then(function (r) {
      if (!r || !r.ok) return null;
      return r.text().then(function (t) {
        if (t.indexOf("#EXTM3U") === -1) return s; // not a playlist; trust it

        var isMaster = t.indexOf("#EXT-X-STREAM-INF") !== -1;
        if (!isMaster && t.indexOf("#EXTINF") === -1) return null; // empty shell

        if (isMaster && needsFilter(t)) {
          return {
            url: (getStreams.filterBase || FILTER_BASE) +
              "/hls?u=" + encodeURIComponent(s.url) +
              "&cap=" + (getStreams.maxHeight || 1080),
            type: s.type
          };
        }
        return s;
      });
    })
    .catch(function () {
      return null; // dead or too slow — do not offer it
    });
}

/**
 * Real extraction sources. This is the primary path: frameXTV's stream API
 * returns direct HLS playlists (4K/1080p/720p) behind a CDN proxy that DOES
 * send `Access-Control-Allow-Origin: *`, so the QuickJS sandbox can fetch them
 * and Nuvio's player can play them.
 *
 * The /embed/ URL is kept as a last-resort fallback only: it is an HTML page,
 * so a native player (mpv) rejects it with "unrecognized file format".
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
      if (!d) return [];
      var srcs = (d.sources || []);
      var candidates = [];

      for (var i = 0; i < srcs.length; i++) {
        var s = srcs[i];
        if (!s || !s.url) continue;

        // Subtitle tracks may sit on the source or on the payload root.
        var subs = [];
        var subRaw = s.subtitles || d.subtitles || [];
        for (var k = 0; k < subRaw.length; k++) {
          var t = subRaw[k];
          if (t && t.url) {
            subs.push({
              url: t.url,
              lang: t.lang || t.language || t.label || "Unknown"
            });
          }
        }

        candidates.push({
          name: "ongserv1",
          title: "ongserv1 \u2022 " + (s.quality || "Auto") +
            (s.server ? " \u2022 " + s.server : ""),
          url: s.url,
          quality: s.quality || "Auto",
          size: "Unknown",
          headers: HEADERS,
          subtitles: subs,
          _type: s.type
        });
      }

      // Validate in parallel. Resolve as soon as one source is good rather than
      // waiting on every check, so a slow or dead entry cannot hold up the
      // whole result.
      var checks = [];
      for (var ci = 0; ci < candidates.length; ci++) {
        (function (idx) {
          checks.push(
            prepareSource({ url: candidates[idx].url, type: candidates[idx]._type }).then(
              function (p) {
                return p ? { idx: idx, url: p.url } : null;
              }
            )
          );
        })(ci);
      }

      return settleFast(checks, 1, 700).then(function (prepared) {
        var out = [];
        var seen = {};

        for (var j = 0; j < prepared.length; j++) {
          if (!prepared[j]) continue;
          var item = candidates[prepared[j].idx];
          item.url = prepared[j].url;
          delete item._type;
          if (seen[item.url]) continue;
          seen[item.url] = true;
          out.push(item);
        }

        out.sort(function (a, b) {
          return qualityRank(b.quality) - qualityRank(a.quality);
        });
        return out;
      });
    })
    .catch(function () {
      return [];
    });
}

/**
 * Resolve as soon as enough sources have validated, instead of waiting for
 * every check. A single dead source used to hold up the whole result for the
 * full validation timeout, even when another source had already come back good.
 *
 *   minSources — how many good sources to gather before starting the grace timer
 *   graceMs    — how long to keep collecting after that, so near-simultaneous
 *                results still get included
 */
function settleFast(promises, minSources, graceMs) {
  return new Promise(function (resolve) {
    var good = [];
    var settled = 0;
    var timer = null;
    var finished = false;

    function finish() {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      resolve(good);
    }

    if (!promises.length) return finish();

    promises.forEach(function (p) {
      p.then(function (v) {
        settled++;
        if (v) good.push(v);
        if (settled === promises.length) return finish();
        if (good.length >= minSources && !timer) timer = setTimeout(finish, graceMs);
      }).catch(function () {
        settled++;
        if (settled === promises.length) return finish();
        if (good.length >= minSources && !timer) timer = setTimeout(finish, graceMs);
      });
    });
  });
}

/* ------------------------------------------------------------------ entry */

function getStreams(tmdbId, mediaType, seasonNum, episodeNum) {
  var type = mediaType === "tv" ? "tv" : "movie";
  var season = parseInt(seasonNum, 10) || 1;
  var episode = parseInt(episodeNum, 10) || 1;

  var idPromise = resolveTmdbId(tmdbId, type);

  // The extraction API needs only id and type, so start it immediately and let
  // the TMDB lookup run alongside it rather than in front of it. That removes a
  // full round-trip from the common path.
  var extractionPromise = idPromise.then(function (id) {
    if (!id) return { id: null, sources: [] };
    return directSources(id, type, season, episode, {}).then(function (s) {
      return { id: id, sources: s };
    });
  });

  var metaPromise = idPromise.then(function (id) {
    if (!id) return null;
    return tmdbMeta(id, type);
  });

  return Promise.all([extractionPromise, metaPromise])
    .then(function (both) {
      var ext = both[0] || {};
      var meta = both[1] || {};

      // Extraction returning sources is the strongest evidence the title is
      // carried, so no index lookup is needed in that case.
      if (ext.sources && ext.sources.length) return ext.sources;

      // Nothing playable. Consult the index to find the id frameXTV files this
      // title under, then try once more.
      var title = meta.title || "";
      if (!title) return [];
      return searchIndexMatch(title, meta.year, type).then(function (hit) {
        if (!hit || !hit.id) return [];
        if (String(hit.id) === String(ext.id)) return [];
        return directSources(String(hit.id), type, season, episode, meta);
      });
    })
    .catch(function () {
      return [];
    });
}

getStreams.direct = true;
getStreams.maxHeight = 1080;
getStreams.filterBase = FILTER_BASE;

if (typeof module !== "undefined" && module.exports) {
  module.exports = { getStreams: getStreams };
} else {
  global.getStreams = getStreams;
}
