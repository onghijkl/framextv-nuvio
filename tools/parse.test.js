#!/usr/bin/env node
/**
 * Offline tests for the pure parsing and filtering logic.
 *
 * Everything here runs on fixture strings with no network, so it fails when the
 * code regresses rather than when an upstream site moves. The live checks in
 * CI cover the opposite case.
 *
 *   node tools/parse.test.js
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");

let passed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(function () {
      passed++;
      console.log("  ok  " + name);
    })
    .catch(function (e) {
      console.error("  FAIL " + name + "\n       " + (e && e.message));
      process.exitCode = 1;
    });
}

/* ------------------------------------------------------------- fixtures */

// One RSC chunk as Next.js emits it: a JS string literal inside
// self.__next_f.push([1,"..."]).
function rscHtml(json) {
  const literal = JSON.stringify(json).slice(1, -1);
  return '<script>self.__next_f.push([1,"' + literal + '"])</script>';
}

const MASTER_MIXED = [
  "#EXTM3U",
  "#EXT-X-VERSION:4",
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",DEFAULT=YES,URI="audio/eng.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=20000000,RESOLUTION=3840x2160,CODECS="hvc1.1.6.L153,mp4a.40.2",AUDIO="aud"',
  "4k/index.m3u8",
  '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="aud"',
  "1080/index.m3u8",
  '#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2",AUDIO="aud"',
  "720/index.m3u8",
  ""
].join("\n");

const MASTER_ALL_HEVC = [
  "#EXTM3U",
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",URI="audio/eng.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=20000000,RESOLUTION=3840x2160,CODECS="hvc1.1.6.L153",AUDIO="aud"',
  "4k/index.m3u8",
  '#EXT-X-STREAM-INF:BANDWIDTH=9000000,RESOLUTION=2560x1440,CODECS="hev1.1.6.L120",AUDIO="aud"',
  "1440/index.m3u8",
  ""
].join("\n");

// A ladder that genuinely carries 4K over AVC — the shape the Worker used to
// truncate back to 1080p, both because cap defaulted to 1080 and because the
// 4K rung is over the old 12 Mbps bitrate ceiling.
const MASTER_AVC_4K = [
  "#EXTM3U",
  '#EXT-X-STREAM-INF:BANDWIDTH=15400000,RESOLUTION=3840x2160,CODECS="avc1.640033,mp4a.40.2"',
  "4k/index.m3u8",
  '#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"',
  "1080/index.m3u8",
  '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"',
  "720/index.m3u8",
  ""
].join("\n");

// 4K over both codecs: here the HEVC rung is redundant, so it still goes.
const MASTER_HEVC_REDUNDANT = [
  "#EXTM3U",
  '#EXT-X-STREAM-INF:BANDWIDTH=20000000,RESOLUTION=3840x2160,CODECS="hvc1.1.6.L153"',
  "4k-hevc/index.m3u8",
  '#EXT-X-STREAM-INF:BANDWIDTH=22000000,RESOLUTION=3840x2160,CODECS="avc1.640033"',
  "4k-avc/index.m3u8",
  '#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,CODECS="avc1.640028"',
  "1080/index.m3u8",
  ""
].join("\n");

const MEDIA_PLAYLIST = [
  "#EXTM3U",
  "#EXT-X-TARGETDURATION:6",
  "#EXTINF:6.0,",
  "seg1.ts",
  "#EXTINF:6.0,",
  "seg2.ts",
  "#EXT-X-ENDLIST",
  ""
].join("\n");

const TARGET = "https://cdn.example.com/hls/abc/master.m3u8";

/** filterPlaylist fetches the target; serve a fixture instead. */
function stubFetch(body, ok) {
  globalThis.fetch = function () {
    return Promise.resolve({
      ok: ok === undefined ? true : ok,
      headers: { get: function () { return null; } },
      text: function () { return Promise.resolve(body); }
    });
  };
}

/* ----------------------------------------------------------------- run */

