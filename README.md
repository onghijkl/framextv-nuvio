# frameXTV — Nuvio repository

A [Nuvio](https://github.com/NuvioMedia/NuvioMobile) local-scraper provider that
resolves movies and series to frameXTV (`https://framextv.cc`) streams.
The repository also carries two more providers and a Stremio addon Worker.

Provider catalogue: [`manifest.json`](./manifest.json)

---

## Install

Plugins require the **sideloaded** Nuvio build — App Store / Play Store versions
do not support them.

1. Open Nuvio → **Settings → Content & Discovery → Plugins**
2. **Add Repository**
3. Paste the raw manifest URL for this repo (Codeberg):

   ```
   https://codeberg.org/<your-user>/framextv-nuvio/raw/branch/main/manifest.json
   ```

   On GitHub the equivalent is:

   ```
   https://raw.githubusercontent.com/<your-user>/framextv-nuvio/main/manifest.json
   ```

4. Refresh the provider list, then **enable** `frameXTV`.
   Adding the repository alone does not enable its providers.

---

## Layout

```
framextv-nuvio/
├── src/<name>/index.js      provider source — edit this
│                            (framextv, pvrplay, vidlink)
├── providers/<name>.js      built output — this is what Nuvio loads
├── manifest.json            provider registry read by Nuvio
├── addon/worker.js          Stremio addon + HLS playlist filter (Cloudflare)
├── addon/_worker.js         Cloudflare Pages entry point
├── tools/build.js           src → providers, with validation
├── tools/parse.test.js      offline tests for the parsers (no network)
├── tools/test.js            runs a built provider against live data
└── .github/workflows/       validates on every push
```

`providers/framextv.js` is committed on purpose: Nuvio fetches it directly over
a raw URL, so the repository must always contain a ready-to-run file.

---

## Develop

```bash
node tools/parse.test.js         # offline tests — no network, run these first
node tools/build.js              # build + validate
node tools/test.js 1288069 movie # test a movie (hits the live site)
node tools/test.js 1396 tv 1 1   # test an episode
node tools/test.js 550 movie --provider=pvrplay
```

`parse.test.js` is the one that fails when the code regresses; `test.js` fails
when an upstream site moves.

---

## How it works

1. `getStreams(tmdbId, mediaType, season, episode)` is called by Nuvio.
2. TMDB is queried for the title, year and IMDb id.
3. frameXTV's search index is consulted to recover the id the site actually
   uses for that title (exact title match only, ±1 year tolerance).
4. A real extraction is attempted via the site's stream API. This is the
   decisive existence check — the search index covers all of TMDB and so
   proves nothing on its own.
5. Each candidate source is fetched once to drop dead links, and a master
   advertising HEVC or an over-cap rendition is routed through the playlist
   filter in `addon/worker.js`.

### Runtime limits

The provider runs inside Nuvio's sandboxed QuickJS engine. That sandbox's
`fetch()` is not a browser fetch — there is no origin and no preflight — and
the extracted playlists sit behind a CDN proxy that sends
`Access-Control-Allow-Origin: *` anyway, so the provider returns those direct
HLS sources. The `/embed/` page is **not** emitted: it is HTML, and a native
player rejects it with "unrecognized file format".

QuickJS constraints the provider respects:

- native `async`/`await`, `fetch()` available
- no Node built-ins (`fs`, `path`, `crypto`, `Buffer`)
- no WebAssembly
- no `console.*` in shipped code
- `getStreams` never throws — it returns `[]` on every failure path

---

## Notes on correctness

Two failure modes were found while testing this against the live site, and both
are easy to reintroduce:

**Parameter name.** The stream API requires `id`, not `tmdb_id`. With the wrong
name it answers `{"success":false,"error":"Missing required 'id' parameter"}`.
Because the provider treats a failed check as "unknown" rather than "no", a
wrong parameter name makes every availability check silently pass. Any change
to the API call must be re-verified with the negative test cases below.

**Title matching.** Substring matching makes `Fight Club` match
`Jurassic Fight Club`. Matching is exact on title, with type and year
corroboration.

Run the negative cases before shipping any change:

```bash
node tools/test.js 999999 movie   # nonexistent id
node tools/test.js 550 movie      # Fight Club — must not match other clubs
```

---

## Disclaimer

This repository contains no media. Providers fetch stream URLs from
third-party sites exactly as a browser would; nothing is hosted here. Use is
entirely at your own risk and subject to the laws of your jurisdiction.

## Licence

GPL-3.0