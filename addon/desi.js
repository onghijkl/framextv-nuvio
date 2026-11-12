/**
 * Desi Serials — Stremio / Nuvio catalog addon for https://www.desi-serials.to
 *
 * Mounted by addon/worker.js under the /desi path prefix.
 *   manifest : /desi/manifest.json
 *   catalog  : /desi/catalog/{type}/{id}.json
 *   meta     : /desi/meta/{type}/{id}.json
 *   stream   : /desi/stream/{type}/{id}.json
 *   relay    : /desi/p?u=<base64url(m3u8 url)>
 *
 * Content model
 *   series meta  -> dser:ser:<path>            path = watch-online path, "/" -> "~"
 *   episode meta -> dser:ep:<postId>
 *
 * Streams: the site embeds players from tvarticles.org which resolve to a
 * JuicyCodes HLS url (einsteinium.tvlogy.to/.../video.m3u8?token=...). The
 * playlist is locked to the user-agent embedded in the token plus a
 * Referer of tvarticles.org, so playlists are relayed through this worker.
 * Media segments need no headers and are served straight from the CDN.
 */

const SITE = 'https://www.desi-serials.to';
const SITE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const PLAYER_REF = 'https://tvarticles.org/';
const PREFIX = 'dser';

const CHANNELS = [
  { id: 'star-plus', name: 'Star Plus', path: '/star-plus-hdepisodes/' },
  { id: 'zee-tv', name: 'Zee TV', path: '/zee-tv/' },
  { id: 'sony-tv', name: 'Sony TV', path: '/sony-tv/' },
  { id: 'color-tv', name: 'Colors TV', path: '/color-tv-hd/' },
  { id: 'star-bharat', name: 'Star Bharat', path: '/star-bharat/' },
  { id: 'sab-tv', name: 'Sab TV', path: '/sab-tv-hd/' },
  { id: 'and-tv', name: '& TV', path: '/and-tv/' },
];

/* ------------------------------------------------------------------ utils */

const MEM = new Map();

