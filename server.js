const express = require('express');
const app = express();
const baseManifest = require('./manifest.json');

const TMDB_API_KEY = process.env.TMDB_API_KEY;

// Comma-separated TorBox API keys to proactively rebuild the torrent index
// the moment the process boots (e.g. right after a deploy), instead of
// waiting for the first real request to trigger it. Optional — leave unset
// and nothing changes.
const WARM_API_KEYS = (process.env.WARM_API_KEYS || '')
  .split(',')
  .map(k => k.trim())
  .filter(Boolean);

const caches = new Map();
const TORBOX_CACHE_TTL = 60 * 60 * 1000;
const TMDB_CACHE_TTL = 24 * 60 * 60 * 1000;
const REBUILD_CONCURRENCY = 25; // torrents TMDB-matched in parallel during a rebuild — at 12, a 48-item library took 4 sequential rounds instead of the ~2 this needs; TMDB rate-limiting only becomes a real risk at a much larger scale than this

// Caps how long a live request will wait on a chain of upstream calls
// (TorBox, TMDB) before giving up. Retries inside those calls are fine for
// the background index rebuild, where nothing is waiting on the result —
// but a request actually being served to AIOStreams needs a hard ceiling,
// since a slow-but-eventually-successful TorBox/TMDB response is just as
// bad as an outright failure if it blows the aggregator's own timeout.
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms))
  ]);
}

// Every fetch() in this file used to be uncancellable — Promise.race (above)
// stops US from waiting past a deadline, but a slow-not-failed TorBox/TMDB
// response kept running in the background regardless, tying up a connection
// for nothing. This actually aborts it.
async function fetchWithTimeout(url, options = {}, timeoutMs = 4000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Randomizes a retry delay instead of using a flat one. When TMDB
// rate-limits a burst of simultaneous requests, fixed backoff means they
// all retry in near lockstep and re-trigger the same limit; spreading them
// out avoids that.
function jitter(baseMs, spread = 0.4) {
  const delta = baseMs * spread;
  return Math.round(baseMs - delta / 2 + Math.random() * delta);
}

// Runs fn() over items with at most `limit` in flight at once, instead of
// firing all of them simultaneously via Promise.all. A slow/retrying item
// only occupies one worker slot rather than competing for TMDB alongside
// every other torrent in the library at the same time.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function getCache(apiKey) {
  if (!caches.has(apiKey)) {
    caches.set(apiKey, {
      torboxLibrary: null,
      torboxLibraryExpiry: 0,
      torboxLibraryPromise: null,
      tmdb: new Map(),
      imdbId: new Map()
    });
  }
  return caches.get(apiKey);
}

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

