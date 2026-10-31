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
 * cinemaos streams NDJSON (one source per line): every audio language and
 * quality, as HLS or MP4. All of them are returned.
 */


var PLAYER = "https://embed.reelsdownload.online";
var TMDB_API_KEY = "1865f43a0549ca50d341dd9ab8b29f49";
var TIMEOUT_MS = 7000;
// cinemaos regularly takes 8-11s; the old 7s cap threw those answers away
// and returned nothing.
var EXTRACT_TIMEOUT_MS = 12000;
var HEDGE_AFTER_MS = 3000;
var FILTER_BASE = "https://pvrplay-catalogs.pages.dev";
// HLS masters are fetched once to decide whether they need the codec filter.
// The extractor already verified every source, so a slow check keeps the
// source (unfiltered) instead of discarding it.
var VALIDATE_TIMEOUT_MS = 2500;
// How long to keep gathering after the first extractor answers. The fallback
// extractors normally finish (found:false) before cinemaos does.
var COLLECT_WINDOW_MS = 1500;

var HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Referer": PLAYER + "/",
  "Origin": PLAYER
};

/**
 * Extractor endpoints. cinemaos is the one that answers; the rest are kept
 * as failover (they currently return found:false in ~1s, in parallel).
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

/**
 * fetch with a timeout. The timer is always cleared so a finished request
 * never keeps the runtime alive (that alone made runs take ~7s).
 */
function timedFetch(url, opts, timeoutMs) {
  var options = opts || {};
  if (!options.headers) options.headers = HEADERS;
  var ms = timeoutMs || TIMEOUT_MS;
  var timer = null;
  var work = fetch(url, options);
  var cap = new Promise(function (_, reject) {
    timer = setTimeout(function () {
      reject(new Error("timeout"));
    }, ms);
  });
  return Promise.race([work, cap]).then(
    function (r) {
      if (timer) clearTimeout(timer);
      return r;
    },
    function (e) {
      if (timer) clearTimeout(timer);
      throw e;
    }
  );
}

