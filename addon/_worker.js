/**
 * PvrPlay Catalogs — Cloudflare **Pages** entry point (advanced mode)
 *
 * Pages does not run a Worker from a repository; it serves the repo as static
 * files. To run code you place a `_worker.js` in the project's *output
 * directory*, and Pages then hands it every request.
 *
 * This file is that entry point. The deployable Worker source of truth is
 * ./worker.js — this file re-exports its behaviour and adds the static-asset
 * fallback that Pages requires.
 *
 * Pages project settings
 *   Build output directory: addon
 *
 * With that set, requests resolve like so:
 *   /manifest.json                    -> addon manifest (generated, not a file)
 *   /catalog/<type>/<id>.json         -> catalog data
 *   anything else                     -> static files in addon/, else 404
 *
 * NOTE: Pages serves static files first only in non-advanced mode. Here the
 * Worker sees every request, which is why /manifest.json can return generated
 * JSON even though the repository already has a manifest.json at its root
 * (that one is the Nuvio *plugin* registry, a different thing entirely).
 */

import worker from "./worker.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    // Only take over the addon's own routes; everything else is a static file.
    const isAddonRoute =
      path === "/" ||
      path === "/manifest.json" ||
      /^\/catalog\/[^/]+\/[^/]+?(?:\/[^/]*)?\.json$/.test(path);

    if (isAddonRoute) {
      return worker.fetch(request);
    }

    // Pages requires the Worker to forward anything it does not handle.
    if (env && env.ASSETS && typeof env.ASSETS.fetch === "function") {
      return env.ASSETS.fetch(request);
    }
    return new Response("Not found", { status: 404 });
  }
};
