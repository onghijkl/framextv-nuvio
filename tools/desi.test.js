import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { _test } from "../addon/desi.js";

const dir = join(dirname(fileURLToPath(import.meta.url)), "fixtures-desi");
const fixture = (name) => readFileSync(join(dir, name), "utf8");

test("channel catalogue parses series cards", () => {
  const items = _test.parseSeriesCards(fixture("cat.html"));
  assert.ok(items.length >= 10, `expected >=10 cards, got ${items.length}`);
  for (const item of items) {
    assert.match(item.id, /^dser:ser:/);
    assert.ok(item.name.length > 1);
    assert.ok(item.id.length > 14);
  }
  assert.ok(items.some((i) => i.name === "Anupamaa"));
});

test("series page lists episodes newest first", () => {
  const eps = _test.parseEpisodes(fixture("series.html"));
  assert.equal(eps.length, 15);
  assert.match(eps[0].id, /^dser:ep:\d+$/);
  assert.ok(eps[0].date >= eps[1].date, "episodes should be newest-first");
  assert.ok(eps.every((e) => e.date.length === 10), "every episode needs a yyyy-mm-dd date");
});

test("episode page exposes title, art and all mirrors", () => {
  const ep = _test.parseEpisodePage(fixture("ep.html"));
  assert.match(ep.title, /Hamari Radha/i);
  assert.match(ep.image, /^https:\/\/www\.desi-serials\.to\//);
  assert.equal(ep.players.length, 4);
  for (const p of ep.players) assert.match(p, /^https:\/\/tvarticles\.org\/vid+d\.php\?id=\d+$/);
});

test("episode numbering follows the date in the title", () => {
  assert.equal(_test.titleDate("Anupamaa - Episode - 12th November 2026 Watch Online"), "2026-11-12");
  assert.equal(_test.titleDate("Kumkum Bhagya 1st January 2027 Watch Online"), "2027-01-01");
  assert.equal(_test.titleDate("no date here"), "");
  assert.equal(_test.dayOfYear("2026-01-01"), 1);
  assert.equal(_test.dayOfYear("2026-11-12"), 316);
});

test("id helpers are url-safe round trip", () => {
  const raw = "https://einsteinium.tvlogy.to/abc/video.m3u8?token=ZQ==";
  const enc = _test.b64urlEncode(raw);
  assert.ok(!/[+/=]/.test(enc));
  assert.equal(_test.b64urlDecode(enc), raw);
});

test("uaFromToken recovers the bound user agent", () => {
  const ua = "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36";
  const url = `https://einsteinium.tvlogy.to/x/video.m3u8?token=${_test.b64urlEncode(`${ua}||1.2.3.4, 5.6.7.8`)}`;
  assert.equal(_test.uaFromToken(url), ua);
  assert.ok(_test.uaFromToken("https://einsteinium.tvlogy.to/x/video.m3u8").startsWith("Mozilla/5.0"));
});

test("JuicyCodes packing is expanded", () => {
  const html =
    '<script>JuicyCodes.Run("ZXZhbChmdW5jdGlvbihwLGEsYyprLGUsZCx7fSl7cmV0dXJu"+"IHAuc3BsaXQoJycpLmpvaW4oJycpfSgnYWJjJyw2Miw4OCwnJy5zcGxpdCgnfCcpLDAsIiIpKQ==");</script>';
  const out = _test.textVariants(html);
  assert.ok(out.length > 1, "decoded variant expected");
});

test("titles from the show index have HTML entities decoded", () => {
  assert.equal(_test.unescapeHtml("Awards &amp; Concerts"), "Awards & Concerts");
  assert.equal(_test.unescapeHtml("&#039;90s &#x26; more"), "'90s & more");
});

test("legacy Stremio path extras are merged into query params", () => {
  const u = new URL("https://x/desi/catalog/series/search/search=naagin.json");
  assert.equal(_test.applyPathExtras(u, u.pathname), "/desi/catalog/series/search.json");
  assert.equal(u.searchParams.get("search"), "naagin");
  const v = new URL("https://x/desi/catalog/series/star-plus/skip=30.json");
  assert.equal(_test.applyPathExtras(v, v.pathname), "/desi/catalog/series/star-plus.json");
  assert.equal(v.searchParams.get("skip"), "30");
});

test("ampersand-joined legacy extras are handled too", () => {
  const u = new URL("https://x/desi/catalog/series/search/genre=Action&skip=100.json");
  const out = _test.applyPathExtras(u, u.pathname);
  assert.equal(out, "/desi/catalog/series/search.json");
  assert.equal(u.searchParams.get("skip"), "100");
  assert.equal(u.searchParams.get("genre"), "Action");
});

test("plain catalog paths are left untouched", () => {
  const u = new URL("https://x/desi/catalog/series/star-plus.json");
  assert.equal(_test.applyPathExtras(u, u.pathname), "/desi/catalog/series/star-plus.json");
  assert.equal([...u.searchParams].length, 0);
});

const IDX_FIXTURE = {
  shows: {
    "star-plus~anupamaa": ["star-plus", "", "Anupamaa", "https://p/1.jpg", "2026-11-12", 500],
    "star-plus~kumkum-bhagya": ["star-plus", "star-plus-completed-shows", "Kumkum Bhagya", null, "2021-03-05", 100],
    "colors~colors-completed-shows~naagin-4-colors": ["colors", "colors-completed-shows", "Naagin 4", null, "2020-05-23", 90],
    "life-ok~bade-achhe-lagte-hain": ["life-ok", "", "Bade Achhe Lagte Hain", null, "2019-01-01", 50],
  },
};
function stubIndex(body = IDX_FIXTURE, ok = true) {
  _test.clearCache();
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({ ok, json: async () => body });
  return () => { globalThis.fetch = orig; };
}

test("channel rows list every show of the channel, newest first", async () => {
  const restore = stubIndex();
  try {
    const out = await _test.catalogFromIndex("star-plus", new URL("https://x/desi/catalog/series/star-plus.json"), "https://x");
    assert.ok(out, "index should be used");
    assert.deepEqual(out.metas.map((m) => m.name), ["Anupamaa", "Kumkum Bhagya"]);
    assert.equal(out.metas[0].id, "dser:ser:star-plus~anupamaa");
    assert.equal(out.metas[1].type, "series");
  } finally { restore(); }
});

test("archive channels get no catalog row", async () => {
  const restore = stubIndex();
  try {
    assert.equal(await _test.catalogFromIndex("life-ok", new URL("https://x/desi/catalog/series/life-ok.json"), "https://x"), null);
    assert.deepEqual(_test.ARCHIVE_CHANNELS, ["life-ok", "zoo-of-all-old-shows"]);
  } finally { restore(); }
});

const PLAY_FIXTURE = {
  shows: {
    "star-plus~anupamaa": ["star-plus", "", "Anupamaa", null, "2026-11-12", 500, 1],
    "star-plus~kumkum-bhagya": ["star-plus", "star-plus-completed-shows", "Kumkum Bhagya", null, "2021-03-05", 100, 0],
    "star-plus~kabhi-kabhi": ["star-plus", "", "Kabhi Kabhi", null, "2022-01-01", 80, 1],
  },
};

test("channel rows drop shows whose episodes were removed at the source", async () => {
  const restore = stubIndex(PLAY_FIXTURE);
  try {
    const out = await _test.catalogFromIndex("star-plus", new URL("https://x/desi/catalog/series/star-plus.json"), "https://x");
    assert.deepEqual(out.metas.map((m) => m.name), ["Anupamaa", "Kabhi Kabhi"]);
  } finally { restore(); }
});

test("a channel with no verified show still lists everything", async () => {
  const onlyDead = { shows: { "star-plus~kumkum-bhagya": ["star-plus", "star-plus-completed-shows", "Kumkum Bhagya", null, "2021-03-05", 100, 0] } };
  const restore = stubIndex(onlyDead);
  try {
    const out = await _test.catalogFromIndex("star-plus", new URL("https://x/desi/catalog/series/star-plus.json"), "https://x");
    assert.equal(out.metas.length, 1);
    assert.equal(out.metas[0].name, "Kumkum Bhagya");
  } finally { restore(); }
});

test("rows that were never probed are treated as playable", async () => {
  const restore = stubIndex(IDX_FIXTURE);
  try {
    const out = await _test.catalogFromIndex("star-plus", new URL("https://x/desi/catalog/series/star-plus.json"), "https://x");
    assert.deepEqual(out.metas.map((m) => m.name), ["Anupamaa", "Kumkum Bhagya"]);
  } finally { restore(); }
});

test("both the modern and the legacy player endpoints are recognised", () => {
  assert.equal(
    _test.extractEmbed('<iframe src="https://flow.tvlogy.to/embed01/11uueklJyoJ0JRZ/"></iframe>'),
    "https://flow.tvlogy.to/embed01/11uueklJyoJ0JRZ",
  );
  assert.equal(
    _test.extractEmbed('<iframe src="https://hls.tvlogy.to/player/index.php?data=2a7724072f7899204001097c953e41c0"></iframe>'),
    "https://hls.tvlogy.to/player/index.php?data=2a7724072f7899204001097c953e41c0",
  );
});