/** Parse one JSON value, tolerating trailing junk after the first object. */
function parseLoose(t) {
  try {
    return JSON.parse(t);
  } catch (e) {
    var depth = 0;
    var inStr = false;
    var esc = false;
    for (var i = 0; i < t.length; i++) {
      var c = t.charAt(i);
      if (esc) { esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
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
}

/**
 * The extractors stream NDJSON: one {"source":{...}} per line, then
 * {"done":true}. cinemaos sends ~12 lines (every audio language and
 * quality). Reading only the first object — as this used to — kept one
 * 480p English source and threw the other eleven away.
 *
 * Returns an array of parsed objects.
 */
function readJsonLines(res) {
  if (!res || !res.ok) return Promise.resolve([]);
  return res
    .text()
    .then(function (t) {
      if (!t) return [];
      var out = [];
      var lines = t.split("\n");
      for (var i = 0; i < lines.length; i++) {
        var l = lines[i].trim();
        if (!l) continue;
        var d = parseLoose(l);
        if (d) out.push(d);
      }
      // Single pretty-printed object spanning several lines.
      if (!out.length) {
        var whole = parseLoose(t);
        if (whole) out.push(whole);
      }
      return out;
    })
    .catch(function () {
      return [];
    });
}

/* --------------------------------------------------------------- metadata */

function resolveTmdbId(tmdbId, mediaType) {
  var raw = String(tmdbId == null ? "" : tmdbId).trim();
  if (!raw) return Promise.resolve(null);
  if (/^tt\d+$/i.test(raw)) {
    return timedFetch(
      "https://api.themoviedb.org/3/find/" + raw +
        "?api_key=" + TMDB_API_KEY + "&external_source=imdb_id",
      { headers: { Accept: "application/json" } }
    )
      .then(function (r) {
        return r && r.ok ? r.json() : null;
      })
      .then(function (d) {
        var res = d && (mediaType === "tv" ? d.tv_results : d.movie_results);
        if (res && res.length) return String(res[0].id);
        return null;
      })
      .catch(function () {
        return null;
      });
  }
  var n = parseInt(raw.replace(/[^0-9]/g, ""), 10);
  return Promise.resolve(isFinite(n) && n > 0 ? String(n) : null);
}

/* ------------------------------------------------------------- extraction */

function isHlsSource(s) {
  return s.type === "hls" || /\.m3u8(\?|$)/i.test(s.url) || s.url.indexOf("ios-hls") !== -1;
}

/**
 * Would the playlist filter actually change anything?
 *
 * Only when some variants must go (HEVC, over the height or bitrate cap) AND
 * at least one survives. These ladders are often HEVC-only; the Worker then
 * keeps every variant anyway, so routing through it was a pointless extra hop.
 */
function needsFilter(text) {
  var cap = getStreams.maxHeight || 1080;
  var maxBw = getStreams.maxBitrate || 12000000;
  var kept = 0;
  var dropped = 0;
  var lines = text.split("\n");
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i];
    if (l.indexOf("#EXT-X-STREAM-INF") !== 0) continue;
    var res = l.match(/RESOLUTION=(\d+)x(\d+)/);
    var h = res ? parseInt(res[2], 10) : 0;
    var cod = (l.match(/CODECS="([^"]+)"/) || [])[1] || "";
    var bw = parseInt((l.match(/BANDWIDTH=(\d+)/) || [])[1] || "0", 10);
    if (/hvc1|hev1/i.test(cod) || (h && h > cap) || (bw && bw > maxBw)) dropped++;
    else kept++;
  }
  return dropped > 0 && kept > 0;
}

/**
 * Validate an HLS source and route it through the playlist filter when that
 * helps. Non-HLS sources pass straight through (the extractor verified them).
 *
 * The master is filtered rather than replaced by one variant: audio is a
 * separate rendition referenced by AUDIO="...", so a lone variant is silent.
 */
function prepareSource(s) {
  if (!isHlsSource(s)) return Promise.resolve(s);

  return timedFetch(s.url, null, VALIDATE_TIMEOUT_MS)
    .then(function (r) {
      if (!r) return s.verified ? s : null;
      if (!r.ok) return null;
      return r.text().then(function (t) {
        if (t.indexOf("#EXTM3U") === -1) return null;
        var isMaster = t.indexOf("#EXT-X-STREAM-INF") !== -1;
        if (!isMaster && t.indexOf("#EXTINF") === -1) return null;
        if (isMaster && needsFilter(t)) {
          var copy = {};
          for (var k in s) copy[k] = s[k];
          copy.url = (getStreams.filterBase || FILTER_BASE) +
            "/hls?u=" + encodeURIComponent(s.url) +
            "&cap=" + (getStreams.maxHeight || 1080) +
            "&maxbw=" + (getStreams.maxBitrate || 12000000);
          return copy;
        }
        return s;
      });
    })
    .catch(function () {
      // Timeout / network blip: the extractor already verified it.
      return s.verified ? s : null;
    });
}

/** Normalise one raw extractor source, or null. */
function normaliseSource(s) {
  if (!s || !s.url || typeof s.url !== "string") return null;
  return {
    url: s.url.charAt(0) === "/" ? PLAYER + s.url : s.url,
    quality: s.quality,
    scraperName: s.scraperName,
    label: s.label,
    type: s.type,
    verified: !!s.verified,
    latencyMs: s.latencyMs == null ? null : s.latencyMs,
    tracks: s.tracks
  };
}

/**
 * Hedged request for the primary extractor.
 *
 * cinemaos's response time is wildly uneven for the same title (measured
 * 2.6s, 5.8s, 10.9s back to back) and the delay is server-side — headers
 * arrive late, so nothing can be read early. Firing a second identical
 * request after HEDGE_AFTER_MS and taking whichever brings sources first
 * cuts the tail roughly in half without loading the upstream on fast calls.
 */
function hedgedFetchLines(url) {
  return new Promise(function (resolve) {
    var done = false;
    var inFlight = 0;
    var attempts = 0;
    var hedgeTimer = null;

    function hasSource(objs) {
      for (var i = 0; i < objs.length; i++) {
        if (objs[i] && (objs[i].source || (objs[i].sources && objs[i].sources.length))) return true;
      }
      return false;
    }

    function finish(objs) {
      done = true;
      if (hedgeTimer) clearTimeout(hedgeTimer);
      hedgeTimer = null;
      resolve(objs);
    }

    function settle(objs) {
      inFlight--;
      if (done) return;
      if (hasSource(objs) || inFlight === 0) finish(objs);
    }

    /**
     * A request that errored is not an answer. Treating it as one resolved the
     * whole hedge with [] on the first fast failure, which is exactly the case
     * hedging exists for: cinemaos fails in milliseconds and then succeeds on
     * an immediate retry. Retry once; the hedge timer still covers a slow call.
     */
    function failed() {
      inFlight--;
      if (done) return;
      if (attempts < 2) return fire();
      if (inFlight === 0) finish([]);
    }

    function fire() {
      attempts++;
      inFlight++;
      timedFetch(url, null, EXTRACT_TIMEOUT_MS)
        .then(readJsonLines)
        .then(settle, failed);
    }

    fire();
    hedgeTimer = setTimeout(function () {
      hedgeTimer = null;
      if (!done) fire();
    }, HEDGE_AFTER_MS);
  });
}

/** One extractor call. Returns every source it offered (possibly []). */
function tryExtractor(endpoint, tmdbId, mediaType, season, episode) {
  var params = { type: mediaType, tmdb_id: tmdbId, platform: "ios" };
  if (mediaType === "tv") {
    params.season = season;
    params.episode = episode;
  }

  var url = PLAYER + "/api/" + endpoint + "?" + qs(params);
  var call = endpoint === EXTRACTORS[0] ? hedgedFetchLines(url) : timedFetch(url).then(readJsonLines);

  return call
    .then(function (objs) {
      var out = [];
      for (var i = 0; i < objs.length; i++) {
        var d = objs[i];
        if (!d) continue;
        if (d.source) out.push(d.source);
        if (d.sources && d.sources.length) out = out.concat(d.sources);
      }
      var norm = [];
      for (var j = 0; j < out.length; j++) {
        var n = normaliseSource(out[j]);
        if (n) norm.push(n);
      }
      return norm;
    })
    .catch(function () {
      return [];
    });
}

/** Fan out across extractors in parallel; collect with a bounded window. */
function gather(tmdbId, mediaType, season, episode) {
  return new Promise(function (resolve) {
    var pending = EXTRACTORS.length;
    var results = [];
    var finished = false;
    var windowTimer = null;

    function finish() {
      if (finished) return;
      finished = true;
      if (windowTimer) clearTimeout(windowTimer);
      resolve(results);
    }

    function collect(list) {
      pending--;
      if (list && list.length) {
        results = results.concat(list);
        if (!windowTimer && pending > 0) windowTimer = setTimeout(finish, COLLECT_WINDOW_MS);
      }
      if (pending === 0) finish();
    }

    EXTRACTORS.forEach(function (ep) {
      tryExtractor(ep, tmdbId, mediaType, season, episode).then(collect, function () {
        collect(null);
      });
    });
  });
}

/** "Beta - Hindi" -> "Hindi". */
function languageOf(label) {
  var s = String(label || "");
  var i = s.indexOf(" - ");
  return (i === -1 ? s : s.slice(i + 3)).trim();
}

function languageRank(lang) {
  var pref = getStreams.preferredLanguages || [];
  var l = String(lang || "").toLowerCase();
  for (var i = 0; i < pref.length; i++) {
    if (l.indexOf(String(pref[i]).toLowerCase()) !== -1) return i;
  }
  return pref.length;
}

/** Subtitle tracks are shared across sources; build the list once. */
function subtitlesFrom(sources) {
  var seen = {};
  var subs = [];
  for (var i = 0; i < sources.length; i++) {
    var tr = sources[i].tracks || [];
    for (var j = 0; j < tr.length; j++) {
      var tk = tr[j];
      if (!tk || !tk.url) continue;
      var url = tk.url.indexOf("http") === 0 ? tk.url : PLAYER + tk.url;
      if (seen[url]) continue;
      seen[url] = true;
      subs.push({ url: url, lang: tk.label || tk.lang || "Unknown" });
    }
  }
  return subs;
}

function extract(tmdbId, mediaType, season, episode) {
  return gather(tmdbId, mediaType, season, episode).then(function (raw) {
    // Same URL from two extractors: keep the first.
    var seen = {};
    var unique = [];
    for (var i = 0; i < raw.length; i++) {
      if (seen[raw[i].url]) continue;
      seen[raw[i].url] = true;
      unique.push(raw[i]);
    }
    if (!unique.length) return [];

    var subs = subtitlesFrom(unique);

    // Each check is bounded by VALIDATE_TIMEOUT_MS, so Promise.all is safe —
    // the old 700ms "settle fast" window dropped every HLS source whenever an
    // MP4 (no check needed) resolved first.
    return Promise.all(unique.map(prepareSource)).then(function (prepared) {
      var out = [];
      for (var k = 0; k < prepared.length; k++) {
        var s = prepared[k];
        if (!s || !s.url) continue;
        var lang = languageOf(s.label);
        var fmt = isHlsSource(s) ? "HLS" : s.type ? String(s.type).toUpperCase() : "";
        out.push({
          _lr: languageRank(lang),
          _q: qualityRank(s.quality),
          _hls: fmt === "HLS" ? 1 : 0,
          _v: s.verified ? 1 : 0,
          _lat: s.latencyMs == null ? 99999 : s.latencyMs,
          name: "ongserv2",
          title: "ongserv2 \u2022 " + (s.quality || "Auto") +
            (lang ? " \u2022 " + lang : "") +
            (fmt ? " \u2022 " + fmt : "") +
            (s.label && s.label !== lang ? " (" + s.label.split(" - ")[0] + ")" : ""),
          url: s.url,
          quality: s.quality || "Auto",
          size: "Unknown",
          headers: HEADERS,
          subtitles: subs
        });
      }
      // Preferred language first, then best quality, then verified/fastest.
      out.sort(function (a, b) {
        return (a._lr - b._lr) || (b._q - a._q) || (b._v - a._v) ||
          (b._hls - a._hls) || (a._lat - b._lat);
      });
      var max = getStreams.maxResults || 0;
      if (max > 0 && out.length > max) out = out.slice(0, max);
      for (var c = 0; c < out.length; c++) {
        delete out[c]._lr; delete out[c]._q; delete out[c]._hls;
        delete out[c]._v; delete out[c]._lat;
      }
      return out;
    });
  });
}

/* ------------------------------------------------------------------ entry */

function getStreams(tmdbId, mediaType, seasonNum, episodeNum) {
  var type = mediaType === "tv" || mediaType === "series" ? "tv" : "movie";
  var season = parseInt(seasonNum, 10) || 1;
  var episode = parseInt(episodeNum, 10) || 1;

  return resolveTmdbId(tmdbId, type)
    .then(function (id) {
      if (!id) return [];
      return extract(id, type, season, episode);
    })
    .catch(function () {
      return [];
    });
}

getStreams.maxHeight = 1080;
getStreams.maxBitrate = 12000000;
getStreams.filterBase = FILTER_BASE;
getStreams.preferredLanguages = ["English", "Hindi"];
getStreams.maxResults = 0; // 0 = no cap

if (typeof globalThis !== "undefined") {
  globalThis.__ONGserv2 = { getStreams: getStreams };
}
if (typeof module !== "undefined" && module.exports) {
  // _test exists only for tools/parse.test.js; nothing on device reads it.
  module.exports = {
    getStreams: getStreams,
    _test: {
      parseLoose: parseLoose,
      readJsonLines: readJsonLines,
      needsFilter: needsFilter,
      qualityRank: qualityRank,
      languageOf: languageOf
    }
  };
} else if (typeof global !== "undefined") {
  global.getStreams = getStreams;
} else if (typeof globalThis !== "undefined") {
  globalThis.getStreams = getStreams;
}
