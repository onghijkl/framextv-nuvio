# PvrPlay Catalogs — Cloudflare Worker addon

Home-screen catalog rows for Nuvio, sourced from PvrPlay's own lists. Because
PvrPlay only lists titles it carries, everything in these rows should resolve
to a playable stream.

This is a **Stremio-protocol addon**, not a Nuvio plugin. It installs under
**Settings → Addons**, and it sits alongside the metadata addon (TMDB Addon /
Cinemeta) — it does not replace it.

---

## Deploy (5 minutes, free, no card)

1. Sign in / sign up at <https://dash.cloudflare.com> (free plan)
2. In the sidebar: **Workers & Pages** → **Create** → **Create Worker**
3. Give it a name, e.g. `pvrplay-catalogs` → **Deploy**
4. Click **Edit code**
5. **Delete everything** in the editor and paste the whole of
   [`worker.js`](./worker.js)
6. **Deploy** (top right)

Your addon URL is then:

```
https://pvrplay-catalogs.<your-subdomain>.workers.dev/manifest.json
```

`<your-subdomain>` is shown on the Worker's page. You can also just open the
`*.workers.dev` URL in a browser — you should see the manifest JSON.

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
