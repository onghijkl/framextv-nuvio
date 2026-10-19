#!/usr/bin/env node
/**
 * Build every provider: src/<name>/index.js -> providers/<name>.js
 *
 * Mirrors the reference Nuvio plugin repo (esbuild -> es2020). If esbuild is
 * not installed, falls back to a plain copy, which is valid here because each
 * provider is already a single dependency-free file targeting es2020.
 *
 *   node tools/build.js            # build all
 *   node tools/build.js pvrplay    # build one
 */

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const srcDir = path.join(root, "src");
const outDir = path.join(root, "providers");

fs.mkdirSync(outDir, { recursive: true });

/** Strips console.* calls — banned in shipped provider code. */
function stripConsole(code) {
  return code
    .split("\n")
    .filter((line) => !/^\s*console\.(log|warn|error|info|debug)\s*\(/.test(line))
    .join("\n");
}

// No timestamp: a build that changes on every run would make the CI
// "is providers/ in sync with src/?" check fail permanently.
function banner(name) {
  return (
    "/**\n" +
    " * " + name + " - built from src/" + name + "/index.js\n" +
    " * Regenerate with: node tools/build.js\n" +
    " */\n"
  );
}

function buildWithEsbuild(entry, outFile, name) {
  let esbuild;
  try {
    esbuild = require("esbuild");
  } catch (e) {
    return null;
  }
  esbuild.buildSync({
    entryPoints: [entry],
    outfile: outFile,
    bundle: true,
    format: "iife",
    target: "es2020",
    platform: "neutral",
    banner: { js: banner(name) }
  });
  return "esbuild";
}

const only = process.argv[2];
const names = fs
  .readdirSync(srcDir)
  .filter((n) => fs.existsSync(path.join(srcDir, n, "index.js")))
  .filter((n) => !only || n === only);

if (!names.length) {
  console.error("[build] no providers found under src/");
  process.exit(1);
}

const problems = [];

for (const name of names) {
  const entry = path.join(srcDir, name, "index.js");
  const outFile = path.join(outDir, name + ".js");

  let method = buildWithEsbuild(entry, outFile, name);
  if (!method) {
    fs.writeFileSync(outFile, banner(name) + stripConsole(fs.readFileSync(entry, "utf8")));
    method = "copy (esbuild unavailable)";
  }
  console.log(`[build] ${name}: ${method} -> providers/${name}.js`);

  // Validate the built artefact.
  const built = fs.readFileSync(outFile, "utf8");
  if (!/getStreams/.test(built)) problems.push(`${name}: getStreams export missing`);
  if (/console\.(log|warn|error|info|debug)\s*\(/.test(built)) problems.push(`${name}: console.* present`);
  try {
    const mod = require(outFile);
    if (typeof mod.getStreams !== "function") problems.push(`${name}: require() did not yield getStreams`);
  } catch (e) {
    problems.push(`${name}: require() failed: ${e.message}`);
  }
}

// Every manifest entry must point at a built file.
try {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  for (const s of manifest.scrapers || []) {
    const f = path.join(root, s.filename);
    if (!fs.existsSync(f)) problems.push(`manifest: ${s.id} points at missing ${s.filename}`);
  }
} catch (e) {
  problems.push("manifest.json unreadable: " + e.message);
}

if (problems.length) {
  console.error("[build] validation failed:");
  problems.forEach((p) => console.error("  - " + p));
  process.exit(1);
}
console.log("[build] validation passed");