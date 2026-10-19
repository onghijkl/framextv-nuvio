#!/usr/bin/env node
/**
 * Build: src/framextv/index.js -> providers/framextv.js
 *
 * Mirrors the reference Nuvio plugin repo (esbuild -> es2020). If esbuild is
 * not installed, falls back to a plain copy, which is valid here because the
 * provider is already a single dependency-free file targeting es2020.
 *
 *   node tools/build.js
 */

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const entry = path.join(root, "src", "framextv", "index.js");
const outDir = path.join(root, "providers");
const outFile = path.join(outDir, "framextv.js");

fs.mkdirSync(outDir, { recursive: true });

/** Strips console.* calls — banned in shipped provider code. */
function stripConsole(code) {
  return code
    .split("\n")
    .filter((line) => !/^\s*console\.(log|warn|error|info|debug)\s*\(/.test(line))
    .join("\n");
}

// No timestamp: a build that changes on every run would make CI's
// "is providers/ in sync with src/" check fail permanently.
function banner() {
  return (
    "/**\n" +
    " * framextv - built from src/framextv/index.js\n" +
    " * Regenerate with: node tools/build.js\n" +
    " */\n"
  );
}

function buildWithEsbuild() {
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
    banner: { js: banner() }
  });
  return "esbuild";
}

let method = buildWithEsbuild();
if (!method) {
  const code = fs.readFileSync(entry, "utf8");
  fs.writeFileSync(outFile, banner() + stripConsole(code));
  method = "copy (esbuild unavailable)";
}

console.log(`[build] ${method} -> ${path.relative(root, outFile)}`);

// Validate: the built file must export getStreams and contain no console calls.
const built = fs.readFileSync(outFile, "utf8");
const problems = [];
if (!/getStreams/.test(built)) problems.push("getStreams export missing");
if (/console\.(log|warn|error|info|debug)\s*\(/.test(built)) problems.push("console.* present");

try {
  const mod = require(outFile);
  if (typeof mod.getStreams !== "function") problems.push("require() did not yield a getStreams function");
} catch (e) {
  problems.push("require() failed: " + e.message);
}

if (problems.length) {
  console.error("[build] validation failed:");
  problems.forEach((p) => console.error("  - " + p));
  process.exit(1);
}
console.log("[build] validation passed (getStreams exported, no console calls)");