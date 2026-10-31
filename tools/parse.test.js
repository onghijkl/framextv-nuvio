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

  await test("needsFilter only fires when some variants go and some survive", function () {
    assert.strictEqual(P.needsFilter(MASTER_MIXED), true);
    // Every variant is HEVC: the Worker would keep them all, so the hop is pointless.
    assert.strictEqual(P.needsFilter(MASTER_ALL_HEVC), false);
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

  console.log(
    "\n[parse.test] " + passed + " passed" +
      (process.exitCode ? ", FAILURES above" : "")
  );
}

main().catch(function (e) {
  console.error("[parse.test] crashed:", e);
  process.exit(1);
});
