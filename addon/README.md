# PvrPlay Catalogs — Cloudflare Worker addon

Home-screen catalog rows for Nuvio, sourced from PvrPlay's own lists. Because
PvrPlay only lists titles it carries, everything in these rows should resolve
to a playable stream.

This is a **Stremio-protocol addon**, not a Nuvio plugin. It installs under
**Settings → Addons**, and it sits alongside the metadata addon (TMDB Addon /
Cinemeta) — it does not replace it.

---

## Deploy (free, no card)

There are two ways. **Route A is what this repository is currently set up for.**

### Route A — Cloudflare Pages (connected to this repo)

Cloudflare's "Create application → connect a Git repository" flow creates a
**Pages** project, not a Worker. Pages serves a repository as static files; it
runs code only from a `_worker.js` placed in the project's **output directory**.

That is why [`_worker.js`](./_worker.js) lives in this directory: the
Pages output directory must be set to `addon`, so that file is picked up
automatically and takes over every request. It serves the addon routes and
forwards everything else to `env.ASSETS`.

Setup:

1. <https://dash.cloudflare.com> → **Workers & Pages** → **Create application**
2. Connect the Git repository, pick **`framextv-nuvio`**
3. Set the **build output directory** to:

   ```
   addon
   ```

   This is required. `_worker.js` must sit in the output directory, and it
   lives in `addon/`.
4. Deploy

Addon URL:

```
https://pvrplay-catalogs.pages.dev/manifest.json
```

Use the bare production domain. A `https://<hash>.pvrplay-catalogs.pages.dev`
URL is a per-commit *preview* and will change on every push.

### Route B — Cloudflare Worker

`wrangler.toml` at the repository root is already configured for this
(`main = "addon/worker.js"`), so a Worker can be deployed from the same repo
with no build step.

1. Create a **Worker** (not Pages) and connect the repository, or run
   `npx wrangler deploy` locally
2. URL becomes `https://pvrplay-catalogs.<subdomain>.workers.dev/manifest.json`

Either way, open the URL in a browser first — you should see JSON beginning
`{"id":"org.ong.pvrplay.catalogs"`. If you instead see `{"name":"ong's Repo"`,
the deployment is serving the repository as static files and the `_worker.js`
is not being executed.

### Route C — paste into the dashboard (no Git)

1. **Create application** → pick a simple **Worker** template → **Deploy**
2. **Edit code** → select all, delete, paste [`worker.js`](./worker.js)
3. **Deploy**

### Install in Nuvio

**Settings → Addons** → paste the manifest URL above.

You should get 11 new rows:

| Row | Type | Items |
|---|---|---|
| PvrPlay Trending | movie | 14 |
| PvrPlay Trending | series | 5 |
| PvrPlay Movies | movie | 20 |
| PvrPlay TV Shows | series | 20 |
| PvrPlay Netflix | movie | 20 |
| PvrPlay Prime Video | movie | 20 |
| PvrPlay Disney+ | movie | 20 |
| PvrPlay Apple TV+ | movie | 20 |
| PvrPlay Hulu | movie | 20 |
| PvrPlay Max | movie | 20 |
| PvrPlay Paramount+ | movie | 4 |

---

## How it works

PvrPlay is a Next.js app. Its lists are server-rendered into the React Server
Component payload — the `self.__next_f.push(...)` chunks embedded in the HTML.
That payload carries **complete TMDB objects**, so there is no markup scraping
and no API key involved: the Worker locates the item array by key name and
reads it.

Item ids are emitted as `tmdb:<id>`. Nuvio strips that prefix before calling
local scrapers (`PluginContentIds.kt`), so tapping a row here resolves straight
into the **frameXTV** and **PvrPlay** stream providers in this repo.

### Endpoints

```
GET /manifest.json
GET /catalog/<type>/<id>.json
GET /catalog/<type>/<id>/<extra>.json     extra params ignored
```

All responses carry `Access-Control-Allow-Origin: *` and a 10-minute cache.

---

## Maintenance

**The upstream host is a rotating subdomain.** `PVR_BASE` at the top of
`worker.js` currently points at:

```
https://dbhnmkjasgbvsdkjbskkvnskjbfckldsnckjbckjnxkjcsknxjvkjxnvcxknvku.pvrplay.fun
```

If the rows go empty, PvrPlay has likely moved. Find the new subdomain (it
redirects from `pvrplay.fun`) and update that one constant, then redeploy.

**Catalog definitions** live in the `CATALOGS` array — add or remove entries
there to change which rows appear. Each entry names the PvrPlay path and the
payload array to read (`initialItems`, `initialMovies` or `initialShows`).

### Adding a catalog

```js
{ id: "pvr-crime", path: "/genre/80", key: "initialItems",
  name: "PvrPlay Crime", types: ["movie"] }
```

Then bump `version` in the manifest if you want Nuvio to re-fetch.

---

## Testing locally

The Worker is a plain ES module, so Node can run it directly:

```bash
cp worker.js worker.mjs
node -e '
  const m = await import("./worker.mjs");
  const r = await m.default.fetch(new Request("https://x/manifest.json"));
  console.log(await r.text());
' --input-type=module
```

Or just point a browser at your deployed `workers.dev` URL.

---

## Licence

GPL-3.0, matching the rest of this repository.
