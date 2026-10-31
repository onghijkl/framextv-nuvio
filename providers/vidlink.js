/**
 * vidlink - built from src/vidlink/index.js
 * Regenerate with: node tools/build.js
 */
/**
 * vidlink provider for Nuvio (Local Scraper / plugin format)
 *
 * Resolves a TMDB id to playable streams from vidlink.pro.
 *
 * How it works (verified Oct 2026):
 *   1. vidlink requires the TMDB id to be encrypted, so the id is first sent to
 *      the public helper at enc-dec.app/api/enc-vidlink.
 *   2. GET https://vidlink.pro/api/b/movie/<encrypted>
 *      or  https://vidlink.pro/api/b/tv/<encrypted>/<season>/<episode>
 *      returns { sourceId, stream: { qualities: { "1080": {url}, ... },
 *      playlist } }.
 *
 * Measured: ~0.6s for a series episode, ~1.9s for a film.
 *
 * Like the other providers here it validates each candidate before handing it
 * over, and routes anything carrying HEVC or a rendition above the cap through
 * the playlist filter. Returning a raw master lets the player pick a 4K HEVC
 * track it cannot decode, which shows up as audio with no picture.
 */

var API = "https://vidlink.pro/api/b";
var ENC_API = "https://enc-dec.app/api/enc-vidlink";
var FILTER_BASE = "https://pvrplay-catalogs.pages.dev";
var TMDB_API_KEY = "1865f43a0549ca50d341dd9ab8b29f49";

var TIMEOUT_MS = 8000;
var VALIDATE_TIMEOUT_MS = 3500;

var HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Referer": "https://vidlink.pro/",
  "Origin": "https://vidlink.pro"
};

/* ------------------------------------------------------------------ utils */

function qualityRank(q) {
  var s = String(q || "").toLowerCase();
  if (s.indexOf("4k") !== -1 || s.indexOf("2160") !== -1) return 2160;
  var m = s.match(/(\d{3,4})/);
  return m ? parseInt(m[1], 10) : 0;
}

function labelFor(key) {
  var n = parseInt(String(key).replace(/[^0-9]/g, ""), 10);
  if (!isFinite(n) || n <= 0) return String(key || "Auto");
  if (n >= 2160) return "4K";
  return n + "p";
}

/**
 * fetch with a hard timeout. The timer is always cleared, so a request that
 * has already answered never keeps the runtime alive waiting on it.
 */
