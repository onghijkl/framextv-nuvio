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

test("series manifest exposes channel + updates rows", () => {
  const m = _test.dssManifest("https://example.test");
  assert.equal(m.id, "org.pvrplay.desitashan.series");
  assert.match(m.version, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(m.resources, ["catalog", "meta", "stream"]);
  assert.ok(m.types.includes("series"));
  const ids = m.catalogs.map((c) => c.id);
  assert.deepEqual(ids, ["dss:by-channel", "dss:updates", "dss:search"]);
  assert.equal(m.catalogs[0].type, "series");
  assert.equal(m.catalogs[1].type, "movie");
  assert.notEqual(m.id, _test.dtsManifest("https://example.test").id);
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
