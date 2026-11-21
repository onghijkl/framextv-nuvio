import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const list = readdirSync(join(root, "providers")).filter((f) => f.endsWith(".js"));

// A bad string-replace once spliced a doc comment into the middle of a
// function header, commenting out `prepareSource` (and its body) entirely.
// The file still parsed, so the only symptom was 0 streams at runtime.
const SPLICE_MARKERS = [/tfunction/, /\}he first/, /\/\* -{4,}function/];

function load(file) {
  const src = readFileSync(join(root, "providers", file), "utf8");
  const sandbox = {
    console,
    fetch: () => Promise.reject(new Error("network disabled in tests")),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
    URLSearchParams,
    TextDecoder,
    TextEncoder,
    AbortController,
    Promise,
    JSON,
    Math,
    Date,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.runInNewContext(src, sandbox, { filename: file });
  return { src, sandbox };
}

for (const file of list) {
  test(`${file} has no comment-splice artifacts`, () => {
    const src = readFileSync(join(root, "providers", file), "utf8");
    for (const marker of SPLICE_MARKERS) {
      assert.ok(!marker.test(src), `${file} contains splice artifact ${marker}`);
    }
  });

  test(`${file} defines prepareSource at runtime`, () => {
    const { sandbox } = load(file);
    assert.equal(typeof sandbox.prepareSource, "function", "prepareSource is not callable");
    assert.equal(typeof sandbox.embeddedHls, "function", "embeddedHls is not callable");
  });

  test(`${file} still exports its provider global`, () => {
    const { sandbox } = load(file);
    const keys = Object.keys(sandbox).filter((k) => /^__ONGserv\d$/.test(k));
    assert.equal(keys.length, 1, `expected one provider global, got ${keys.join(",")}`);
    assert.equal(typeof sandbox[keys[0]].getStreams, "function");
  });
}

test("every src/<name>/index.js exposes prepareSource", () => {
  for (const name of ["framextv", "pvrplay", "vidlink"]) {
    const src = readFileSync(join(root, "src", name, "index.js"), "utf8");
    assert.match(src, /^function prepareSource\(s\) \{/m, `${name} missing prepareSource definition`);
  }
});