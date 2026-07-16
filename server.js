const express = require('express');
const app = express();
const baseManifest = require('./manifest.json');

const TMDB_API_KEY = process.env.TMDB_API_KEY;

const caches = new Map();
const TORBOX_CACHE_TTL = 60 * 60 * 1000;
const TMDB_CACHE_TTL = 24 * 60 * 60 * 1000;

function getCache(apiKey) {
  if (!caches.has(apiKey)) {
    caches.set(apiKey, {
      torboxLibrary: null,
      torboxLibraryExpiry: 0,
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function detectType(name) {
  if (/S\d{2}E\d{2}/i.test(name)) return 'series';
  if (/S\d{2}\b/i.test(name)) return 'series';
  if (/Season\s*\d+/i.test(name)) return 'series';
  if (/Stagione\s*\d+/i.test(name)) return 'series';
  if (/Temporada\s*\d+/i.test(name)) return 'series';
  if (/Staffel\s*\d+/i.test(name)) return 'series';
  if (/Saison\s*\d+/i.test(name)) return 'series';
  if (/Сезон\s*\d+/i.test(name)) return 'series';
  if (/\d+x\d+/i.test(name)) return 'series';
  if (/Complete\s*Series/i.test(name)) return 'series';
  if (/Complete\s*Collection/i.test(name)) return 'series';
  if (/\(S\d+/i.test(name)) return 'series';
  if (/INTEGRALE/i.test(name)) return 'series';
  if (/COMPLETA|COMPLETO/i.test(name)) return 'series';
  if (/\bLF[_\s]/i.test(name)) return 'series';
  return 'movie';
}

async function resolveSeriesType(tmdbId, apiKey) {
  const cache = getCache(apiKey);
  const cacheKey = `keywords:${tmdbId}`;
  const cached = cache.tmdb.get(cacheKey);
  if (cached && Date.now() < cached.expiry) return cached.value;
  try {
    const res = await fetch(
      `https://api.themoviedb.org/3/tv/${tmdbId}/keywords?api_key=${TMDB_API_KEY}`
    );
    const json = await res.json();
    const isAnime = (json.results || []).some(k => k.id === 210024);
    const resolved = isAnime ? 'anime' : 'series';
    cache.tmdb.set(cacheKey, { value: resolved, expiry: Date.now() + TMDB_CACHE_TTL });
    return resolved;
  } catch (e) {
    return 'series';
  }
}

function cleanTitle(name) {
  return name
    .replace(/\.(mkv|mp4|avi|mov|wmv)$/i, '')
    .replace(/\[.*?\]/g, '')
    .replace(/\(S\d+.*?\)/gi, '')
    .replace(/Complete\s*Series.*/gi, '')
    .replace(/Complete\s*Collection.*/gi, '')
    .replace(/INTEGRALE.*/i, '')
    .replace(/COMPLETA.*/i, '')
    .replace(/COMPLETO.*/i, '')
    .replace(/\bLF[_\s].*/i, '')
    .replace(/S\d{2}(E\d{2})?.*$/i, '')
    .replace(/Season\s*\d+.*/i, '')
    .replace(/Stagione\s*\d+.*/i, '')
    .replace(/Temporada\s*\d+.*/i, '')
    .replace(/Staffel\s*\d+.*/i, '')
    .replace(/Saison\s*\d+.*/i, '')
    .replace(/Сезон\s*\d+.*/i, '')
    .replace(/\b(19|20)\d{2}\b.*/, '')
    .replace(/\b(MULTi|MULTI|VFF|VF|VO|VOST|TRUEFRENCH|ITA|ENG|SPA|POR|RUS|RU|RUSENG|JPN|GER|FRE|FRA|DUT|NLD|SWE|NOR|DAN|FIN|POL|CZE|HUN|ROM|TUR|KOR|CHI|ARA|HEB|HIN|THA|VIE|IND|DUBBED|SUBBED|DUAL|MULTI5|MULTI6|MULTISUB)\b.*/i, '')
    .replace(/\b(LF|proper|repack|extended|theatrical|directors.cut)\b.*/i, '')
    .replace(/\b(1080p|720p|2160p|4k|bluray|bdrip|webrip|web-dl|web|hdtv|x264|x265|hevc|aac|dd5|h264|h265|remux|hdlight|10bit|ac3)\b.*/i, '')
    .replace(/[\._]/g, ' ')
    .replace(/\s*-\s*(the|a|an)\s*$/i, '')
    .replace(/[\s\-\(]+$/, '')
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
  return [line1, line2, line3, line4, line5].filter(Boolean).join('\n');
}

async function getTorboxLibrary(apiKey) {
  const cache = getCache(apiKey);
  const now = Date.now();
  if (cache.torboxLibrary && now < cache.torboxLibraryExpiry) return cache.torboxLibrary;
  const res = await fetch('https://api.torbox.app/v1/api/torrents/mylist', {
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  const json = await res.json();
  cache.torboxLibrary = json.data || [];
  cache.torboxLibraryExpiry = now + TORBOX_CACHE_TTL;
  return cache.torboxLibrary;
}

async function searchTmdb(title, year, type, apiKey, retries = 3) {
  const cache = getCache(apiKey);
  const cacheKey = `${title}:${type}`;
  const cached = cache.tmdb.get(cacheKey);
  if (cached && Date.now() < cached.expiry) return cached.value;
  const tmdbType = type === 'movie' ? 'movie' : 'tv';
  for (let i = 0; i < retries; i++) {
    try {
      const url = `https://api.themoviedb.org/3/search/multi?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(title)}`;
      const res = await fetch(url);
      const json = await res.json();
      const normalizedSearch = normalizeTitle(title);
      let match = json.results?.find(r => {
        if (r.media_type !== tmdbType) return false;
        return normalizeTitle(r.title || r.name || '') === normalizedSearch;
      });
      if (!match) {
        match = json.results?.find(r => {
          if (r.media_type !== tmdbType) return false;
          return normalizeTitle((r.title || r.name || '').split(':')[0]) === normalizedSearch;
        });
      }
      if (match) {
        cache.tmdb.set(cacheKey, { value: match, expiry: Date.now() + TMDB_CACHE_TTL });
        return match;
      }
    } catch (e) {
      console.error(`TMDB search attempt ${i + 1} failed:`, e.message);
    }
    if (i < retries - 1) await new Promise(r => setTimeout(r, 500));
  }
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
      const res = await fetch(`https://api.themoviedb.org/3/${endpoint}/${tmdbId}/external_ids?api_key=${TMDB_API_KEY}`);
      const json = await res.json();
      if (json.imdb_id) {
        cache.imdbId.set(cacheKey, { value: json.imdb_id, expiry: Date.now() + TMDB_CACHE_TTL });
        return json.imdb_id;
      }
    } catch (e) {
      console.error(`IMDB ID lookup attempt ${i + 1} failed:`, e.message);
    }
    if (i < retries - 1) await new Promise(r => setTimeout(r, 500));
  }
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

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/:apiKey/manifest.json', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const manifest = {
    ...baseManifest,
    id: baseManifest.id + '.' + req.params.apiKey.slice(0, 8),
  };
  res.json(manifest);
});

app.get('/:apiKey/catalog/:type/:id.json', async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  try {
    const { apiKey, type } = req.params;
    const torrentType = type === 'anime' ? 'series' : type;
    const torrents = await getTorboxLibrary(apiKey);

    const results = await Promise.all(
      torrents.map(async (torrent) => {
        try {
          if (detectType(torrent.name) !== torrentType) return null;
          const title = cleanTitle(torrent.name);
          const year = extractYear(torrent.name);
          const tmdb = await searchTmdb(title, year, torrentType, apiKey);
          if (!tmdb) return null;
          if (torrentType === 'series') {
            const resolvedType = await resolveSeriesType(tmdb.id, apiKey);
            if (resolvedType !== type) return null;
          }
          const imdbId = await getImdbId(tmdb.id, torrentType, apiKey);
          if (!imdbId) return null;
          // Return as series so metadata addons like AIO can resolve the show.
          // The anime catalog URL is enough to place it in the anime section.
          const metaType = type === 'anime' ? 'series' : type;
          return toMeta(tmdb, imdbId, torrent.id, metaType);
        } catch (e) { return null; }
      })
    );

    const seen = new Set();
    const deduplicated = results.filter(Boolean).filter(meta => {
      if (seen.has(meta.id)) return false;
      seen.add(meta.id);
      return true;
    });
    res.json({ metas: deduplicated });
  } catch (err) {
    console.error(err);
    res.status(500).json({ metas: [] });
  }
});

// Meta handler — anime only, Cinemeta handles movie and series
app.get('/:apiKey/meta/:type/:id.json', async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  try {
    const { apiKey, type, id } = req.params;
    if (type !== 'anime') return res.json({ meta: null });

    // Find TMDB entry from IMDB ID
    const findRes = await fetch(
      `https://api.themoviedb.org/3/find/${id}?api_key=${TMDB_API_KEY}&external_source=imdb_id`
    );
    const findData = await findRes.json();
    const tvResults = findData.tv_results || [];
    if (!tvResults.length) return res.json({ meta: null });

    const tmdbId = tvResults[0].id;

    // Get full show details including seasons
    const showRes = await fetch(
      `https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${TMDB_API_KEY}`
    );
    const show = await showRes.json();

    // Build season videos for the meta page
    const videos = [];
    for (const season of (show.seasons || [])) {
      if (season.season_number === 0) continue;
      const seasonRes = await fetch(
        `https://api.themoviedb.org/3/tv/${tmdbId}/season/${season.season_number}?api_key=${TMDB_API_KEY}`
      );
      const seasonData = await seasonRes.json();
      for (const ep of (seasonData.episodes || [])) {
        videos.push({
          id: `${id}:${season.season_number}:${ep.episode_number}`,
          title: ep.name || `Episode ${ep.episode_number}`,
          season: season.season_number,
          episode: ep.episode_number,
          overview: ep.overview || '',
          thumbnail: ep.still_path
            ? `https://image.tmdb.org/t/p/w300${ep.still_path}`
            : null,
          released: ep.air_date ? new Date(ep.air_date).toISOString() : null
        });
      }
    }

    const meta = {
      id,
      type,
      name: show.name,
      poster: show.poster_path ? `https://image.tmdb.org/t/p/w500${show.poster_path}` : null,
      background: show.backdrop_path ? `https://image.tmdb.org/t/p/original${show.backdrop_path}` : null,
      description: show.overview || '',
      releaseInfo: (show.first_air_date || '').slice(0, 4),
      imdbRating: show.vote_average?.toFixed(1),
      videos
    };

    res.json({ meta });
  } catch (err) {
    console.error(err);
    res.json({ meta: null });
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

    const torrents = await getTorboxLibrary(apiKey);

    const matches = await Promise.all(
      torrents.map(async (torrent) => {
        try {
          if (detectType(torrent.name) !== torrentType) return null;
          const title = cleanTitle(torrent.name);
          const year = extractYear(torrent.name);
          const tmdb = await searchTmdb(title, year, torrentType, apiKey);
          if (!tmdb) return null;
          const imdbId = await getImdbId(tmdb.id, torrentType, apiKey);
          if (imdbId !== id) return null;
          return torrent;
        } catch (e) { return null; }
      })
    );

    const allMatches = matches.filter(Boolean);
    if (!allMatches.length) return res.json({ streams: [] });

    let pairs = [];

    if (season !== null && episode !== null) {
      const seasonStr = String(season).padStart(2, '0');
      const episodeStr = String(episode).padStart(2, '0');
      const pattern = new RegExp(`(S${seasonStr}[\\s\\-]*E[\\s\\-]*${episodeStr}|${parseInt(season)}[xX]${episodeStr})`, 'i');
      for (const torrent of allMatches) {
        const filtered = (torrent.files || []).filter(f =>
          pattern.test(f.name) &&
          /\.(mkv|mp4|avi|mov|wmv)$/i.test(f.short_name || f.name)
        );
                if (filtered.length > 0) {
          filtered.forEach(f => pairs.push({ file: f, torrent }));
        }

      }
    } else {
      for (const torrent of allMatches) {
        const videoFiles = (torrent.files || []).filter(f =>
          /\.(mkv|mp4|avi|mov|wmv)$/i.test(f.short_name || f.name)
        );
        if (videoFiles.length > 0) {
          videoFiles.sort((a, b) => (b.size || 0) - (a.size || 0));
          pairs.push({ file: videoFiles[0], torrent });
        }
      }
    }

    if (!pairs.length) return res.json({ streams: [] });

    const streams = pairs.map(({ file, torrent }) => ({
      url: `https://api.torbox.app/v1/api/torrents/requestdl?token=${apiKey}&torrent_id=${torrent.id}&file_id=${file.id}&redirect=true`,
      name: '👑 Library ⚡️',
      description: formatStreamDescription(
        file.short_name || file.name || '',
        cleanTitle(torrent.name),
        season, episode,
        file.size || 0
      )
    }));

    res.json({ streams });
  } catch (err) {
    console.error(err);
    res.json({ streams: [] });
  }
});

app.get('/:apiKey/refresh', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const { apiKey } = req.params;
  if (caches.has(apiKey)) caches.delete(apiKey);
  res.json({ success: true, message: 'Cache cleared' });
});

app.get('/configure', (req, res) => res.redirect('/'));

app.listen(3000, () => console.log('TorBox addon running'));