function b64urlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function decodeEntities(s) {
  return s
    .replace(/&#8217;|&#039;|&#39;/g, "'")
    .replace(/&#8220;|&#8221;/g, '"')
    .replace(/&#8211;/g, '-')
    .replace(/&#8230;/g, '...')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

function text(s) {
  return decodeEntities(String(s || '').replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

function absolute(u) {
  if (!u) return '';
  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith('//')) return 'https:' + u;
  return SITE + (u.startsWith('/') ? u : '/' + u);
}

/** WordPress thumbnail -> original upload */
function bigImage(u) {
  if (!u) return '';
  return u.replace(/-(\d{2,4})x(\d{2,4})(\.(?:jpe?g|png|webp|gif))$/i, '$3');
}

function json(obj, maxAge = 300) {
  return new Response(JSON.stringify(obj), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': `public, max-age=${maxAge}`,
    },
  });
}

function memGet(key, ttl) {
  const hit = MEM.get(key);
  if (hit && hit.exp > Date.now()) return hit.v;
  return null;
}

function memSet(key, v, ttl) {
  if (MEM.size > 240) MEM.clear();
  MEM.set(key, { v, exp: Date.now() + ttl });
  return v;
}

async function fetchHtml(url, ttlMs = 10 * 60 * 1000, referer = '') {
  const key = referer ? `${referer}|${url}` : url;
  const cached = memGet(key, ttlMs);
  if (cached) return cached;
  const headers = {
    'User-Agent': SITE_UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  };
  if (referer) headers.Referer = referer;
  const res = await fetch(url, {
    headers,
    redirect: 'follow',
    cf: { cacheTtl: 120, cacheEverything: true },
  });
  if (!res.ok) throw new Error(`upstream ${res.status} ${url}`);
  const body = await res.text();
  return memSet(key, body, ttlMs);
}

/* --------------------------------------------------------------- parsers */

/** Series cards from a channel page. */
function parseSeriesCards(html) {
  const out = [];
  const seen = new Set();
  const src = String(html);
  const re = /<a[^>]*porto-sicon-title-link[^>]*>/g;
  let m;
  while ((m = re.exec(src))) {
    const tag = m[0];
    const href = (tag.match(/href=['"]([^'"]+)['"]/) || [])[1] || '';
    const pm = href.match(/\/watch-online\/(.+?)\/?$/);
    if (!pm) continue;
    const path = pm[1];
    if (!path || seen.has(path)) continue;
    const tail = src.slice(m.index + tag.length);
    const name = text((tail.match(/^([\s\S]*?)<\/a>/) || [])[1]);
    if (!name) continue;
    const before = src.slice(Math.max(0, m.index - 900), m.index);
    const img = (before.match(/<img[^>]*img-icon[^>]*?src=['"]([^'"]+)['"]/) || [])[1] || '';
    seen.add(path);
    out.push({
      id: `${PREFIX}:ser:${path.split('/').join('~')}`,
      type: 'series',
      name,
      poster: bigImage(absolute(img)),
      posterShape: 'landscape',
      description: `${name} — full episodes from desi-serials.to`,
    });
  }
  return out;
}

/** Episode list from a series page (/watch-online/<path>/page/N/). */
function parseEpisodes(html) {
  const out = [];
  const re = /<article[^>]*class="[^"]*post-(\d+)[^"]*"[^>]*>([\s\S]*?)<\/article>/g;
  let m;
  while ((m = re.exec(String(html)))) {
    const postId = m[1];
    const body = m[2];
    const link = (body.match(/href="(https?:\/\/[^"]*desi-serials[^"]*)"/) || [])[1] || '';
    let title = text((body.match(/post-title[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/) || [])[1]);
    if (!title) title = text((body.match(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/) || [])[1]);
    const date = (body.match(/<time[^>]*datetime="([^"]+)"/) || [])[1] || '';
    if (!title) continue;
    out.push({ id: `${PREFIX}:ep:${postId}`, postId, title, link, date: titleDate(title) || date });
  }
  return out;
}

/** Episode page: title, art, players. */
function parseEpisodePage(html) {
  const h = String(html);
  const ogImage = (h.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) || [])[1] || '';
  const ogTitle = (h.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) || [])[1] || '';
  const h1 = text((h.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1]);
  const published = (h.match(/article:published_time["'][^>]+content=["']([^"']+)["']/i) || [])[1] || '';
  const players = [];
  const seen = new Set();
  const pre = /(https?:\/\/[a-z0-9.-]+\.(?:org|to|com|net)\/[a-z0-9_-]*vidd[a-z0-9_-]*\.php\?id=\d+)/gi;
  let m;
  while ((m = pre.exec(h))) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    players.push(m[1]);
  }
  return { title: h1 || text(ogTitle), image: ogImage, published, players };
}

function unpackPacker(js) {
  const m = String(js).match(/}\s*\(\s*'([\s\S]*?)',\s*(\d+)\s*,\s*(\d+)\s*,\s*'([\s\S]*?)'\.split\('\|'\)/);
  if (!m) return null;
  const src = m[1];
  const base = parseInt(m[2], 10);
  const count = parseInt(m[3], 10);
  const words = m[4].split('|');
  const enc = (n) => {
    let s = '';
    for (;;) {
      const d = n % base;
      s = (d > 35 ? String.fromCharCode(d + 29) : d.toString(36)) + s;
      n = Math.floor(n / base);
      if (n === 0) return s;
    }
  };
  const dict = {};
  for (let i = count - 1; i >= 0; i--) dict[enc(i)] = words[i] && words[i].length ? words[i] : enc(i);
  return src.replace(/\b([0-9A-Za-z]+)\b/g, (t) => (Object.prototype.hasOwnProperty.call(dict, t) ? dict[t] : t));
}

/** All text flavours of a player page: raw, JuicyCodes-decoded, un-packed. */
function textVariants(html) {
  const h = String(html);
  const out = [h];
  const juicy = h.match(/JuicyCodes\.Run\(([\s\S]*?)\)\s*;?\s*<\/script>/);
  if (juicy) {
    const b64 = (juicy[1].match(/"([^"]*)"/g) || []).map((s) => s.slice(1, -1)).join('');
    try {
      const decoded = atob(b64);
      out.push(decoded);
      const unpacked = unpackPacker(decoded);
      if (unpacked) out.push(unpacked);
    } catch (e) { /* not base64 after all */ }
  }
  return out.map((s) => s.replace(/\\\//g, '/'));
}

/** Pull the HLS url out of a player/embed page. */
function extractM3u8(html) {
  for (const v of textVariants(html)) {
    const m = v.match(/https?:\/\/[^\s"'<>\\]*\.m3u8[^\s"'<>\\]*/i);
    if (m) return m[0];
  }
  return null;
}

/** The flow.tvlogy.to/<skin>/<token> embed that actually carries the playlist. */
function extractEmbed(html) {
  for (const v of textVariants(html)) {
    const m = v.match(/https?:\/\/flow\.tvlogy\.to\/[a-z0-9]+\/[A-Za-z0-9_-]+/i)
      || v.match(/["'](?:https?:)?\/\/([a-z0-9-]+\.tvlogy\.to)\/(plyr0?1|nflix|embed0?1)\/([A-Za-z0-9_-]+)/i);
    if (m) return m[0].startsWith('http') ? m[0] : `https://${m[1]}/${m[2]}/${m[3]}`;
  }
  return null;
}

/** The token is base64(userAgent + "||" + ips). */
function uaFromToken(url) {
  try {
    const token = new URL(url).searchParams.get('token');
    if (!token) return SITE_UA;
    const raw = b64urlDecode(token.replace(/=+$/, ''));
    const ua = raw.split('||')[0].trim();
    return ua.length > 20 && /\//.test(ua) ? ua : SITE_UA;
  } catch (e) {
    return SITE_UA;
  }
}

/* -------------------------------------------------------------- manifest */

export function desiManifest(origin) {
  const catalogs = [
    { type: 'movie', id: 'latest', name: 'Desi Serials — Latest Episodes' },
    ...CHANNELS.map((c) => ({ type: 'series', id: c.id, name: `Desi Serials — ${c.name}` })),
    {
      type: 'series',
      id: 'search',
      name: 'Desi Serials — Search',
      extra: [{ name: 'search', isRequired: true }],
    },
  ];
  return {
    id: 'org.ongserv.desiserials',
    version: '1.0.0',
    name: 'Desi Serials',
    description:
      'Indian TV serials and daily episodes from desi-serials.to — Star Plus, Zee TV, Sony TV, Colors, Star Bharat, Sab TV and & TV.',
    logo: `${origin}/desi/logo.png`,
    background: `${origin}/desi/logo.png`,
    resources: [
      { name: 'catalog', types: ['movie', 'series'] },
      { name: 'meta', types: ['movie', 'series'], idPrefixes: [PREFIX + ':'] },
      { name: 'stream', types: ['movie', 'series'], idPrefixes: [PREFIX + ':'] },
    ],
    types: ['movie', 'series'],
    catalogs,
    behaviorHints: { adult: false, p2p: false, configurable: false },
  };
}

/* --------------------------------------------------------------- catalogs */

/** Latest episode posts from the WordPress RSS feed. */
async function latestEpisodes(query = '') {
  const xml = await fetchHtml(`${SITE}/feed/`, 5 * 60 * 1000);
  const items = [...String(xml).matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);
  const rows = [];
  for (const it of items) {
    const title = text((it.match(/<title>([\s\S]*?)<\/title>/) || [])[1]);
    const link = text((it.match(/<link>([\s\S]*?)<\/link>/) || [])[1]);
    const pub = text((it.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1]);
    const postId = (link.match(/(\d+)\/?$/) || [])[1];
    if (!title || !postId) continue;
    rows.push({ postId, title, link, published: pub ? new Date(pub).toISOString() : '' });
  }
  const filtered = query
    ? rows.filter((r) => r.title.toLowerCase().includes(query.toLowerCase()))
    : rows;
  return Promise.all(
    filtered.slice(0, 20).map(async (r) => {
      let image = '';
      try {
        const page = await fetchHtml(r.link || `${SITE}/?p=${r.postId}`, 30 * 60 * 1000);
        image = (page.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) || [])[1] || '';
      } catch (e) {
        /* poster is optional */
      }
      return {
        id: `${PREFIX}:ep:${r.postId}`,
        type: 'movie',
        name: r.title,
        poster: image,
        posterShape: 'landscape',
        description: r.title,
        releaseInfo: r.published ? r.published.slice(0, 10) : '',
      };
    })
  );
}

/** Series index (all channel pages), cached for six hours. */
async function seriesIndex() {
  const cached = memGet('idx', 0);
  if (cached) return cached;
  const pages = await Promise.all(
    CHANNELS.map(async (c) => {
      try {
        const html = await fetchHtml(SITE + c.path, 6 * 60 * 60 * 1000);
        return parseSeriesCards(html, c.id);
      } catch (e) {
        return [];
      }
    })
  );
  const all = [];
  const seen = new Set();
  for (const list of pages) {
    for (const s of list) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      all.push(s);
    }
  }
  return memSet('idx', all, 6 * 60 * 60 * 1000);
}

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function handleCatalog(type, id, url) {
  const search = (url.searchParams.get('search') || '').trim();
  const skip = parseInt(url.searchParams.get('skip') || '0', 10) || 0;

  if (id === 'latest') {
    const metas = await latestEpisodes(search);
    return json({ metas: metas.slice(skip) }, 300);
  }

  if (id === 'search') {
    if (!search) return json({ metas: [] }, 60);
    const q = normalize(search);
    const index = await seriesIndex();
    const metas = index
      .filter((s) => q.split(' ').every((tok) => normalize(s.name).includes(tok)))
      .map((s) => ({ id: s.id, type: 'series', name: s.name, poster: s.poster, posterShape: 'landscape' }));
    return json({ metas: metas.slice(skip) }, 300);
  }

  const channel = CHANNELS.find((c) => c.id === id);
  if (!channel) return json({ metas: [] }, 60);
  const html = await fetchHtml(SITE + channel.path, 60 * 60 * 1000);
  const metas = parseSeriesCards(html, channel.id).map((s) => ({
    id: s.id,
    type: 'series',
    name: s.name,
    poster: s.poster,
    posterShape: 'landscape',
    description: s.description,
  }));
  return json({ metas: metas.slice(skip) }, 3600);
}

/* ------------------------------------------------------------------ meta */

function seriesPathFromId(id) {
  const rest = id.slice(`${PREFIX}:ser:`.length);
  return rest.split('~').join('/');
}

async function seriesPoster(path) {
  const index = await seriesIndex();
  const key = `${PREFIX}:ser:${path.split('/').join('~')}`;
  const hit = index.find((s) => s.id === key);
  if (hit && hit.poster) return hit.poster;
  try {
    const html = await fetchHtml(`${SITE}/watch-online/${path}/`, 6 * 60 * 60 * 1000);
    const first = parseEpisodes(html)[0];
    if (first) {
      const page = await fetchHtml(first.link || `${SITE}/?p=${first.postId}`, 60 * 60 * 1000);
      return (page.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) || [])[1] || '';
    }
  } catch (e) {
    /* ignore */
  }
  return '';
}

/** "12th November 2026" -> 2026-11-12 (payload dates beat publish timestamps). */
const MONTHS = { january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6, august: 7, september: 8, october: 9, november: 10, december: 11 };
function titleDate(title) {
  const m = String(title).match(/(\d{1,2})(?:st|nd|rd|th)?\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i);
  if (!m) return '';
  const d = new Date(Date.UTC(+m[3], MONTHS[m[2].toLowerCase()], +m[1]));
  return isNaN(d) ? '' : d.toISOString().slice(0, 10);
}

function dayOfYear(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d)) return null;
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  const now = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return Math.floor((now - start) / 86400000) + 1;
}

async function handleMeta(type, id) {
  if (type === 'movie') {
    const postId = id.split(':').pop();
    const html = await fetchHtml(`${SITE}/?p=${postId}`, 30 * 60 * 1000);
    const ep = parseEpisodePage(html);
    return json(
      {
        meta: {
          id,
          type: 'movie',
          name: ep.title || `Desi Serials ${postId}`,
          poster: ep.image,
          background: ep.image,
          description: `${ep.title} — watch the full episode online from desi-serials.to.`,
          releaseInfo: ep.published ? ep.published.slice(0, 10) : '',
          behaviorHints: { defaultVideoId: id },
        },
      },
      600
    );
  }

  const path = seriesPathFromId(id);
  const name = path.split('/').pop().replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const pages = [1, 2, 3];
  const htmls = await Promise.all(
    pages.map((p) =>
      fetchHtml(`${SITE}/watch-online/${path}/${p > 1 ? `page/${p}/` : ''}`, 30 * 60 * 1000).catch(() => '')
    )
  );
  const episodes = [];
  const seen = new Set();
  for (const html of htmls) {
    for (const e of parseEpisodes(html)) {
      if (seen.has(e.postId)) continue;
      seen.add(e.postId);
      episodes.push(e);
    }
  }
  episodes.sort((a, b) => String(b.date).localeCompare(String(a.date)));

  const poster = await seriesPoster(path);
  const videos = episodes.map((e) => {
    const year = e.date ? new Date(e.date).getUTCFullYear() : new Date().getUTCFullYear();
    const season = isNaN(year) ? 1 : year;
    const doy = dayOfYear(e.date) || 1;
    return {
      id: e.id,
      title: e.title,
      season,
      episode: doy,
      released: e.date ? new Date(e.date).toISOString() : undefined,
      overview: e.title,
      thumbnail: poster,
    };
  });

  return json(
    {
      meta: {
        id,
        type: 'series',
        name,
        poster,
        background: poster,
        description:
          `${name} — ${videos.length} recent episodes available on desi-serials.to.\n\n` +
          `New episodes are added daily. Switch to the "Latest Episodes" catalogue for today's episodes.`,
        genres: ['Drama', 'Indian TV'],
        videos,
      },
    },
    600
  );
}

/* ---------------------------------------------------------------- streams */

async function resolveEpisodeStreams(postId, origin) {
  const page = await fetchHtml(`${SITE}/?p=${postId}`, 10 * 60 * 1000);
  const ep = parseEpisodePage(page);
  const players = ep.players.slice(0, 6);
  if (!players.length) return { streams: [], ep };

  const results = await Promise.all(
    players.map(async (p) => {
      try {
        const html = await fetchHtml(p, 10 * 60 * 1000, PLAYER_REF);
        let m3u8 = extractM3u8(html);
        if (!m3u8) {
          const embed = extractEmbed(html);
          if (!embed) return null;
          const embedHtml = await fetchHtml(embed, 10 * 60 * 1000, PLAYER_REF);
          m3u8 = extractM3u8(embedHtml);
        }
        return m3u8 ? { m3u8, player: p } : null;
      } catch (e) {
        return null;
      }
    })
  );

  const streams = [];
  const seen = new Set();
  for (const r of results) {
    if (!r) continue;
    const key = (r.m3u8.match(/token=([^&]+)/) || [])[1] || r.m3u8;
    if (seen.has(key)) continue;
    seen.add(key);
    streams.push({
      name: 'Desi Serials',
      title: '480p · Hindi',
      url: `${origin}/desi/p?u=${b64urlEncode(r.m3u8)}`,
      behaviorHints: { bingeGroup: 'desiserials', notWebReady: false },
    });
  }
  return { streams, ep };
}

async function handleStream(type, id, origin) {
  const postId = (id.match(/(\d+)$/) || [])[1];
  if (!postId) return json({ streams: [] }, 60);
  const { streams } = await resolveEpisodeStreams(postId, origin);
  return json({ streams }, 300);
}

/* ----------------------------------------------------------------- relay */

async function proxyPlaylist(targetUrl, origin) {
  let host;
  try {
    host = new URL(targetUrl).hostname;
  } catch (e) {
    return new Response('bad url', { status: 400 });
  }
  if (!/(^|\.)tvlogy\.to$/.test(host)) return new Response('forbidden', { status: 403 });

  const res = await fetch(targetUrl, {
    headers: {
      'User-Agent': uaFromToken(targetUrl),
      Referer: PLAYER_REF,
      Origin: 'https://tvarticles.org',
      Accept: '*/*',
    },
  });
  const body = await res.text();
  const headers = {
    'access-control-allow-origin': '*',
    'cache-control': 'public, max-age=20',
  };
  if (!body.trimStart().startsWith('#EXTM3U')) {
    return new Response(body, {
      status: res.ok ? 502 : res.status,
      headers: { ...headers, 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  const isRelay = (abs) => /\.m3u8(\?|$)/i.test(abs);
  const mapUrl = (abs) => (isRelay(abs) ? `${origin}/desi/p?u=${b64urlEncode(abs)}` : abs);

  const out = body
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trim();
      if (!t) return '';
      if (t.startsWith('#')) {
        if (t.includes('URI="')) {
          return t.replace(/URI="([^"]+)"/g, (_, uri) => {
            try {
              return `URI="${mapUrl(new URL(uri, targetUrl).toString())}"`;
            } catch (e) {
              return `URI="${uri}"`;
            }
          });
        }
        return t;
      }
      try {
        return mapUrl(new URL(t, targetUrl).toString());
      } catch (e) {
        return t;
      }
    })
    .join('\n');

  return new Response(out, {
    status: 200,
    headers: { ...headers, 'content-type': 'application/vnd.apple.mpegurl' },
  });
}
function landing(origin) {
  const m = `${origin}/desi/manifest.json`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Desi Serials — Nuvio / Stremio addon</title>
<style>
:root{color-scheme:dark}
body{margin:0;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
background:radial-gradient(1200px 600px at 50% -10%,#3b1d5e,#0b0b12 60%);color:#eee;
display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px}
.card{max-width:640px;width:100%;background:#15151f;border:1px solid #2a2a3a;border-radius:18px;padding:28px}
h1{margin:0 0 6px;font-size:26px}
p.sub{margin:0 0 20px;color:#9aa0b4}
a.btn{display:inline-block;background:linear-gradient(135deg,#7c3aed,#db2777);color:#fff;
text-decoration:none;padding:12px 20px;border-radius:12px;font-weight:600;margin:0 8px 8px 0}
code{background:#0d0d15;border:1px solid #2a2a3a;padding:3px 7px;border-radius:6px;font-size:13px;word-break:break-all}
ul{padding-left:18px;color:#c8ccda}
</style></head><body><div class="card">
<h1>Desi Serials</h1>
<p class="sub">Indian TV serials &amp; daily episodes from desi-serials.to — for Nuvio and Stremio.</p>
<a class="btn" href="stremio://${origin.replace(/^https?:\/\//, '')}/desi/manifest.json">Install in Stremio</a>
<p>Nuvio: <b>Add addon → Add by URL</b> and paste:</p>
<p><code>${m}</code></p>
<ul>
<li>Latest episodes (plays instantly)</li>
<li>Star Plus · Zee TV · Sony TV · Colors TV · Star Bharat · SAB TV · &amp;TV</li>
<li>Serial pages with the newest 45 episodes</li>
</ul>
<p class="sub">Streams are relayed through this worker (the source requires a fixed user-agent + referer).</p>
</div></body></html>`;
  return new Response(html, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=600' },
  });
}

/**
 * Router for the Desi Serials addon. Mounted at /desi/* by worker.js.
 * @param {Request} request
 * @param {URL} url
 * @param {string} origin e.g. https://pvrplay-catalogs.pages.dev
 */
export async function handleDesi(request, url, origin) {
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': 'GET,HEAD,OPTIONS',
  };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  let path = url.pathname.replace(/^\/desi/, '');
  if (!path.startsWith('/')) path = '/' + path;
  if (path === '') path = '/';

  try {
    if (path === '/') return landing(origin);
    if (path === '/manifest.json') return json(desiManifest(origin), 600);
    if (path === '/logo.png') {
      return new Response(null, {
        status: 302,
        headers: {
          location: 'https://www.desi-serials.to/wp-content/uploads/2020/09/152.png',
          'cache-control': 'public, max-age=86400',
        },
      });
    }

    if (path === '/p') {
      const u = url.searchParams.get('u');
      if (!u) return new Response('missing u', { status: 400, headers: cors });
      let target;
      try {
        target = b64urlDecode(u);
      } catch (e) {
        return new Response('bad u', { status: 400, headers: cors });
      }
      if (!/^https?:\/\/[a-z0-9.-]*tvlogy\.to\//i.test(target)) {
        return new Response('host not allowed', { status: 403, headers: cors });
      }
      return proxyPlaylist(target, origin);
    }

    const m = path.match(/^\/(catalog|meta|stream)\/(movie|series)\/(.+)\.json$/);
    if (m) {
      const [, kind, type, rawId] = m;
      const id = decodeURIComponent(rawId);
      if (kind === 'catalog') return handleCatalog(type, id, url);
      if (kind === 'meta') return handleMeta(type, id);
      return handleStream(type, id, origin);
    }

    return new Response('not found', { status: 404, headers: cors });
  } catch (err) {
    return new Response(JSON.stringify({ err: String((err && err.message) || err) }), {
      status: 502,
      headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' },
    });
  }
}
export const _test = {
  parseSeriesCards, parseEpisodes, parseEpisodePage, extractM3u8, extractEmbed,
  textVariants, titleDate, dayOfYear, uaFromToken, b64urlEncode, b64urlDecode,
};