// ── Config page ───────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>TorBox Stremio Addon</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #0f0f0f; color: #fff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
    .card { background: #1a1a1a; border-radius: 16px; padding: 40px; max-width: 480px; width: 100%; }
    h1 { font-size: 24px; margin-bottom: 8px; }
    .subtitle { color: #888; font-size: 14px; margin-bottom: 32px; }
    label { display: block; font-size: 13px; color: #aaa; margin-bottom: 8px; }
    input { width: 100%; background: #111; border: 1px solid #333; border-radius: 8px; padding: 12px 16px; color: #fff; font-size: 15px; outline: none; transition: border-color 0.2s; }
    input:focus { border-color: #7c3aed; }
    button { width: 100%; background: #7c3aed; border: none; border-radius: 8px; padding: 13px; color: #fff; font-size: 15px; font-weight: 600; cursor: pointer; margin-top: 16px; transition: background 0.2s; }
    button:hover { background: #6d28d9; }
    .result { margin-top: 24px; display: none; }
    .result-label { font-size: 13px; color: #aaa; margin-bottom: 8px; }
    .url-box { background: #111; border: 1px solid #333; border-radius: 8px; padding: 12px 16px; font-size: 13px; word-break: break-all; color: #a78bfa; margin-bottom: 12px; }
    .copy-btn { width: 100%; background: #222; border: 1px solid #444; border-radius: 8px; padding: 10px; color: #fff; font-size: 14px; cursor: pointer; transition: background 0.2s; }
    .copy-btn:hover { background: #333; }
    .install-btn { width: 100%; background: #059669; border: none; border-radius: 8px; padding: 10px; color: #fff; font-size: 14px; font-weight: 600; cursor: pointer; margin-top: 8px; transition: background 0.2s; text-decoration: none; display: block; text-align: center; }
    .install-btn:hover { background: #047857; }
    .note { color: #666; font-size: 12px; margin-top: 16px; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="card">
    <h1>👑 TorBox Addon</h1>
    <p class="subtitle">Stream your TorBox library in Stremio</p>
    <label for="apikey">Your TorBox API Key</label>
    <input type="text" id="apikey" placeholder="Paste your TorBox API key here" autocomplete="off" autocorrect="off" spellcheck="false">
    <button onclick="generate()">Generate Addon URL</button>
    <div class="result" id="result">
      <div class="result-label">Your personalised addon URL:</div>
      <div class="url-box" id="url-box"></div>
      <button class="copy-btn" onclick="copyUrl()">Copy URL</button>
      <a class="install-btn" id="install-btn" href="#">Install in Stremio</a>
      <p class="note">Paste the URL into Stremio → Addons → Community Addons → paste URL. Or click Install to open Stremio directly.</p>
    </div>
  </div>
  <script>
    function generate() {
      const key = document.getElementById('apikey').value.trim();
      if (!key) { alert('Please enter your TorBox API key'); return; }
      const base = window.location.origin;
      const manifestUrl = base + '/' + key + '/manifest.json';
      const stremioUrl = manifestUrl.replace('https://', 'stremio://');
      document.getElementById('url-box').textContent = manifestUrl;
      document.getElementById('install-btn').href = stremioUrl;
      document.getElementById('result').style.display = 'block';
    }
    function copyUrl() {
      const url = document.getElementById('url-box').textContent;
      navigator.clipboard.writeText(url).then(() => {
        const btn = document.querySelector('.copy-btn');
        btn.textContent = 'Copied!';
        setTimeout(() => btn.textContent = 'Copy URL', 2000);
      });
    }
    document.getElementById('apikey').addEventListener('keydown', e => {
      if (e.key === 'Enter') generate();
    });
  </script>
</body>
</html>`);
});

// ── Type detection ────────────────────────────────────────────────────────────

function detectTypeFromName(rawName) {
  // Normalize dot/underscore separators to spaces first — release names like
  // "Season.4" or "Complete.Series" otherwise never match \s*-based patterns,
  // since \s only matches actual whitespace, not literal dots.
  const name = rawName.replace(/[\._]/g, ' ');
  if (/\bS\d{1,2}E\d{1,2}\b/i.test(name)) return 'series';
  if (/\bS\d{1,2}\b/i.test(name)) return 'series';
  if (/Season\s*\d+/i.test(name)) return 'series';
  if (/Stagione\s*\d+/i.test(name)) return 'series';
  if (/Temporada\s*\d+/i.test(name)) return 'series';
  if (/Staffel\s*\d+/i.test(name)) return 'series';
  if (/Saison\s*\d+/i.test(name)) return 'series';
  if (/Сезон\s*\d+/i.test(name)) return 'series';
  if (/Sezon\s*\d+/i.test(name)) return 'series';      // Polish / Turkish
  if (/Seizoen\s*\d+/i.test(name)) return 'series';     // Dutch
  if (/Séria\s*\d+/i.test(name)) return 'series';       // Slovak
  if (/Série\s*\d+/i.test(name)) return 'series';       // Czech
  if (/Évad\s*\d+/i.test(name)) return 'series';        // Hungarian
  if (/\d+x\d+/i.test(name)) return 'series';
  if (/Complete\s*Series/i.test(name)) return 'series';
  if (/Complete\s*Collection/i.test(name)) return 'series';
  if (/Complete\s*Season/i.test(name)) return 'series';
  if (/\(S\d+/i.test(name)) return 'series';
  if (/INTEGRALE/i.test(name)) return 'series';
  if (/COMPLETA|COMPLETO/i.test(name)) return 'series';
  if (/\bLF[_\s]/i.test(name)) return 'series';
  return 'movie';
}

// Language-independent fallback: rather than trying to enumerate every
// language's word for "season" forever, check whether multiple files INSIDE
// the torrent follow an episode-numbering convention (S01E01, 1x01). Episode
// numbering is used almost universally across release groups regardless of
// what language the outer torrent name uses for "Season" — so this catches
// gaps in the name-based word list without needing to guess every language.
function looksLikeSeriesFromFiles(files) {
  if (!files || !files.length) return false;
  const episodePattern = /\bS\d{1,2}[\s\-\._]*E\d{1,2}\b|\b\d{1,2}x\d{1,2}\b/i;
  const matches = files.filter(f => episodePattern.test(f.name || f.short_name || ''));
  return matches.length >= 2;
}

function detectType(torrent) {
  const nameGuess = detectTypeFromName(torrent.name);
  if (nameGuess === 'series') return 'series';
  if (looksLikeSeriesFromFiles(torrent.files)) return 'series';
  return 'movie';
}

async function resolveSeriesType(tmdbId, apiKey) {
  const cache = getCache(apiKey);
  const cacheKey = `keywords:${tmdbId}`;
  const cached = cache.tmdb.get(cacheKey);
  if (cached && Date.now() < cached.expiry) return cached.value;

  try {
    const res = await fetchWithTimeout(`https://api.themoviedb.org/3/tv/${tmdbId}/keywords?api_key=${TMDB_API_KEY}`, {}, 4000);
    const json = await res.json();
    const isAnime = (json.results || []).some(k => k.id === 210024);
    const resolved = isAnime ? 'anime' : 'series';
    cache.tmdb.set(cacheKey, { value: resolved, expiry: Date.now() + TMDB_CACHE_TTL });
    return resolved;
  } catch (e) {
    return 'series';
  }
}

// ── Title cleaning: earliest-junk-marker-wins ─────────────────────────────────
// Instead of stripping patterns in a fixed sequence (which breaks whenever one
// pattern consumes text another pattern needed), we scan ALL junk patterns at
// once and cut the title at whichever one starts earliest in the string.

function firstMatchIndex(str, pattern, minIndex) {
  const flags = pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g';
  const re = new RegExp(pattern.source, flags);
  let m;
  while ((m = re.exec(str)) !== null) {
    if (m.index >= minIndex) return m.index;
    if (re.lastIndex === m.index) re.lastIndex++;
  }
  return -1;
}

// minIndex: 1 means "ignore a match at position 0" — used for patterns that
// could legitimately be the first word of a real title (e.g. a movie called "1917").
const JUNK_PATTERNS = [
  { pattern: /\bS\d{1,2}(E\d{1,2})?\b/i, minIndex: 0 },
  { pattern: /\b\d{1,2}x\d{1,2}\b/i, minIndex: 0 },
  { pattern: /\bComplete\s+Season\b/i, minIndex: 0 },
  { pattern: /\bSeason\s*\d+/i, minIndex: 0 },
  { pattern: /\bStagione\s*\d+/i, minIndex: 0 },
  { pattern: /\bTemporada\s*\d+/i, minIndex: 0 },
  { pattern: /\bStaffel\s*\d+/i, minIndex: 0 },
  { pattern: /\bSaison\s*\d+/i, minIndex: 0 },
  { pattern: /\bСезон\s*\d+/i, minIndex: 0 },
  { pattern: /\bSezon\s*\d+/i, minIndex: 0 },
  { pattern: /\bSeizoen\s*\d+/i, minIndex: 0 },
  { pattern: /\bSéria\s*\d+/i, minIndex: 0 },
  { pattern: /\bSérie\s*\d+/i, minIndex: 0 },
  { pattern: /\bÉvad\s*\d+/i, minIndex: 0 },
  { pattern: /\bComplete\s*Series\b/i, minIndex: 0 },
  { pattern: /\bComplete\s*Collection\b/i, minIndex: 0 },
  { pattern: /\bINTEGRALE\b/i, minIndex: 0 },
  { pattern: /\bCOMPLETA\b/i, minIndex: 0 },
  { pattern: /\bCOMPLETO\b/i, minIndex: 0 },
  { pattern: /\bLF[_\s]/i, minIndex: 0 },
  { pattern: /\b(19|20)\d{2}\b/, minIndex: 1 },
  { pattern: /\b(MULTi|MULTI|VFF|VF|VO|VOST|TRUEFRENCH|ITA|ENG|SPA|POR|RUS|RU|RUSENG|JPN|GER|FRE|FRA|DUT|NLD|SWE|NOR|DAN|FIN|POL|CZE|HUN|ROM|TUR|KOR|CHI|ARA|HEB|HIN|THA|VIE|IND|DUBBED|SUBBED|DUAL|MULTI5|MULTI6|MULTISUB)\b/i, minIndex: 1 },
  { pattern: /\b(1080p|720p|2160p|4k|bluray|bdrip|webrip|web-dl|web|hdtv|x264|x265|hevc|aac|dd5|h264|h265|remux|hdlight|10bit|8bit|ac3|dts|atmos)\b/i, minIndex: 0 },
  { pattern: /\b(proper|repack|extended|theatrical|directors\.?cut)\b/i, minIndex: 0 },
];

function cleanTitle(name) {
  let working = name
    .replace(/\.(mkv|mp4|avi|mov|wmv)$/i, '')
    .replace(/\[.*?\]/g, '')
    .replace(/[\._]/g, ' ');

  let cutIndex = working.length;
  for (const { pattern, minIndex } of JUNK_PATTERNS) {
    const idx = firstMatchIndex(working, pattern, minIndex);
    if (idx !== -1 && idx < cutIndex) cutIndex = idx;
  }

  return working
    .slice(0, cutIndex)
    .replace(/\s*-\s*(the|a|an)\s*$/i, '')
    .replace(/[\s\-\(\[]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractYear(name) {
  const match = name.match(/\b(19|20)(\d{2})\b/);
  return match ? parseInt(match[0]) : null;
}

function normalizeTitle(str) {
  return str.toLowerCase().replace(/[^a-z0-9]/g, '').trim();
}

function wordsOf(str) {
  return (str || '').toLowerCase().match(/[a-z0-9]+/g) || [];
}

// ── TMDB matching cascade ───────────────────────────────────────────────────
// Tries progressively looser matching strategies instead of requiring one
// exact match: exact → ignore leading article → pre-colon/dash portion →
// fuzzy word overlap (with a year-proximity adjustment). There is NO
// "single result found, so trust it" shortcut — a lone TMDB hit is not
// proof of a correct match. A wrong match is worse than no match at all,
// since it silently shows the wrong piece of content; every result set,
// however small, has to clear the same similarity bar.

function pickBestMatch(results, title, year) {
  if (!results.length) return null;
  const normalizedSearch = normalizeTitle(title);
  const stripArticle = s => (s || '').replace(/^(the|a|an)\s+/i, '');
  const strippedSearch = normalizeTitle(stripArticle(title));

  let match = results.find(r => normalizeTitle(r.title || r.name || '') === normalizedSearch);
  if (match) return match;

  match = results.find(r => normalizeTitle(stripArticle(r.title || r.name || '')) === strippedSearch);
  if (match) return match;

  match = results.find(r => {
    const base = (r.title || r.name || '').split(/[:\-–]/)[0];
    return normalizeTitle(base) === normalizedSearch;
  });
  if (match) return match;

  const searchWords = wordsOf(title);
  if (searchWords.length) {
    let best = null;
    let bestScore = 0;
    for (const r of results) {
      const candidateWords = wordsOf(r.title || r.name || '');
      if (!candidateWords.length) continue;
      const overlap = searchWords.filter(w => candidateWords.includes(w)).length;
      const score = overlap / Math.max(searchWords.length, candidateWords.length);
      let yearAdjustment = 0;
      if (year) {
        const rYear = parseInt((r.release_date || r.first_air_date || '').slice(0, 4));
        if (rYear) {
          const diff = Math.abs(rYear - year);
          if (diff <= 1) yearAdjustment = 0.15;
          else if (diff > 3) yearAdjustment = -0.3; // penalize, don't just fail to reward
        }
      }
      const total = score + yearAdjustment;
      if (total > bestScore) { bestScore = total; best = r; }
    }
    if (best && bestScore >= 0.6) return best;
  }

  return null;
}

async function searchTmdb(title, year, type, apiKey, retries = 3) {
  const cache = getCache(apiKey);
  const cacheKey = `${title}:${year || 'noyear'}:${type}`;
  const cached = cache.tmdb.get(cacheKey);
  if (cached && Date.now() < cached.expiry) return cached.value;

  const endpoint = type === 'movie' ? 'search/movie' : 'search/tv';
  const yearParam = type === 'movie' ? 'primary_release_year' : 'first_air_date_year';

  for (let i = 0; i < retries; i++) {
    try {
      let results = [];

      if (year) {
        const url = `https://api.themoviedb.org/3/${endpoint}?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(title)}&${yearParam}=${year}`;
        const res = await fetchWithTimeout(url, {}, 4000);
        const json = await res.json();
        results = json.results || [];
      }

      if (!results.length) {
        const url = `https://api.themoviedb.org/3/${endpoint}?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(title)}`;
        const res = await fetchWithTimeout(url, {}, 4000);
        const json = await res.json();
        results = json.results || [];
      }

      if (results.length) {
        const match = pickBestMatch(results, title, year);
        if (match) {
          cache.tmdb.set(cacheKey, { value: match, expiry: Date.now() + TMDB_CACHE_TTL });
          return match;
        }
      }
      break; // got a real response, no point retrying an identical query
    } catch (e) {
      console.error(`TMDB search attempt ${i + 1} failed for "${title}":`, e.message);
      if (i < retries - 1) await new Promise(r => setTimeout(r, jitter(500)));
    }
  }

  cache.tmdb.set(cacheKey, { value: null, expiry: Date.now() + TMDB_CACHE_TTL });
  return null;
}

async function getImdbId(tmdbId, type, apiKey, retries = 3) {
  const cache = getCache(apiKey);
  const cacheKey = `${tmdbId}:${type}`;
  const cached = cache.imdbId.get(cacheKey);
  if (cached && Date.now() < cached.expiry) return cached.value;

  const endpoint = type === 'movie' ? 'movie' : 'tv';
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetchWithTimeout(`https://api.themoviedb.org/3/${endpoint}/${tmdbId}/external_ids?api_key=${TMDB_API_KEY}`, {}, 4000);
      const json = await res.json();
      if (json.imdb_id) {
        cache.imdbId.set(cacheKey, { value: json.imdb_id, expiry: Date.now() + TMDB_CACHE_TTL });
        return json.imdb_id;
      }
    } catch (e) {
      console.error(`IMDB ID lookup attempt ${i + 1} failed:`, e.message);
    }
    if (i < retries - 1) await new Promise(r => setTimeout(r, jitter(500)));
  }
  return null;
}

// Reverse of getImdbId: given an imdbId we already have (from an incoming
// stream request), get the canonical title back from TMDB in one call. Used
// by the stream handler's cold-index fallback — we already know exactly
// which title we're looking for, so candidate torrents can be checked with
// a local word-overlap comparison instead of a per-torrent TMDB search.
async function findByImdbId(imdbId, type, apiKey, retries = 2) {
  const cache = getCache(apiKey);
  const cacheKey = `find:${imdbId}:${type}`;
  const cached = cache.tmdb.get(cacheKey);
  if (cached && Date.now() < cached.expiry) return cached.value;

  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetchWithTimeout(`https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`, {}, 4000);
      const json = await res.json();
      const result = type === 'movie' ? (json.movie_results || [])[0] : (json.tv_results || [])[0];
      if (result) {
        cache.tmdb.set(cacheKey, { value: result, expiry: Date.now() + TMDB_CACHE_TTL });
        return result;
      }
      break;
    } catch (e) {
      console.error(`TMDB find-by-imdb attempt ${i + 1} failed for ${imdbId}:`, e.message);
      if (i < retries - 1) await new Promise(r => setTimeout(r, jitter(300)));
    }
  }
  cache.tmdb.set(cacheKey, { value: null, expiry: Date.now() + TMDB_CACHE_TTL });
  return null;
}

function toMeta(tmdb, imdbId, torrentId, type) {
  return {
    id: imdbId, type,
    name: tmdb.title || tmdb.name,
    poster: tmdb.poster_path ? `https://image.tmdb.org/t/p/w500${tmdb.poster_path}` : null,
    background: tmdb.backdrop_path ? `https://image.tmdb.org/t/p/original${tmdb.backdrop_path}` : null,
    releaseInfo: (tmdb.release_date || tmdb.first_air_date || '').slice(0, 4),
    imdbRating: tmdb.vote_average?.toFixed(1),
    torrentId
  };
}

async function getTorboxLibrary(apiKey, retries = 2) {
  const cache = getCache(apiKey);
  const now = Date.now();
  if (cache.torboxLibrary && now < cache.torboxLibraryExpiry) return cache.torboxLibrary;

  // Multiple callers can land here around the same moment on a cold/expired
  // cache — the background rebuild plus one or more live fallbacks. Without
  // this, each fires its own independent TorBox request. Share one.
  if (cache.torboxLibraryPromise) return cache.torboxLibraryPromise;

  cache.torboxLibraryPromise = (async () => {
    for (let i = 0; i < retries; i++) {
      try {
        const res = await fetchWithTimeout('https://api.torbox.app/v1/api/torrents/mylist', {
          headers: { Authorization: `Bearer ${apiKey}` }
        }, 5000);
        const json = await res.json();
        cache.torboxLibrary = json.data || [];
        cache.torboxLibraryExpiry = Date.now() + TORBOX_CACHE_TTL;
        return cache.torboxLibrary;
      } catch (e) {
        console.error(`TorBox library fetch attempt ${i + 1} failed:`, e.message);
        if (i < retries - 1) await new Promise(r => setTimeout(r, jitter(400)));
      }
    }
    // Every attempt failed. Serve the last-known-good library instead of
    // throwing, if we have one — a stale library beats every caller
    // (rebuildTorrentIndex, the stream fallback, /debug) crashing because
    // TorBox had one bad moment. Only throw if nothing's cached yet.
    if (cache.torboxLibrary) return cache.torboxLibrary;
    throw new Error('TorBox library unavailable and nothing cached yet');
  })();

  try {
    return await cache.torboxLibraryPromise;
  } finally {
    cache.torboxLibraryPromise = null;
  }
}

// Builds the torrent → TMDB/IMDB mapping ONCE per cache cycle instead of
// redoing it live on every single catalog/stream request. Without this, a
// stream request would re-scan the whole library and re-run TMDB matching
// on every request, which can easily exceed a tight aggregator timeout
// (AIOStreams defaults to 3s) and reads as "the addon randomly doesn't
// return streams" even though it would eventually have.
//
// Stale-while-revalidate: a request is NEVER blocked on a full rebuild.
// A warm-but-expired index is served immediately while a fresh copy builds
// in the background. A fully cold index (e.g. right after a deploy or a
// cold start wipes the in-memory cache) is treated the same way — that
// request gets an empty result right away instead of waiting, and the
// index is ready for the next one. One possibly-empty response right after
// a restart beats ever risking a timeout.
async function getTorrentIndex(apiKey) {
  const cache = getCache(apiKey);
  const now = Date.now();

  if (cache.torrentIndex && now < cache.torrentIndexExpiry) {
    return cache.torrentIndex;
  }

  if (!cache.torrentIndexRefreshing) {
    cache.torrentIndexRefreshing = true;
    rebuildTorrentIndex(apiKey).finally(() => { cache.torrentIndexRefreshing = false; });
  }
  return cache.torrentIndex || []; // serve stale/empty, refresh happening in the background
}

async function rebuildTorrentIndex(apiKey) {
  const cache = getCache(apiKey);
  let torrents;
  try {
    torrents = await getTorboxLibrary(apiKey);
  } catch (e) {
    console.error('rebuildTorrentIndex: could not get TorBox library, index left as-is:', e.message);
    return cache.torrentIndex || [];
  }

  const matchOne = async (torrent) => {
    try {
      const torrentType = detectType(torrent);
      const title = cleanTitle(torrent.name);
      const year = extractYear(torrent.name);
      const tmdb = await searchTmdb(title, year, torrentType, apiKey);
      if (!tmdb) return null;

      let finalType = torrentType;
      if (torrentType === 'series') {
        finalType = await resolveSeriesType(tmdb.id, apiKey); // 'series' or 'anime'
      }

      const imdbId = await getImdbId(tmdb.id, torrentType, apiKey);
      if (!imdbId) return null;

      return { torrent, imdbId, torrentType, finalType, tmdb };
    } catch (e) {
      return null;
    }
  };

  let entries;
  try {
    // Bounded concurrency instead of firing every torrent at TMDB at once —
    // a slow/retrying torrent only ties up one of REBUILD_CONCURRENCY slots
    // rather than piling on top of every other lookup simultaneously. The
    // outer timeout is a safety net for a truly pathological case (a bug,
    // not just slow API calls — those are already bounded per-call by
    // fetchWithTimeout): without it, one stuck item could keep
    // torrentIndexRefreshing stuck "true" forever and block all future
    // rebuild attempts.
    entries = await withTimeout(mapWithConcurrency(torrents, REBUILD_CONCURRENCY, matchOne), 60000);
  } catch (e) {
    console.error('rebuildTorrentIndex: gave up waiting on the batch, keeping previous index:', e.message);
    return cache.torrentIndex || [];
  }

  const index = entries.filter(Boolean);
  cache.torrentIndex = index;
  cache.torrentIndexExpiry = Date.now() + TORBOX_CACHE_TTL;
  return index;
}

function formatStreamDescription(filename, title, season, episode, filesize) {
  const res = filename.match(/\b(2160p|1080p|720p|576p|480p)\b/i)?.[1] ||
              title.match(/\b(2160p|1080p|720p|576p|480p)\b/i)?.[1] || null;
  const quality = filename.match(/\b(bluray|bdrip|webrip|web-dl|web|hdtv|hdlight|remux)\b/i)?.[1] ||
                  title.match(/\b(bluray|bdrip|webrip|web-dl|web|hdtv|hdlight|remux)\b/i)?.[1] || null;
  const encode = filename.match(/\b(x264|x265|h264|h265|hevc|avc)\b/i)?.[1] ||
                 title.match(/\b(x264|x265|h264|h265|hevc|avc)\b/i)?.[1] || null;
  const audio = filename.match(/\b(aac|ac3|dts|atmos|truehd|dd5|eac3|flac)\b/i)?.[1] ||
                title.match(/\b(aac|ac3|dts|atmos|truehd|dd5|eac3|flac)\b/i)?.[1] || null;
  const hdr = filename.match(/\b(hdr10|hdr|dv|dolby\.vision)\b/i)?.[1] ||
              title.match(/\b(hdr10|hdr|dv|dolby\.vision)\b/i)?.[1] || null;
  const bitDepth = filename.match(/\b(10bit|8bit)\b/i)?.[1] ||
                   title.match(/\b(10bit|8bit)\b/i)?.[1] || null;
  const container = filename.match(/\.(mkv|mp4|avi|mov|wmv)$/i)?.[1] || null;

  const resIcon = res ? ({
    '2160p': '⭐️ 4K', '1080p': '💎 1080p', '720p': '💿 720p',
    '576p': '📀 SD', '480p': '📀 LQ'
  }[res.toLowerCase()] || `📺 ${res}`) : '⁉️ Unknown';

  const episodeTag = (season !== null && episode !== null)
    ? ` • S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}` : '';
  // Raw filename first, unmodified — this is what release-name parsers used by
  // aggregators (AIOStreams etc.) are actually built and tested against, so it
  // gives them the cleanest possible material to verify title/season/episode
  // themselves, ahead of our own decorated, human-readable lines below.
  const line0 = filename || null;
  const line1 = title ? `🎬 ${title}${episodeTag}` : null;
  const line2 = resIcon;
  const qualityParts = [
    quality ? `🎥 ${quality.toUpperCase()}` : null,
    encode ? `➤ ${encode.toUpperCase()}` : null,
    hdr ? `➤ ${hdr.toUpperCase()}` : null,
    bitDepth ? `➤ ${bitDepth}` : null,
  ].filter(Boolean);
  const line3 = qualityParts.length > 0 ? qualityParts.join(' ') : null;
  const line4 = audio ? `🎧 ${audio.toUpperCase()}` : null;
  const sizeStr = filesize > 0 ? `📦 ${(filesize / 1024 / 1024 / 1024).toFixed(2)} GB` : null;
  const containerStr = container ? `.${container.toLowerCase()}` : null;
  const line5 = [sizeStr, containerStr].filter(Boolean).join(' ➤ ');
  const description = [line0, line1, line2, line3, line4, line5].filter(Boolean).join('\n');

  // Plain, identifier-safe resolution label for the caller to build a
  // bingeGroup from — separate from resIcon, which is emoji-decorated for display.
  const resolutionLabel = res ? res.toLowerCase() : 'unknown';

  return { description, resolutionLabel };
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/:apiKey/manifest.json', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const manifest = { ...baseManifest, id: baseManifest.id + '.' + req.params.apiKey.slice(0, 8) };
  res.json(manifest);
});

app.get('/:apiKey/catalog/:type/:id.json', async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  try {
    const { apiKey, type } = req.params;
    const index = await getTorrentIndex(apiKey);

    const seen = new Set();
    const metas = [];
    for (const entry of index) {
      if (entry.finalType !== type) continue;
      if (seen.has(entry.imdbId)) continue;
      seen.add(entry.imdbId);
      // Return as series so metadata addons (AIO etc.) can resolve anime shows —
      // the catalog URL type alone is enough to place it in the anime section.
      const metaType = type === 'anime' ? 'series' : type;
      metas.push(toMeta(entry.tmdb, entry.imdbId, entry.torrent.id, metaType));
    }

    res.json({ metas });
  } catch (err) {
    console.error(err);
    res.status(500).json({ metas: [] });
  }
});

app.get('/:apiKey/stream/:type/:id.json', async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  try {
    const { apiKey, type } = req.params;
    const torrentType = type === 'anime' ? 'series' : type;
    const rawId = req.params.id;
    const parts = rawId.split(':');
    const id = parts[0];
    const season = parts[1] ? parseInt(parts[1]) : null;
    const episode = parts[2] ? parseInt(parts[2]) : null;

    const buildPairs = (torrents) => {
      const found = [];
      if (season !== null && episode !== null) {
        const seasonStr = String(season).padStart(2, '0');
        const episodeStr = String(episode).padStart(2, '0');
        const pattern = new RegExp(`(S${seasonStr}[\\s\\-]*E[\\s\\-]*${episodeStr}|${parseInt(season)}[xX]${episodeStr})`, 'i');
        for (const torrent of torrents) {
          const filtered = (torrent.files || []).filter(f =>
            pattern.test(f.name) &&
            /\.(mkv|mp4|avi|mov|wmv)$/i.test(f.short_name || f.name)
          );
          filtered.forEach(f => found.push({ file: f, torrent }));
        }
      } else {
        for (const torrent of torrents) {
          const videoFiles = (torrent.files || []).filter(f =>
            /\.(mkv|mp4|avi|mov|wmv)$/i.test(f.short_name || f.name)
          );
          if (videoFiles.length > 0) {
            videoFiles.sort((a, b) => (b.size || 0) - (a.size || 0));
            found.push({ file: videoFiles[0], torrent });
          }
        }
      }
      return found;
    };

    const index = await getTorrentIndex(apiKey);
    const indexed = index
      .filter(entry => entry.torrentType === torrentType && entry.imdbId === id)
      .map(entry => entry.torrent);

    let pairs = buildPairs(indexed);

    if (!pairs.length) {
      // No playable file from the (possibly stale) precomputed index —
      // either this show isn't indexed yet (cold start) or, just as
      // likely, it IS indexed but none of ITS known torrents happen to
      // contain this specific episode (e.g. that episode's torrent was
      // only added to the library after the last rebuild — the show-level
      // match succeeds but the file-level match doesn't). Either way, try
      // one targeted, live check before giving up: get the real title for
      // this imdbId and the current library — independent calls, run
      // together instead of stacked — then match locally and re-check for
      // the file.
      //
      // The whole attempt is capped at 6s. TorBox/TMDB being outright down
      // was already handled by the try/catch around this whole handler —
      // this covers them being merely slow, which is just as bad for a
      // live request against a tight aggregator timeout, but wouldn't have
      // thrown to trigger that catch.
      try {
        pairs = await withTimeout((async () => {
          const [targetMeta, library] = await Promise.all([
            findByImdbId(id, torrentType, apiKey),
            getTorboxLibrary(apiKey)
          ]);
          if (!targetMeta) return [];
          const targetWords = wordsOf(targetMeta.title || targetMeta.name || '');
          if (!targetWords.length) return [];
          const targetDate = targetMeta.release_date || targetMeta.first_air_date || '';
          const targetYear = targetDate ? parseInt(targetDate.slice(0, 4)) : null;
          const candidates = library.filter(torrent => {
            if (detectType(torrent) !== torrentType) return false;
            const torrentWords = wordsOf(cleanTitle(torrent.name));
            if (!torrentWords.length) return false;
            const overlap = targetWords.filter(w => torrentWords.includes(w)).length;
            if (overlap / Math.max(targetWords.length, torrentWords.length) < 0.6) return false;
            // Word overlap alone lets a same-titled but different-year entry
            // through (a remake, a different show entirely) — the primary
            // index path guards against exactly this via pickBestMatch's
            // year-proximity check; do the same here. Skip the check only
            // when we can't extract a year from one side or the other,
            // rather than rejecting a legitimate match for missing data.
            const torrentYear = extractYear(torrent.name);
            if (targetYear && torrentYear && Math.abs(targetYear - torrentYear) > 1) return false;
            return true;
          });
          return buildPairs(candidates);
        })(), 6000);
      } catch (e) {
        console.error(`Targeted fallback gave up for ${id}:`, e.message);
        pairs = [];
      }
    }

    if (!pairs.length) return res.json({ streams: [] });

    const streams = pairs.map(({ file, torrent }) => {
      const filename = file.short_name || file.name || '';
      const { description, resolutionLabel } = formatStreamDescription(
        filename,
        cleanTitle(torrent.name),
        season, episode,
        file.size || 0
      );
      return {
        url: `https://api.torbox.app/v1/api/torrents/requestdl?token=${apiKey}&torrent_id=${torrent.id}&file_id=${file.id}&redirect=true`,
        name: '👑 Library ⚡️',
        description,
        behaviorHints: {
          // Lets the client auto-select "the same quality tier" for the next
          // episode on auto-advance, instead of falling back to whatever it
          // picks by default when there's nothing to match against.
          bingeGroup: `torbox-library-${resolutionLabel}`,
          filename
        }
      };
    });

    res.json({ streams });
  } catch (err) {
    console.error(err);
    res.json({ streams: [] });
  }
});

// Self-serve diagnostics — shows every torrent's detected type, cleaned title,
// TMDB match (or the exact reason it failed to match) without needing debug code added ad hoc.
app.get('/:apiKey/debug/:type', async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  try {
    const { apiKey, type } = req.params;
    const torrentType = type === 'anime' ? 'series' : type;
    const torrents = await getTorboxLibrary(apiKey);

    const results = await Promise.all(
      torrents.map(async (torrent) => {
        const detected = detectType(torrent);
        if (detected !== torrentType) {
          return { torrent: torrent.name, detectedType: detected, issue: `detected as ${detected}, not ${torrentType}` };
        }
        const title = cleanTitle(torrent.name);
        const year = extractYear(torrent.name);
        const tmdb = await searchTmdb(title, year, torrentType, apiKey);
        if (!tmdb) {
          return { torrent: torrent.name, detectedType: detected, cleanedTitle: title, extractedYear: year, issue: 'No TMDB match found' };
        }
        const imdbId = await getImdbId(tmdb.id, torrentType, apiKey);
        return {
          torrent: torrent.name,
          detectedType: detected,
          cleanedTitle: title,
          extractedYear: year,
          tmdbMatch: tmdb.title || tmdb.name,
          tmdbId: tmdb.id,
          imdbId: imdbId || null,
          issue: imdbId ? null : 'TMDB matched but no IMDB ID available'
        };
      })
    );

    res.json(results);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/:apiKey/refresh', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const { apiKey } = req.params;
  if (caches.has(apiKey)) caches.delete(apiKey);
  res.json({ success: true, message: 'Cache cleared' });
});

app.get('/configure', (req, res) => res.redirect('/'));

app.listen(3000, () => {
  console.log('TorBox addon running');
  for (const key of WARM_API_KEYS) {
    getTorrentIndex(key).catch(e => console.error('Warm-up failed for a configured key:', e.message));
  }
});