async function main() {
  // worker.js is an ES module in a package with no "type" field, so Node reads
  // it as CommonJS unless the extension says otherwise. Copy it next to its own
  // relative imports so they still resolve.
  const mjs = path.join(root, "addon", "worker.gen.mjs");
  fs.copyFileSync(path.join(root, "addon", "worker.js"), mjs);
  let W;
  try {
    W = (await import("file://" + mjs))._test;
  } finally {
    fs.unlinkSync(mjs);
  }
  const P = require(path.join(root, "providers", "pvrplay.js"))._test;
  const F = require(path.join(root, "providers", "framextv.js"))._test;
  const V = require(path.join(root, "providers", "vidlink.js"))._test;

  console.log("[parse.test] worker parsers");

  await test("rscPayload + extractArray read an item array", function () {
    const html = rscHtml('{"initialMovies":[{"id":11,"title":"A"},{"id":22,"title":"B"}]}');
    const items = W.extractArray(W.rscPayload(html), "initialMovies");
    assert.deepStrictEqual(items.map(function (o) { return o.id; }), [11, 22]);
  });

  await test("extractArray survives brackets inside strings", function () {
    const text = '{"initialItems":[{"title":"Not [the] end ]]"},{"title":"x"}]}';
    const items = W.extractArray(text, "initialItems");
    assert.strictEqual(items.length, 2);
    assert.strictEqual(items[0].title, "Not [the] end ]]");
  });

  await test("extractArray returns null for a missing key", function () {
    assert.strictEqual(W.extractArray('{"other":[1]}', "initialMovies"), null);
  });

  await test("parseHomeRows pairs each item array with its row title", function () {
    const payload =
      '{"items":[{"id":1}],"title":"Trending Now"},' +
      '{"items":[{"id":2},{"id":3}],"title":"New Releases"}';
    const rows = W.parseHomeRows(payload);
    assert.deepStrictEqual(
      rows.map(function (r) { return [r.title, r.items.length]; }),
      [["Trending Now", 1], ["New Releases", 2]]
    );
  });

  await test("filterPlaylist drops HEVC and absolutises the audio URI", async function () {
    stubFetch(MASTER_MIXED);
    const out = await W.filterPlaylist(TARGET, 1080, 12000000);
    assert.ok(out.indexOf("hvc1") === -1, "HEVC variant still present");
    assert.ok(out.indexOf("4k/index.m3u8") === -1, "4K URI still present");
    assert.ok(
      out.indexOf("https://cdn.example.com/hls/abc/1080/index.m3u8") !== -1,
      "1080 variant missing or left relative"
    );
    assert.ok(
      out.indexOf('URI="https://cdn.example.com/hls/abc/audio/eng.m3u8"') !== -1,
      "audio rendition URI left relative — the track would 404"
    );
  });

  await test("filterPlaylist keeps every variant when the cap removes them all", async function () {
    stubFetch(MASTER_ALL_HEVC);
    const out = await W.filterPlaylist(TARGET, 1080, 12000000);
    assert.ok(out.indexOf("4k/index.m3u8") !== -1, "nothing left for the player");
    assert.ok(
      out.indexOf('URI="https://cdn.example.com/hls/abc/audio/eng.m3u8"') !== -1,
      "audio rendition URI left relative"
    );
  });

  await test("filterPlaylist hands a media playlist back untouched", async function () {
    stubFetch(MEDIA_PLAYLIST);
    const out = await W.filterPlaylist(TARGET, 1080, 12000000);
    assert.strictEqual(out, MEDIA_PLAYLIST);
  });

  await test("filterPlaylist rejects a response that is not a playlist", async function () {
    stubFetch("<html>403 Forbidden</html>");
    assert.strictEqual(await W.filterPlaylist(TARGET, 1080, 12000000), null);
  });

  await test("applySkip pages a row and runs out", function () {
    const metas = [{ id: "a" }, { id: "b" }, { id: "c" }];
    assert.strictEqual(W.applySkip(metas, { skip: "1" }).length, 2);
    assert.strictEqual(W.applySkip(metas, { skip: "99" }).length, 0);
    assert.strictEqual(W.applySkip(metas, {}).length, 3);
  });

  console.log("[parse.test] /hls guard");

  await test("isPrivateHost catches loopback and metadata, not real hostnames", function () {
    ["127.0.0.1", "169.254.169.254", "10.0.0.5", "192.168.1.1", "172.16.0.1",
      "localhost", "::1", "fd00::1"].forEach(function (h) {
      assert.ok(W.isPrivateHost(h), h + " should be refused");
    });
    ["cdn.example.com", "10.cdn.example.com", "8.8.8.8",
      "172.32.0.1"].forEach(function (h) {
      assert.ok(!W.isPrivateHost(h), h + " should be allowed");
    });
  });

  await test("hlsTargetRefusal blocks internal targets and bad schemes", function () {
    assert.strictEqual(
      W.hlsTargetRefusal("http://169.254.169.254/latest/meta-data/", {}),
      "host not allowed"
    );
    assert.strictEqual(W.hlsTargetRefusal("file:///etc/passwd", {}), "scheme not allowed");
    assert.strictEqual(W.hlsTargetRefusal("not a url", {}), "u is not a url");
    assert.strictEqual(W.hlsTargetRefusal(TARGET, {}), null);
  });

  await test("hlsTargetRefusal enforces HLS_ALLOW when it is set", function () {
    const env = { HLS_ALLOW: "example.com, vidlink.pro" };
    assert.strictEqual(W.hlsTargetRefusal(TARGET, env), null);
    assert.strictEqual(
      W.hlsTargetRefusal("https://evil.test/m.m3u8", env),
      "host not allowed"
    );
    // A suffix match must not be satisfied by a lookalike domain.
    assert.strictEqual(
      W.hlsTargetRefusal("https://notexample.com/m.m3u8", env),
      "host not allowed"
    );
  });

  console.log("[parse.test] pvrplay parsers");

  await test("parseLoose reads one object and ignores trailing junk", function () {
    assert.deepStrictEqual(P.parseLoose('{"a":1} <!-- noise -->'), { a: 1 });
    assert.deepStrictEqual(P.parseLoose('{"a":"}"} junk'), { a: "}" });
    assert.strictEqual(P.parseLoose("not json at all"), null);
  });

  await test("readJsonLines reads every NDJSON source, not just the first", async function () {
    const ndjson = [
      '{"source":{"url":"https://a/1.m3u8","quality":"1080p"}}',
      '{"source":{"url":"https://a/2.m3u8","quality":"720p"}}',
      '{"done":true}'
    ].join("\n");
    const objs = await P.readJsonLines({
      ok: true,
      text: function () { return Promise.resolve(ndjson); }
    });
    assert.strictEqual(objs.length, 3);
    assert.strictEqual(objs[1].source.quality, "720p");
  });

  await test("readJsonLines handles one pretty-printed object", async function () {
    const objs = await P.readJsonLines({
      ok: true,
      text: function () { return Promise.resolve('{\n  "source": {\n    "url": "https://a/1.m3u8"\n  }\n}'); }
    });
    assert.strictEqual(objs.length, 1);
    assert.strictEqual(objs[0].source.url, "https://a/1.m3u8");
  });

  // The 4K path. Two separate knobs used to cut the 3840x2160 rung off a
  // ladder that really carries it — the 1080 height cap and the 12 Mbps
  // bitrate ceiling — and a third (HEVC) cut it whenever the 4K rung was
  // HEVC-only, which on real ladders is the common case.
  await test("filterPlaylist keeps a real 4K rung at the 2160 / 40 Mbps defaults", async function () {
    stubFetch(MASTER_AVC_4K);
    const out = await W.filterPlaylist(TARGET, 2160, 40000000);
    assert.ok(out.indexOf("4k/index.m3u8") !== -1, "4K rung dropped");
    assert.ok(out.indexOf("1080/index.m3u8") !== -1);
    assert.ok(out.indexOf("720/index.m3u8") !== -1);
  });

  await test("both old caps were truncating 4K on their own", async function () {
    stubFetch(MASTER_AVC_4K);
    const byHeight = await W.filterPlaylist(TARGET, 1080, 40000000);
    assert.strictEqual(byHeight.indexOf("4k/index.m3u8"), -1);
    assert.ok(byHeight.indexOf("1080/index.m3u8") !== -1);

    stubFetch(MASTER_AVC_4K);
    const byRate = await W.filterPlaylist(TARGET, 2160, 12000000);
    assert.strictEqual(byRate.indexOf("4k/index.m3u8"), -1, "15.4 Mbps rung survived the old ceiling");
  });

  await test("an HEVC rung is dropped only when AVC already reaches that height", async function () {
    stubFetch(MASTER_MIXED);
    const kept = await W.filterPlaylist(TARGET, 2160, 40000000);
    assert.ok(kept.indexOf("4k/index.m3u8") !== -1, "HEVC-only 4K must survive");

    stubFetch(MASTER_HEVC_REDUNDANT);
    const redundant = await W.filterPlaylist(TARGET, 2160, 40000000);
    assert.strictEqual(redundant.indexOf("4k-hevc/index.m3u8"), -1);
    assert.ok(redundant.indexOf("4k-avc/index.m3u8") !== -1);
  });

  await test("codec=avc restores the old always-drop, codec=any keeps everything", async function () {
    stubFetch(MASTER_MIXED);
    const avc = await W.filterPlaylist(TARGET, 2160, 40000000, "avc");
    assert.strictEqual(avc.indexOf("4k/index.m3u8"), -1);

    stubFetch(MASTER_HEVC_REDUNDANT);
    const any = await W.filterPlaylist(TARGET, 2160, 40000000, "any");
    assert.ok(any.indexOf("4k-hevc/index.m3u8") !== -1);
  });

  await test("a 4K ladder is labelled, so it stops sorting like \"Auto\"", function () {
    assert.strictEqual(P.ladderTop(MASTER_AVC_4K.split("\n")), 2160);
    const relabelled = P.withLadderLabel({ url: "u", quality: "auto" }, MASTER_AVC_4K);
    assert.strictEqual(relabelled.quality, "2160p");
    assert.ok(P.qualityRank(relabelled.quality) > P.qualityRank("1080p"));
    // A label upstream already got right is left alone, and a stream the
    // upstream rated higher is never downgraded by our own measurement.
    assert.strictEqual(P.withLadderLabel({ url: "u", quality: "2160p" }, MASTER_AVC_4K).quality, "2160p");
    assert.strictEqual(P.withLadderLabel({ url: "u", quality: "4K" }, MASTER_AVC_4K).quality, "4K");
    const small = ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080', "1080/index.m3u8", ""].join("\n");
    assert.strictEqual(P.withLadderLabel({ url: "u", quality: "auto" }, small).quality, "1080p");
    assert.strictEqual(P.withLadderLabel({ url: "u", quality: "2160p" }, small).quality, "2160p");
  });

  await test("a playlist hidden behind a proxy hop is still recognised", function () {
    // The 4K rung tends to live on a host the extractor reaches through a CORS
    // hop — the extension sits inside ?url=, so the source used to be emitted
    // unprobed, labelled "auto", and sorted below every 1080p entry.
    const hop =
      "https://frappe.hybrows.workers.dev/?origin=https%3A%2F%2Fvidly.pro&url=https%3A%2F%2Fimg.rousav.tech%2Fmedia%2F84ac0a4bc316%2Findex.m3u8";
    assert.ok(P.embeddedHls(hop));
    assert.strictEqual(P.isHlsSource({ url: hop }), true);
    // A proxied plain file must stay a file — probing it changes nothing.
    assert.strictEqual(P.embeddedHls("https://hop/?url=https%3A%2F%2Fcdn%2Fmovie.mp4"), "");
    assert.strictEqual(P.isHlsSource({ url: "https://cdn/movie.mp4" }), false);
    assert.ok(F.embeddedHls(hop) && V.embeddedHls(hop));
  });

  await test("needsFilter only fires when some variants go and some survive", function () {
    // Both 4K ladders pass through untouched now: nothing is over 2160 and the
    // HEVC rungs are the only route to 4K, so a wrap would change nothing.
    assert.strictEqual(P.needsFilter(MASTER_MIXED), false);
    assert.strictEqual(P.needsFilter(MASTER_AVC_4K), false);
    assert.strictEqual(P.needsFilter(MASTER_ALL_HEVC), false);
    // A redundant HEVC rung is the case the hop still exists for.
    assert.strictEqual(P.needsFilter(MASTER_HEVC_REDUNDANT), true);
    assert.strictEqual(P.needsFilter(MEDIA_PLAYLIST), false);
  });

  await test("qualityRank orders the labels the extractors emit", function () {
    assert.ok(P.qualityRank("4K") > P.qualityRank("1080p"));
    assert.ok(P.qualityRank("1080p") > P.qualityRank("720p | Hindi"));
    assert.strictEqual(P.qualityRank("Auto"), 0);
    assert.strictEqual(P.qualityRank(undefined), 0);
  });

  await test("languageOf strips the server prefix", function () {
    assert.strictEqual(P.languageOf("Beta - Hindi"), "Hindi");
    assert.strictEqual(P.languageOf("English"), "English");
    assert.strictEqual(P.languageOf(undefined), "");
  });

  // The relay hop cinemaos puts in front of every alternate-audio source is a
  // CORS proxy and nothing else. If it survives into the emitted link, every
  // language shares a long identical prefix and the client shows three
  // different streams as "the same link" over and over.
  const RELAY = "https://cinemaos-relay.hzxdfx7.workers.dev/?url=";
  const MEDIA = "https://holly.mpddash.workers.dev/p/" + "A".repeat(40);
  const OTHER = MEDIA.replace("A".repeat(40), "B".repeat(40));
  const wrap = function (m) {
    return "https://embed.reelsdownload.online/api/ios-hls/master.m3u8?src=" +
      encodeURIComponent(RELAY + encodeURIComponent(m));
  };
  const SHORT_PREFIX = "https://embed.reelsdownload.online/api/ios-hls/master.m3u8?src=";

  await test("unwrapProxy drops the CORS-only relay hop", function () {
    assert.strictEqual(P.unwrapProxy(wrap(MEDIA)), SHORT_PREFIX + encodeURIComponent(MEDIA));
  });

  await test("unwrapProxy leaves a plain link alone", function () {
    assert.strictEqual(P.unwrapProxy(MEDIA), MEDIA);
  });

  await test("two languages stop sharing one identical link", function () {
    const a = P.unwrapProxy(wrap(MEDIA));
    const b = P.unwrapProxy(wrap(OTHER));
    assert.notStrictEqual(a, b);
    let same = 0;
    while (same < a.length && a[same] === b[same]) same++;
    assert.ok(same < SHORT_PREFIX.length + 60,
      "distinguishing part must move up into the visible prefix (shared " + same + " chars)");
  });

  await test("edition/signature variants collapse to one media key", function () {
    const x = "https://bcdnt.hakunaymatata.com/resource/deadbeef.mp4?sign=aaa&t=111";
    const y = "https://bcdnt.hakunaymatata.com/resource/deadbeef.mp4?sign=bbb&t=222";
    assert.strictEqual(P.mediaKey(x), P.mediaKey(y));
    assert.notStrictEqual(P.mediaKey(x), P.mediaKey(y.replace("deadbeef", "cafe1234")));
  });

  await test("mediaKey unwraps the relay hop as well", function () {
    assert.strictEqual(
      P.mediaKey(wrap(MEDIA)),
      P.mediaKey(SHORT_PREFIX + encodeURIComponent(MEDIA))
    );
    assert.notStrictEqual(P.mediaKey(wrap(MEDIA)), P.mediaKey(wrap(OTHER)));
  });

  await test("extractArray finds a key that is still escaped in the payload", function () {
    // The second needle used to be '\\"' in source, which is just '"' — a
    // duplicate of the first search, so this form was never found and the row
    // came back silently empty.
    const text = '{\\"initialResults\\":[{"id":7},{"id":8}]}';
    const items = W.extractArray(text, "initialResults");
    assert.ok(items, "escaped key form not found");
    assert.deepStrictEqual(items.map(function (o) { return o.id; }), [7, 8]);
  });

  await test("all three providers agree on when the filter helps", function () {
    // These had drifted: framextv fired on the first bad variant, vidlink
    // ignored the bitrate cap, pvrplay required a survivor. Same input, same
    // answer, or a fix to one keeps missing the other two.
    [
      [MASTER_MIXED, false, "mixed ladder"],
      [MASTER_AVC_4K, false, "4K AVC ladder"],
      [MASTER_HEVC_REDUNDANT, true, "redundant HEVC ladder"],
      [MASTER_ALL_HEVC, false, "all-HEVC ladder"],
      [MEDIA_PLAYLIST, false, "media playlist"]
    ].forEach(function (row) {
      const text = row[0], want = row[1], label = row[2];
      assert.strictEqual(P.needsFilter(text), want, "pvrplay disagrees on " + label);
      assert.strictEqual(F.needsFilter(text), want, "framextv disagrees on " + label);
      assert.strictEqual(V.needsFilter(text), want, "vidlink disagrees on " + label);
    });
  });

  await test("framextv matches titles exactly, not by prefix", function () {
    const want = F.normTitle("Fight Club");
    assert.strictEqual(F.normTitle("Fight Club Sessions"), "fight club sessions");
    assert.notStrictEqual(F.normTitle("Fight Club Sessions"), want);
    assert.strictEqual(F.normTitle("Fight  Club!"), want);
    // An unknown year on either side is not evidence of a mismatch.
    assert.strictEqual(F.yearsClose(1999, ""), true);
    assert.strictEqual(F.yearsClose(1999, 2005), false);
    assert.strictEqual(F.yearsClose(1999, 2000), true);
  });

  await test("one link per audio track and resolution", function () {
    // Same source twice: a MovieBox HLS re-wrap and the direct CDN file.
    const rows = [
      { _lang: "English", _ql: "480p", _hls: 1, url: "hls-480" },
      { _lang: "English", _ql: "480p", _hls: 0, url: "mp4-480" },
      { _lang: "English", _ql: "720p", _hls: 0, url: "mp4-720" },
      { _lang: "Hindi", _ql: "1080p", _hls: 1, url: "hls-1080" }
    ];
    const out = P.collapseTrackQuality(rows);
    assert.deepStrictEqual(out.map(function (r) { return r.url; }),
      ["mp4-480", "mp4-720", "hls-1080"]);
  });

  await test("collapsing keeps the direct file over the HLS re-wrap", function () {
    const rows = [
      { _lang: "English", _ql: "1080p", _hls: 1, url: "hls" },
      { _lang: "English", _ql: "1080p", _hls: 0, url: "mp4" }
    ];
    assert.deepStrictEqual(P.collapseTrackQuality(rows).map(function (r) { return r.url; }), ["mp4"]);
  });

  await test("collapsing keeps files of different qualities", function () {
    const rows = [
      { _lang: "English", _ql: "480p", _hls: 1, url: "a" },
      { _lang: "English", _ql: "720p", _hls: 0, url: "b" },
      { _lang: "Hindi", _ql: "480p", _hls: 0, url: "c" }
    ];
    assert.strictEqual(P.collapseTrackQuality(rows).length, 3);
  });

  console.log(
    "\n[parse.test] " + passed + " passed" +
      (process.exitCode ? ", FAILURES above" : "")
  );
}

main().catch(function (e) {
  console.error("[parse.test] crashed:", e);
  process.exit(1);
});
