const express = require('express');
const app = express();
const baseManifest = require('./manifest.json');

// Unhandled rejections crash the process by default on modern Node — log and keep running.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection (process kept alive):', reason && reason.message ? reason.message : reason);
});

// Catches synchronous throws that unhandledRejection above doesn't.
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (process kept alive):', err && err.message ? err.message : err);
});

// Distinguishes a graceful restart (deploy/sleep) from a real crash in the logs.
process.on('SIGTERM', () => {
  console.log('Received SIGTERM — graceful shutdown, not a crash');
});

const TMDB_API_KEY = process.env.TMDB_API_KEY;

const crypto = require('crypto');
if (!process.env.URL_ENCRYPTION_SECRET) {
  console.error('WARNING: URL_ENCRYPTION_SECRET not set — using an insecure default. Set this in Render env vars.');
}
const ENCRYPTION_KEY = crypto.createHash('sha256').update(process.env.URL_ENCRYPTION_SECRET || 'change-me').digest();

// Deterministic: the same TorBox key always encrypts to the same token,
// since the IV is derived from the key + secret rather than random. The IV
// travels with the ciphertext (standard practice) so decryption doesn't
// need to already know the key to recover it.
function encryptApiKey(key) {
  const iv = crypto.createHash('sha256').update(key).update(ENCRYPTION_KEY).digest().subarray(0, 16);
  const cipher = crypto.createCipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(key, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, encrypted]).toString('base64url');
}

function decryptApiKey(token) {
  try {
    const data = Buffer.from(token, 'base64url');
    const iv = data.subarray(0, 16);
    const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
    return Buffer.concat([decipher.update(data.subarray(16)), decipher.final()]).toString('utf8');
  } catch (e) {
    return null;
  }
}

// Every :apiKey route param arrives encrypted from the URL — decrypt it
// once here so route handlers keep using req.params.apiKey as the real
// TorBox key, unchanged.
app.param('apiKey', (req, res, next, token) => {
  const key = decryptApiKey(token);
  if (!key) return res.status(400).json({ error: 'Invalid or corrupted key' });
  req.params.apiKey = key;
  next();
});

// TorBox keys to pre-warm the cache for on boot. Optional.
const WARM_API_KEYS = (process.env.WARM_API_KEYS || '')
  .split(',')
  .map(k => k.trim())
  .filter(Boolean);

const caches = new Map();
const TORBOX_CACHE_TTL = 60 * 60 * 1000;
const TMDB_CACHE_TTL = 24 * 60 * 60 * 1000;
const REBUILD_CONCURRENCY = 25; // concurrent TMDB matches during a rebuild

// Caps how long a live request waits on TorBox/TMDB before giving up.
function withTimeout(promise, ms) {
  // Promise.race doesn't cancel the loser — catch it separately so a late
  // rejection can't become an unhandled rejection and crash the process.
  promise.catch(() => {});
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms))
  ]);
}

