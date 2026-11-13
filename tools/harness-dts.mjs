import { readFile } from "node:fs/promises";
import { handleDesiSeries, handleDesiTashan } from "/var/minis/shared/framextv-nuvio/repo-fixed/addon/desitashan.js";

const ORIGIN = "https://local.test";
const realFetch = globalThis.fetch.bind(globalThis);

globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  if (url.startsWith(`${ORIGIN}/dss-data/`)) {
    const file = "/var/minis/shared/framextv-nuvio/repo-fixed/addon" + url.slice(ORIGIN.length);
    try {
      const body = await readFile(file, "utf8");
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    } catch {
      return new Response("missing", { status: 404 });
    }
  }
  return realFetch(input, init);
};

async function hit(path, which = "dss") {
  const url = ORIGIN + path;
  const handler = which === "dss" ? handleDesiSeries : handleDesiTashan;
  const res = await handler(new Request(url), new URL(url), ORIGIN);
  if (!res) return { status: 0, body: null };
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text.slice(0, 160); }
  return { status: res.status, body };
}

const t0 = Date.now();
const out = await hit("/dss/manifest.json");
console.log("MANIFEST", out.status);
console.log("  name:", out.body.name, "| version:", out.body.version, "| types:", out.body.types);
for (const c of out.body.catalogs) console.log("   row:", c.type, c.id, "-", c.name);

for (const path of [
  "/dss/catalog/series/dss:spotlight.json",
  "/dss/catalog/series/dss:latest.json",
  "/dss/catalog/series/dss:ch:colors-tv.json",
  "/dss/catalog/series/dss:ch:bg.json",
  "/dss/catalog/series/dss:ch:bigg-boss-20.json",
  "/dss/catalog/series/dss:search.json?search=naagin",
  "/dss/catalog/series/dss:all.json",
]) {
  const r = await hit(path);
  const metas = r.body && r.body.metas ? r.body.metas : [];
  console.log(`\n${path} -> ${r.status} (${metas.length} cards)`);
  for (const m of metas.slice(0, 6)) {
    console.log(`   ${m.type} ${m.id} | ${m.name} | ${m.releaseInfo} | ${m.description}`);
  }
  if (path.includes("naagin")) console.log("   ids:", metas.map((m) => m.id).join(", "));
}

const meta = await hit("/dss/meta/series/dts:show:colors-tv~naagin-7.json");
const m = meta.body && meta.body.meta;
console.log(`\nMETA naagin-7 -> ${meta.status} type=${m && m.type} name=${m && m.name} videos=${m && m.videos.length}`);
if (m) {
  console.log("   poster:", m.poster);
  console.log("   first:", JSON.stringify(m.videos[0]));
  console.log("   last :", JSON.stringify(m.videos[m.videos.length - 1]));
}

const big = await hit("/dss/meta/series/dts:show:star-plus~anupama.json");
const bm = big.body && big.body.meta;
console.log(`\nMETA anupama -> ${big.status} videos=${bm && bm.videos.length} (index count 1016)`);

const stream = await hit("/dss/stream/series/" + encodeURIComponent(bm.videos[0].id) + ".json");
console.log("\nSTREAM first anupama ep ->", stream.status, JSON.stringify(stream.body).slice(0, 300));
console.log("\nelapsed ms", Date.now() - t0);
