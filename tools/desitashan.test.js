import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { _test } from "../addon/desitashan.js";

const dir = join(dirname(fileURLToPath(import.meta.url)), "fixtures-dts");
const fixture = (name) => readFileSync(join(dir, name), "utf8");

test("RSS feed parses to episode cards", () => {
  const items = _test.parseFeed(fixture("feed.xml"));
  assert.ok(items.length >= 3, `expected >=3 items, got ${items.length}`);
  for (const item of items) {
    assert.equal(_test.episodeId(item.slug, item.pid), `dts:ep:${item.slug}_${item.pid}`);
    assert.match(item.pid, /^[a-f0-9]{16}$/);
    assert.ok(item.title.length > 5);
    assert.match(item.image, /^https:\/\/www\.desitashan\.su\//);
  }
});

test("category page parses episode cards with dates", () => {
  const cards = _test.parseCards(fixture("cat.html"));
  assert.ok(cards.length >= 3, `expected >=3 cards, got ${cards.length}`);
  for (const card of cards) {
    assert.match(card.id, /^dts:ep:[a-z0-9-]+_[a-f0-9]{16}$/);
    assert.ok(card.slug.length > 5);
    assert.ok(card.date.length > 4, "expected a parsed date");
  }
  assert.ok(cards.some((c) => /anupama/i.test(c.slug)));
});

test("episode page exposes title, poster and the getlink token", () => {
  const page = _test.parseEpisodePage(fixture("ep.html"));
  assert.ok(page);
  assert.match(page.name, /Anupama/i);
  assert.match(page.pid, /^[a-f0-9]{16}$/);
  assert.ok(page.tokens.length >= 1, "expected >=1 player token");
  assert.match(page.tokens[0], /^[A-Za-z0-9+/=_-]{40,}$/);
  assert.match(page.image, /^https:\/\/www\.desitashan\.su\//);
});

test("ids round-trip through the route table", async () => {
  const card = _test.parseCards(fixture("cat.html"))[0];
  assert.equal(_test.episodeId(card.slug, card.pid), card.id);
  const path = await _test.pathForStreamId(card.id);
  assert.ok(path, "episode id should be routable");
  assert.match(path, /^\/[a-z0-9-]+\/[a-f0-9]{16}\/$/);
  assert.equal(await _test.pathForStreamId("dts:show:star-plus:zzz"), "");
  assert.ok(!(await _test.pathForStreamId("dts:ep:nope")));
});

test("manifest advertises catalogs, meta and stream", () => {
  const m = _test.dtsManifest("https://example.test");
  assert.equal(m.id, "org.pvrplay.desitashan");
  assert.match(m.version, /^\d+\.\d+\.\d+$/);
  for (const name of ["catalog", "meta", "stream"]) {
    assert.ok(m.resources.includes(name), `missing resource ${name}`);
  }
  assert.ok(m.catalogs.length >= 2);
});

test("channel list is deduplicated", () => {
  const slugs = _test.CHANNELS.map((c) => c.slug);
  assert.equal(new Set(slugs).size, slugs.length);
  assert.ok(slugs.includes("star-plus"));
});

test("series manifest clones the dashboard rows", () => {
  const m = _test.dssManifest("https://example.test");
  assert.equal(m.id, "org.pvrplay.desitashan.series");
  assert.match(m.version, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(m.resources, ["catalog", "meta", "stream"]);
  assert.ok(m.types.includes("series"));
  const ids = m.catalogs.map((c) => c.id);
  const names = m.catalogs.map((c) => c.name);
  const tiles = _test.DASH_TILES.map((t) => `dss:ch:${t.slug}`);
  // dashboard order first: spotlight, latest, then every "Watch by Channel" tile
  assert.deepEqual(ids.slice(0, 2), ["dss:spotlight", "dss:latest"]);
  assert.deepEqual(ids.slice(2, 2 + tiles.length), tiles);
  assert.equal(names[0], "New Episode Spotlight");
  assert.equal(names[1], "Latest Desi Tashan Episodes");
  assert.equal(names[2], "Star Plus");
  assert.ok(names.includes("Dangal TV"));
  assert.ok(names.includes("Bigg Boss 20"));
  // extra channels + browse rows come after the dashboard clone
  for (const id of ["dss:all", "dss:search"]) assert.ok(ids.includes(id), `${id} missing`);
  assert.deepEqual(ids.slice(-2), ["dss:all", "dss:search"]);
  assert.notEqual(m.id, _test.dtsManifest("https://example.test").id);
});

test("every /dss row is a series row (a card is always a show hub)", () => {
  const m = _test.dssManifest("https://example.test");
  for (const c of m.catalogs) {
    assert.equal(c.type, "series", `${c.id} should be type series`);
    assert.equal(c.contentType, undefined);
  }
  // `movie` stays advertised so meta/stream ids cached by the v1.1.0 install
  // (which had two movie rows) keep resolving.
  assert.deepEqual(m.types, ["series", "movie"]);
});

test("dashboard tile + json-ld parsing helpers", () => {
  assert.equal(_test.DASH_TILES.length, 8);
  assert.equal(_test.DASH_TILES[0].slug, "star-plus");
  assert.equal(_test.DASH_TILES[7].slug, "bigg-boss-20");
  const html = `<script type="application/ld+json">${JSON.stringify({
    "@graph": [
      { "@type": "WebSite" },
      {
        "@type": "ItemList",
        itemListElement: [
          { "@type": "ListItem", url: "https://www.desitashan.su/anupama/0123456789abcdef/", name: "Anupama 12th November 2026 Full Episode | Star Plus" },
          { "@type": "ListItem", item: { url: "https://www.desitashan.su/tu-juliet-jatt-di/0123456789abcdee/", name: "Tu Juliet Jatt Di", image: { url: "https://cdn.test/p.jpg" } } },
        ],
      },
    ],
  })}</script>`;
  const eps = _test.parseJsonLdEpisodes(html);
  assert.equal(eps.length, 2);
  assert.deepEqual({ slug: eps[0].slug, pid: eps[0].pid }, { slug: "anupama", pid: "0123456789abcdef" });
  assert.equal(eps[1].image, "https://cdn.test/p.jpg");
  assert.equal(_test.dashShowName("Anupama 12th November 2026 Full Episode | Star Plus"), "Anupama");
  assert.equal(
    _test.dashShowName("Bigg Boss (Tamil) Season 10 12th November 2026 Full Episode | JioHotstar"),
    "Bigg Boss (Tamil) Season 10",
  );
  assert.equal(_test.dashShowSlug("Bigg Boss (Tamil) Season 10"), "bigg-boss-tamil-season-10");
});

test("channel labels and title parsing", () => {
  assert.equal(_test.channelLabel("star-plus"), "Star Plus");
  assert.equal(_test.channelLabel(""), "Other");
  assert.equal(_test.channelLabel("some-new-channel"), "Some New Channel");
  assert.equal(_test.titleChannel("Anupama 12th November 2026 Full Episode | Star Plus"), "Star Plus");
  assert.equal(_test.titleChannel("No channel here"), "");
  const d = _test.titleDate("Anupama 12th November 2026 Full Episode | Star Plus");
  assert.equal(new Date(d).toISOString().slice(0, 10), "2026-11-12");
  assert.equal(_test.titleDate("no date"), 0);
});

test("channel-qualified show ids are routable", async () => {
  const pid = "2df34ae6ad969547";
  assert.equal(_test.showId("anupama", "star-plus"), "dts:show:star-plus~anupama");
  assert.equal(_test.showId("anupama", ""), "dts:show:anupama");
  // explicit episode id inside a channel-qualified show id needs no network
  assert.equal(
    await _test.pathForStreamId(`dts:show:star-plus~anupama:${pid}`),
    `/anupama/${pid}/`
  );
  // the flat form still works the same way
  assert.equal(await _test.pathForStreamId(`dts:show:anupama:${pid}`), `/anupama/${pid}/`);
  // unresolvable selection returns a string, never throws
  assert.equal(typeof (await _test.pathForStreamId("dts:show:star-plus~anupama:zzz")), "string");
});

test("hub channel detection is slug-scoped", () => {
  const html = `
    <nav><a href="/category/star-plus/">Star Plus</a><a href="/category/zee-tv/">Zee TV</a></nav>
    <a href="/category/and-tv/bhabiji-ghar-par-hain/">Bhabiji</a>
    <h1>Bhabiji Ghar Par Hain</h1>
    <img src="/media-cache/abc.jpg">`;
  // site nav links /category/star-plus/ first: without the slug we get the nav channel
  assert.equal(_test.parseShowHub(html).channel, "star-plus");
  // with the slug we get the channel that actually hosts the show
  assert.equal(_test.parseShowHub(html, "bhabiji-ghar-par-hain").channel, "and-tv");
  assert.equal(_test.parseShowHub(html, "bhabiji-ghar-par-hain").name, "Bhabiji Ghar Par Hain");
  // unknown slug falls back to the old behaviour instead of failing
  assert.equal(_test.parseShowHub(html, "some-other-show").channel, "star-plus");
});

test("snapshot rows keep their poster (iso date must not be read as an image)", () => {
  // the built index writes [segment, publicId, "YYYY-MM-DD", "xx/<md5>.jpg"] —
  // reading row[2] as the image made every episode outside the hub's first page
  // render its date as a poster (media-cache/2025-12-27).
  const rows = _test.parseEpisodesPayload([
    ["naagin-7-27th-december-2025-full-episode-colors-tv", "aa66c8d57e5c4a41", "2025-12-27", "aa/aa8018bf.jpg"],
    ["old-shape-episode-full-episode-star-plus", "0123456789abcdef", "bb/bb1234.jpg"],
    ["broken-row"],
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].iso, "2025-12-27");
  assert.equal(rows[0].image, "https://www.desitashan.su/media-cache/aa/aa8018bf.jpg");
  assert.equal(rows[1].iso, "");
  assert.equal(rows[1].image, "https://www.desitashan.su/media-cache/bb/bb1234.jpg");
  assert.ok(!/media-cache\/\d{4}-\d{2}-\d{2}/.test(rows[0].image));
});

test("iso dates come from the snapshot instead of being re-derived from the slug", () => {
  const rows = _test.parseEpisodesPayload([
    ["mystery-show-3rd-january-2026-full-episode-colors-tv", "ad49a1c96e7c0d97", "2026-01-03", "aa/x.jpg"],
  ]);
  assert.equal(rows[0].iso, "2026-01-03");
  assert.equal(_test.segInfo(rows[0].seg, "mystery-show").iso, "2026-01-03");
});