// fetch() with a real, cancelling timeout via AbortController.
async function fetchWithTimeout(url, options = {}, timeoutMs = 4000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Randomized backoff so retries don't all land at once.
function jitter(baseMs, spread = 0.4) {
  const delta = baseMs * spread;
  return Math.round(baseMs - delta / 2 + Math.random() * delta);
}

// Like Promise.all but caps how many run concurrently.
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
      torboxLibraryRefreshing: false,
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
app.use(express.json());

app.post('/encrypt', async (req, res) => {
  const key = (req.body?.key || '').trim();
  if (!key) return res.status(400).json({ error: 'Missing key' });
  try {
    const check = await fetchWithTimeout('https://api.torbox.app/v1/api/torrents/mylist', {
      headers: { Authorization: `Bearer ${key}` }
    }, 5000);
    if (!check.ok) return res.status(400).json({ error: 'Invalid TorBox API key' });
  } catch (e) {
    return res.status(400).json({ error: 'Could not verify key with TorBox — try again' });
  }
  res.json({ token: encryptApiKey(key) });
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
    .error { color: #f87171; font-size: 12px; margin-top: 8px; display: none; }
    .note { color: #666; font-size: 12px; margin-top: 16px; line-height: 1.5; }
    .links { margin-top: 20px; }
    .link-btn { width: 100%; display: block; background: #222; border: 1px solid #444; border-radius: 8px; padding: 10px; color: #ccc; font-size: 13px; text-align: center; text-decoration: none; margin-top: 8px; cursor: pointer; transition: background 0.2s; }
    .link-btn:hover { background: #333; }
    .spinner { display: inline-block; width: 12px; height: 12px; border: 2px solid #555; border-top-color: #fff; border-radius: 50%; animation: spin 0.6s linear infinite; vertical-align: middle; margin-right: 6px; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="card">
    <h1>👑 TorBox Addon</h1>
    <p class="subtitle">Stream your TorBox library in Stremio</p>
    <label for="apikey">Your TorBox API Key</label>
    <input type="text" id="apikey" placeholder="Paste your TorBox API key here" autocomplete="off" autocorrect="off" spellcheck="false">
    <div class="error" id="error"></div>
    <button onclick="generate()">Generate Addon URL</button>
    <div class="result" id="result">
      <div class="result-label">Your personalised addon URL:</div>
      <div class="url-box" id="url-box"></div>
      <button class="copy-btn" onclick="copyUrl()">Copy URL</button>
      <p class="note">Paste the URL into Stremio → Addons → Community Addons → paste URL.</p>
      <div class="links">
        <div class="result-label">Quick links — bookmark <span id="hub-link"></span> to get back here without re-entering your key:</div>
        <a class="link-btn" id="link-movie" href="#">Debug: Movies</a>
        <a class="link-btn" id="link-series" href="#">Debug: Series</a>
        <button class="link-btn" id="btn-refresh" onclick="refreshCache()">Refresh Cache</button>
      </div>
    </div>
  </div>
  <script>
    async function generate() {
      const key = document.getElementById('apikey').value.trim();
      const errorEl = document.getElementById('error');
      if (!key) { errorEl.textContent = 'Please enter your TorBox API key'; errorEl.style.display = 'block'; return; }
      errorEl.style.display = 'none';
      const res = await fetch('/encrypt', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key })
      });
      const data = await res.json();
      if (!res.ok) { errorEl.textContent = data.error; errorEl.style.display = 'block'; return; }
      const token = data.token;
      const base = window.location.origin;
      const manifestUrl = base + '/' + token + '/manifest.json';
      document.getElementById('url-box').textContent = manifestUrl;
      document.getElementById('link-movie').href = base + '/' + token + '/debug/movie';
      document.getElementById('link-series').href = base + '/' + token + '/debug/series';
      document.getElementById('btn-refresh').dataset.url = base + '/' + token + '/refresh';
      document.getElementById('hub-link').textContent = base + '/' + token;
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
    async function refreshCache() {
      const btn = document.getElementById('btn-refresh');
      btn.innerHTML = '<span class="spinner"></span>Refreshing...';
      try {
        const res = await fetch(btn.dataset.url);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        btn.textContent = '✓ ' + data.message;
      } catch (e) {
        console.error('Refresh failed:', e);
        btn.textContent = '✗ Failed: ' + e.message;
      }
      setTimeout(() => { btn.textContent = 'Refresh Cache'; }, 4000);
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
  // \s doesn't match literal dots, so normalize separators first.
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

// Language-independent fallback: 2+ files with S01E01-style numbering means
// series, regardless of what language the outer torrent name uses.
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

// ── Title cleaning: cuts at whichever junk pattern starts earliest, instead
// of a fixed sequence (which breaks when one pattern eats text another needs)

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

// minIndex 1 skips a match at position 0 (e.g. a movie titled "1917").
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

// ── TMDB matching: exact → no article → pre-colon → fuzzy word overlap with
// year adjustment. No single-result shortcut — a wrong match is worse than none.

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

// Reverse of getImdbId — gets a title back from an imdbId, for the stream fallback.
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

  if (cache.torboxLibrary && now < cache.torboxLibraryExpiry) {
    return cache.torboxLibrary;
  }

  // Same stale-while-revalidate as getTorrentIndex — serve stale, refresh
  // in the background, never block on TTL expiry alone.
  if (cache.torboxLibrary) {
    if (!cache.torboxLibraryRefreshing) {
      cache.torboxLibraryRefreshing = true;
      fetchTorboxLibrary(apiKey, retries)
        .catch(e => console.error('Background library refresh failed:', e.message))
        .finally(() => { cache.torboxLibraryRefreshing = false; });
    }
    return cache.torboxLibrary;
  }

  // Nothing cached yet — must wait on a real fetch.
  return fetchTorboxLibrary(apiKey, retries);
}

async function fetchTorboxLibrary(apiKey, retries) {
  const cache = getCache(apiKey);

  // Share one in-flight fetch instead of firing duplicates.
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
    // Fall back to stale on total failure; only throw if nothing's cached.
    if (cache.torboxLibrary) return cache.torboxLibrary;
    throw new Error('TorBox library unavailable and nothing cached yet');
  })();

  try {
    return await cache.torboxLibraryPromise;
  } finally {
    cache.torboxLibraryPromise = null;
  }
}

// Precomputes the torrent → TMDB/IMDB mapping once per cycle instead of live
// per-request. Stale-while-revalidate: never blocks — serves whatever's
// cached (even empty) while a fresh copy builds in the background.
async function getTorrentIndex(apiKey) {
  const cache = getCache(apiKey);
  const now = Date.now();

  if (cache.torrentIndex && now < cache.torrentIndexExpiry) {
    return cache.torrentIndex;
  }

  if (!cache.torrentIndexRefreshing) {
    cache.torrentIndexRefreshing = true;
    rebuildTorrentIndex(apiKey)
      .catch(e => console.error('Background index rebuild failed:', e.message))
      .finally(() => { cache.torrentIndexRefreshing = false; });
  }
  return cache.torrentIndex || []; // serve stale/empty, refresh happening in the background
}

async function rebuildTorrentIndex(apiKey) {
  const cache = getCache(apiKey);
  let torrents;
  try {
    // fetchTorboxLibrary directly, not getTorboxLibrary — a rebuild needs
    // genuinely fresh data, not stale-while-revalidate's cached copy.
    torrents = await fetchTorboxLibrary(apiKey, 2);
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
    // Bounded concurrency instead of firing every torrent at once; the
    // outer timeout stops one stuck item from wedging the rebuild forever.
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
  // 4k and 2160p are the same thing — normalize so labeling/bingeGroup match.
  const rawRes = filename.match(/\b(2160p|4k|1080p|720p|576p|480p)\b/i)?.[1] ||
                 title.match(/\b(2160p|4k|1080p|720p|576p|480p)\b/i)?.[1] || null;
  const res = rawRes && rawRes.toLowerCase() === '4k' ? '2160p' : rawRes;
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
  // Raw filename first — aggregator parsers verify against this directly.
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

  // Plain label for bingeGroup, separate from the emoji display version.
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
      // Index doesn't have this episode yet (cold, or indexed but this
      // specific file wasn't). Try one live check: real title for this
      // imdbId, matched against the current library. Capped at 7s —
      // outright failures are caught by the handler's own try/catch;
      // this covers TorBox/TMDB being merely slow instead.
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
            // Word overlap alone lets a different-year remake through — check year too.
            const torrentYear = extractYear(torrent.name);
            if (targetYear && torrentYear && Math.abs(targetYear - torrentYear) > 1) return false;
            return true;
          });
          return buildPairs(candidates);
        })(), 7000);
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
          // Groups by quality so auto-advance matches tiers.
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

// Self-serve diagnostics — shows each torrent's detected type, cleaned
// title, TMDB match, or the exact reason it failed to match.
function renderDebugHtml(type, results) {
  const ok = results.filter(r => !r.issue).length;
  const rows = results.map(r => `
    <div class="row ${r.issue ? 'warn' : 'ok'}" data-search="${(r.torrent + ' ' + (r.cleanedTitle || '')).toLowerCase().replace(/"/g, '')}">
      <div class="torrent">${r.torrent}</div>
      <div class="fields">
        <span><b>Type:</b> ${r.detectedType}</span>
        ${r.cleanedTitle ? `<span><b>Title:</b> ${r.cleanedTitle}</span>` : ''}
        ${r.extractedYear ? `<span><b>Year:</b> ${r.extractedYear}</span>` : ''}
        ${r.tmdbMatch ? `<span><b>TMDB:</b> ${r.tmdbMatch} (${r.tmdbId})</span>` : ''}
        ${r.imdbId ? `<span><b>IMDB:</b> ${r.imdbId}</span>` : ''}
      </div>
      ${r.issue ? `<div class="issue">⚠️ ${r.issue}</div>` : ''}
    </div>`).join('');

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Debug: ${type}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #0f0f0f; color: #fff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 24px; max-width: 700px; margin: 0 auto; }
    h1 { font-size: 20px; margin-bottom: 4px; text-transform: capitalize; }
    .subtitle { color: #888; font-size: 13px; margin-bottom: 16px; }
    input#search { width: 100%; background: #1a1a1a; border: 1px solid #333; border-radius: 8px; padding: 10px 14px; color: #fff; font-size: 14px; outline: none; margin-bottom: 16px; }
    input#search:focus { border-color: #7c3aed; }
    .row { background: #1a1a1a; border-radius: 10px; padding: 14px 16px; margin-bottom: 10px; border-left: 3px solid #059669; }
    .row.warn { border-left-color: #d97706; }
    .torrent { font-size: 13px; color: #ddd; word-break: break-all; margin-bottom: 8px; }
    .fields { display: flex; flex-wrap: wrap; gap: 4px 16px; font-size: 12px; color: #999; }
    .fields b { color: #ccc; font-weight: 600; }
    .issue { color: #f59e0b; font-size: 12px; margin-top: 8px; }
  </style>
</head>
<body>
  <h1>Debug: ${type}</h1>
  <p class="subtitle">${ok} of ${results.length} matched</p>
  <input type="text" id="search" placeholder="Search...">
  <div id="rows">${rows}</div>
  <script>
    document.getElementById('search').addEventListener('input', e => {
      const q = e.target.value.toLowerCase();
      document.querySelectorAll('#rows .row').forEach(row => {
        row.style.display = row.dataset.search.includes(q) ? '' : 'none';
      });
    });
  </script>
</body>
</html>`;
}

app.get('/:apiKey/debug/:type', async (req, res) => {
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

    if (req.query.format === 'json') {
      res.setHeader('Content-Type', 'application/json');
      return res.json(results);
    }
    res.setHeader('Content-Type', 'text/html');
    res.send(renderDebugHtml(type, results));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/:apiKey/refresh', async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const { apiKey } = req.params;
  caches.delete(apiKey);
  try {
    // Render's own platform timeout (not configurable) sits around 15-30s —
    // this must respond well under that or Render kills the connection
    // before this code gets a chance to, which looks identical to a client
    // network failure and logs nothing.
    await withTimeout(rebuildTorrentIndex(apiKey), 12000);
    res.json({ success: true, message: 'Cache cleared and rebuilt' });
  } catch (e) {
    console.error('/refresh: rebuild did not finish in time:', e.message);
    res.json({ success: true, message: 'Cache cleared; rebuild still in progress, check again shortly' });
  }
});

app.get('/configure', (req, res) => res.redirect('/'));

app.get('/:key', (req, res) => {
  const { key } = req.params;
  const realKey = decryptApiKey(key);
  if (!realKey) return res.redirect('/');
  const cache = getCache(realKey);
  const status = cache.torrentIndex && cache.torrentIndexExpiry
    ? `${cache.torrentIndex.length} items · synced ${Math.max(0, Math.round((Date.now() - (cache.torrentIndexExpiry - TORBOX_CACHE_TTL)) / 60000))}m ago`
    : 'Not yet synced — visit a catalog or hit refresh';
  const base = `${req.protocol}://${req.get('host')}`;
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>TorBox Addon Hub</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #0f0f0f; color: #fff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
    .card { background: #1a1a1a; border-radius: 16px; padding: 40px; max-width: 480px; width: 100%; }
    h1 { font-size: 24px; margin-bottom: 8px; }
    .status { color: #888; font-size: 12px; margin-bottom: 20px; }
    .url-box { background: #111; border: 1px solid #333; border-radius: 8px; padding: 12px 16px; font-size: 13px; word-break: break-all; color: #a78bfa; margin-bottom: 12px; }
    .copy-btn { width: 100%; background: #222; border: 1px solid #444; border-radius: 8px; padding: 10px; color: #fff; font-size: 14px; cursor: pointer; }
    .link-btn { width: 100%; display: block; background: #222; border: 1px solid #444; border-radius: 8px; padding: 10px; color: #ccc; font-size: 13px; text-align: center; text-decoration: none; margin-top: 8px; cursor: pointer; }
    .result-label { font-size: 13px; color: #aaa; margin: 20px 0 8px; }
    .spinner { display: inline-block; width: 12px; height: 12px; border: 2px solid #555; border-top-color: #fff; border-radius: 50%; animation: spin 0.6s linear infinite; vertical-align: middle; margin-right: 6px; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="card">
    <h1>👑 TorBox Addon Hub</h1>
    <div class="status">${status}</div>
    <div class="url-box">${base}/${key}/manifest.json</div>
    <button class="copy-btn" onclick="copyUrl()">Copy URL</button>
    <div class="result-label">Quick links:</div>
    <a class="link-btn" href="${base}/${key}/debug/movie">Debug: Movies</a>
    <a class="link-btn" href="${base}/${key}/debug/series">Debug: Series</a>
    <button class="link-btn" id="btn-refresh" onclick="refreshCache()">Refresh Cache</button>
  </div>
  <script>
    function copyUrl() {
      navigator.clipboard.writeText('${base}/${key}/manifest.json').then(() => {
        const btn = document.querySelector('.copy-btn');
        btn.textContent = 'Copied!';
        setTimeout(() => btn.textContent = 'Copy URL', 2000);
      });
    }
    async function refreshCache() {
      const btn = document.getElementById('btn-refresh');
      btn.innerHTML = '<span class="spinner"></span>Refreshing...';
      try {
        const res = await fetch('${base}/${key}/refresh');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        btn.textContent = '✓ ' + data.message;
      } catch (e) {
        console.error('Refresh failed:', e);
        btn.textContent = '✗ Failed: ' + e.message;
      }
      setTimeout(() => { btn.textContent = 'Refresh Cache'; }, 4000);
    }
  </script>
</body>
</html>`);
});

app.listen(3000, () => {
  console.log('TorBox addon running');
  for (const key of WARM_API_KEYS) {
    getTorrentIndex(key).catch(e => console.error('Warm-up failed for a configured key:', e.message));
  }
});
