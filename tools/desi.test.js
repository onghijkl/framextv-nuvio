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
