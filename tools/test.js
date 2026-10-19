#!/usr/bin/env node
/**
 * Local test harness for the frameXTV provider. Not part of the shipped addon.
 *
 *   node tools/test.js 1288069 movie
 *   node tools/test.js 22980 tv 1 1
 *   node tools/test.js 550 movie --direct
 */

const path = require("path");

const args = process.argv.slice(2);
const direct = args.includes("--direct");
const rest = args.filter((a) => !a.startsWith("--"));
const tmdbId = rest[0] || "1288069";
const mediaType = rest[1] || "movie";
const season = rest[2] || 1;
const episode = rest[3] || 1;

const mod = require(path.join(__dirname, "..", "providers", "framextv.js"));
const { getStreams } = mod;
getStreams.direct = direct;

console.log(`[test] getStreams(${tmdbId}, ${mediaType}, ${season}, ${episode}) direct=${direct}`);

const started = Date.now();
getStreams(tmdbId, mediaType, season, episode)
  .then((streams) => {
    const ms = Date.now() - started;
    console.log(`[test] ${streams.length} stream(s) in ${ms}ms\n`);
    streams.forEach((s, i) => {
      console.log(`${i + 1}. ${s.name} | ${s.title}`);
      console.log(`   quality : ${s.quality}`);
      console.log(`   size    : ${s.size}`);
      console.log(`   url     : ${s.url}`);
      console.log(`   subs    : ${(s.subtitles || []).length}`);
      console.log("");
    });
    if (!streams.length) {
      console.log(
        "[test] empty result. Expected when frameXTV does not carry the title, " +
          "or when the title exists under a different id."
      );
    }
  })
  .catch((err) => {
    console.error("[test] FAILED — getStreams must never throw:", err);
    process.exit(1);
  });