function timedFetch(url, opts, ms) {
  var options = opts || {};
  if (!options.headers) options.headers = HEADERS;
  var limit = ms || TIMEOUT_MS;
  var timer = null;
  var work = fetch(url, options);
  var cap = new Promise(function (_, reject) {
    timer = setTimeout(function () {
      reject(new Error("timeout"));
    }, limit);
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

/** Resolve a possibly-relative URL against a base. */
function absUrl(base, rel) {
  if (rel.indexOf("http://") === 0 || rel.indexOf("https://") === 0) return rel;
  var m = base.match(/^(https?:\/\/[^\/]+)/);
  var origin = m ? m[1] : "";
  if (rel.charAt(0) === "/") return origin + rel;
  return base.substring(0, base.lastIndexOf("/") + 1) + rel;
}

/* ------------------------------------------------------- validation/filter */

/** Does this master carry HEVC or a rendition above the cap? */
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

function prepareSource(s) {
  var isHls =
    s.type === "hls" || /\.m3u8(\?|$)/i.test(s.url) || s.url.indexOf("playlist") !== -1;

  if (!isHls) return Promise.resolve(s);

  return timedFetch(s.url, null, VALIDATE_TIMEOUT_MS)
    .then(function (r) {
      if (!r || !r.ok) return null;
      return r.text().then(function (t) {
        if (t.indexOf("#EXTM3U") === -1) return s;
        var isMaster = t.indexOf("#EXT-X-STREAM-INF") !== -1;
        if (!isMaster && t.indexOf("#EXTINF") === -1) return null;

        if (isMaster && needsFilter(t)) {
          return {
            url: (getStreams.filterBase || FILTER_BASE) +
              "/hls?u=" + encodeURIComponent(s.url) +
              "&cap=" + (getStreams.maxHeight || 1080),
            quality: s.quality,
            subtitles: s.subtitles
          };
        }
        return s;
      });
    })
    .catch(function () {
      return null;
    });
}

/* -------------------------------------------------------------- extraction */

function resolveTmdbId(tmdbId, mediaType) {
  var raw = String(tmdbId == null ? "" : tmdbId).trim();
  if (!raw) return Promise.resolve(null);
  if (/^tt/i.test(raw)) {
    return timedFetch(
      "https://api.themoviedb.org/3/find/" + raw +
        "?api_key=" + TMDB_API_KEY + "&external_source=imdb_id"
    )
      .then(readJson)
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

/** vidlink expects the TMDB id encrypted; a public helper does that. */
function encryptId(id) {
  return timedFetch(ENC_API + "?text=" + encodeURIComponent(id))
    .then(readJson)
    .then(function (d) {
      return d && d.result ? String(d.result) : null;
    })
    .catch(function () {
      return null;
    });
}

/** Collect any subtitle renditions the payload carries. */
function subtitlesFrom(d, base) {
  var out = [];
  var raw = d.subtitles || (d.stream && (d.stream.subtitles || d.stream.captions)) || [];
  if (!Array.isArray(raw)) return out;
  for (var i = 0; i < raw.length; i++) {
    var s = raw[i];
    if (!s || !s.url) continue;
    out.push({
      url: absUrl(base, String(s.url)),
      lang: s.language || s.lang || s.label || "Unknown"
    });
  }
  return out;
}

function extract(tmdbId, mediaType, season, episode) {
  return encryptId(tmdbId).then(function (enc) {
    if (!enc) return [];

    var path = mediaType === "tv"
      ? "/tv/" + enc + "/" + (season || 1) + "/" + (episode || 1)
      : "/movie/" + enc;

    return timedFetch(API + path).then(function (r) {
      if (!r || !r.ok) return [];
      return r.text().then(function (body) {
        var d = null;
        try {
          d = JSON.parse(body.split("\n")[0]);
        } catch (e) {
          return [];
        }
        if (!d || !d.stream) return [];

        var subs = subtitlesFrom(d, API);
        var candidates = [];
        var qualities = d.stream.qualities || {};

        for (var key in qualities) {
          var q = qualities[key];
          if (!q || !q.url) continue;
          candidates.push({
            url: absUrl(API, String(q.url)),
            quality: labelFor(key),
            subtitles: subs,
            // vidlink serves MP4 chunks, not HLS. Treating them as HLS made the
            // validator fetch them, and the CDN answers 429 — every source was
            // being discarded as dead.
            type: q.type || "mp4"
          });
        }

        // A playlist-only response carries no per-quality entries.
        if (!candidates.length && d.stream.playlist) {
          candidates.push({
            url: absUrl(API, String(d.stream.playlist)),
            quality: "Auto",
            subtitles: subs,
            type: "hls"
          });
        }
        return candidates;
      });
    });
  }).catch(function () {
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
      if (!id) return [];
      return extract(id, type, season, episode);
    })
    .then(function (candidates) {
      if (!candidates.length) return [];

      var checks = candidates.map(function (c) {
        return prepareSource({ url: c.url, type: c.type, quality: c.quality, subtitles: c.subtitles }).then(function (p) {
          if (!p || !p.url) return null;
          var item = {};
          for (var k in c) item[k] = c[k];
          item.url = p.url;
          return item;
        });
      });

      return Promise.all(checks).then(function (prepared) {
        var seen = {};
        var out = [];
        for (var i = 0; i < prepared.length; i++) {
          var p = prepared[i];
          if (!p || !p.url || seen[p.url]) continue;
          seen[p.url] = true;
          out.push({
            name: "vidlink",
            title: "vidlink \u2022 " + (p.quality || "Auto") +
              (type === "tv" ? " \u2022 S" + season + "E" + episode : ""),
            url: p.url,
            quality: p.quality || "Auto",
            size: "Unknown",
            headers: HEADERS,
            subtitles: p.subtitles || []
          });
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

getStreams.maxHeight = 1080;
getStreams.filterBase = FILTER_BASE;

if (typeof globalThis !== "undefined") {
  globalThis.__ONGserv3 = { getStreams: getStreams };
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = { getStreams: getStreams };
} else if (typeof global !== "undefined") {
  global.getStreams = getStreams;
} else if (typeof globalThis !== "undefined") {
  globalThis.getStreams = getStreams;
}
