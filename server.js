const express = require('express');
const app = express();
const manifest = require('./manifest.json');

const TORBOX_API_KEY = process.env.TORBOX_API_KEY;
const TMDB_API_KEY = process.env.TMDB_API_KEY;

const cache = {
  torboxLibrary: null,
  torboxLibraryExpiry: 0,
  tmdb: new Map(),
  imdbId: new Map()
};

const TORBOX_CACHE_TTL = 60 * 60 * 1000;
const TMDB_CACHE_TTL = 24 * 60 * 60 * 1000;

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  next();
});

function detectType(name) {
  if (/S\d{2}E\d{2}/i.test(name)) return 'series';
  if (/S\d{2}\b/i.test(name)) return 'series';
  if (/Season\s*\d+/i.test(name)) return 'series';
  if (/\d+x\d+/i.test(name)) return 'series';
  if (/Complete\s*Series/i.test(name)) return 'series';
  if (/Complete\s*Collection/i.test(name)) return 'series';
  if (/\(S\d+/i.test(name)) return 'series';
  if (/INTEGRALE/i.test(name)) return 'series';
  if (/Stagione/i.test(name)) return 'series';     // Italian
if (/Temporada/i.test(name)) return 'series';    // Spanish/Portuguese
if (/Staffel/i.test(name)) return 'series';      // German
if (/Saison/i.test(name)) return 'series';       // French
if (/Сезон/i.test(name)) return 'series';        // Russian
if (/COMPLETA|COMPLETO|COMPLETE/i.test(name)) return 'series';
  if (/\bLF[_\s]/i.test(name)) return 'series';
  return 'movie';
}

function cleanTitle(name) {
  return name
    .replace(/\.(mkv|mp4|avi|mov|wmv)$/i, '')
    .replace(/\[.*?\]/g, '')
    .replace(/\(S\d+.*?\)/gi, '')
    .replace(/Complete\s*Series.*/gi, '')
    .replace(/Complete\s*Collection.*/gi, '')
    .replace(/INTEGRALE.*/i, '')
    .replace(/Stagione\s*\d+.*/i, '')    // Italian
.replace(/Temporada\s*\d+.*/i, '')   // Spanish/Portuguese
.replace(/Staffel\s*\d+.*/i, '')     // German
.replace(/Saison\s*\d+.*/i, '')      // French
.replace(/Сезон\s*\d+.*/i, '')       // Russian
.replace(/COMPLETA.*/i, '')
.replace(/COMPLETO.*/i, '')
    .replace(/\bLF[_\s].*/i, '')
    .replace(/S\d{2}(E\d{2})?.*$/i, '')
    .replace(/Season\s*\d+.*/i, '')
    .replace(/\b(19|20)\d{2}\b.*/, '')
    .replace(/\b(MULTi|MULTI|VFF|VF|VO|VOST|TRUEFRENCH|ITA|ENG|SPA|POR|RUS|RU|RUSENG|JPN|GER|FRE|FRA|DUT|NLD|SWE|NOR|DAN|FIN|POL|CZE|HUN|ROM|TUR|KOR|CHI|ARA|HEB|HIN|THA|VIE|IND|DUBBED|SUBBED|DUAL|MULTI5|MULTI6|MULTISUB)\b.*/i, '')
    .replace(/\b(LF|proper|repack|extended|theatrical|directors.cut)\b.*/i, '')
    .replace(/\b(1080p|720p|2160p|4k|bluray|bdrip|webrip|web-dl|web|hdtv|x264|x265|hevc|aac|dd5|h264|h265|remux|hdlight|10bit|ac3)\b.*/i, '')
    .replace(/[\._]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[\s\-\(]+$/, '')  // strip trailing junk
.replace(/\s*-\s*(the|a|an)\s*$/i, '')  // strip trailing "- The" etc
.replace(/[\s\-\(]+$/, '')               // strip remaining trailing junk
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
    '2160p': '⭐️ 4K',
    '1080p': '💎 1080p',
    '720p': '💿 720p',
    '576p': '📀 SD',
    '480p': '📀 LQ'
  }[res.toLowerCase()] || `📺 ${res}`) : '⁉️ Unknown';

  const episodeTag = (season !== null && episode !== null)
    ? ` • S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`
    : '';
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

  const sizeStr = filesize > 0
    ? `📦 ${(filesize / 1024 / 1024 / 1024).toFixed(2)} GB`
    : null;
  const containerStr = container ? `.${container.toLowerCase()}` : null;
  const line5 = [sizeStr, containerStr].filter(Boolean).join(' ➤ ');

  return [line1, line2, line3, line4, line5].filter(Boolean).join('\n');
}

async function getTorboxLibrary() {
  const now = Date.now();
  if (cache.torboxLibrary && now < cache.torboxLibraryExpiry) {
    return cache.torboxLibrary;
  }
  const res = await fetch('https://api.torbox.app/v1/api/torrents/mylist', {
    headers: { Authorization: `Bearer ${TORBOX_API_KEY}` }
  });
  const json = await res.json();
  cache.torboxLibrary = json.data || [];
  cache.torboxLibraryExpiry = now + TORBOX_CACHE_TTL;
  return cache.torboxLibrary;
}

async function searchTmdb(title, year, type, retries = 3) {
  const cacheKey = `${title}:${type}`;
  const cached = cache.tmdb.get(cacheKey);
  if (cached && Date.now() < cached.expiry) return cached.value;

  for (let i = 0; i < retries; i++) {
    try {
      const url = `https://api.themoviedb.org/3/search/multi?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(title)}`;
      const res = await fetch(url);
      const json = await res.json();

      const normalizedSearch = normalizeTitle(title);
      const tmdbType = type === 'series' ? 'tv' : 'movie';

      let match = json.results?.find(r => {
        if (r.media_type !== tmdbType) return false;
        const resultTitle = normalizeTitle(r.title || r.name || '');
        return resultTitle === normalizedSearch;
      });

      if (!match) {
        match = json.results?.find(r => {
          if (r.media_type !== tmdbType) return false;
          const beforeColon = normalizeTitle((r.title || r.name || '').split(':')[0]);
          return beforeColon === normalizedSearch;
        });
      }

      if (match) {
        cache.tmdb.set(cacheKey, { value: match, expiry: Date.now() + TMDB_CACHE_TTL });
        return match;
      }
    } catch (e) {
      console.error(`TMDB search attempt ${i + 1} failed for "${title}":`, e.message);
    }
    if (i < retries - 1) await new Promise(r => setTimeout(r, 500));
  }

  return null;
}

async function getImdbId(tmdbId, type, retries = 3) {
  const cacheKey = `${tmdbId}:${type}`;
  const cached = cache.imdbId.get(cacheKey);
  if (cached && Date.now() < cached.expiry) return cached.value;

  const endpoint = type === 'movie' ? 'movie' : 'tv';
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(
        `https://api.themoviedb.org/3/${endpoint}/${tmdbId}/external_ids?api_key=${TMDB_API_KEY}`
      );
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
    id: imdbId,
    type,
    name: tmdb.title || tmdb.name,
    poster: tmdb.poster_path
      ? `https://image.tmdb.org/t/p/w500${tmdb.poster_path}`
      : null,
    background: tmdb.backdrop_path
      ? `https://image.tmdb.org/t/p/original${tmdb.backdrop_path}`
      : null,
    releaseInfo: (tmdb.release_date || tmdb.first_air_date || '').slice(0, 4),
    imdbRating: tmdb.vote_average?.toFixed(1),
    torrentId
  };
}

app.get('/catalog/:type/:id.json', async (req, res) => {
  try {
    const { type } = req.params;
    const torrents = await getTorboxLibrary();

    const results = await Promise.all(
      torrents.map(async (torrent) => {
        try {
          const detectedType = detectType(torrent.name);
          if (detectedType !== type) return null;

          const title = cleanTitle(torrent.name);
          const year = extractYear(torrent.name);
          const tmdb = await searchTmdb(title, year, type);
          if (!tmdb) return null;
          const imdbId = await getImdbId(tmdb.id, type);
          if (!imdbId) return null;
          return toMeta(tmdb, imdbId, torrent.id, type);
        } catch (e) {
          return null;
        }
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

app.get('/stream/:type/:id.json', async (req, res) => {
 try {
   const { type } = req.params;
   const rawId = req.params.id;
   const parts = rawId.split(':');
   const id = parts[0];
   const season = parts[1] ? parseInt(parts[1]) : null;
   const episode = parts[2] ? parseInt(parts[2]) : null;

   const torrents = await getTorboxLibrary();

   const matches = await Promise.all(
     torrents.map(async (torrent) => {
       try {
         const detectedType = detectType(torrent.name);
         if (detectedType !== type) return null;

         const title = cleanTitle(torrent.name);
         const year = extractYear(torrent.name);
         const tmdb = await searchTmdb(title, year, type);
         if (!tmdb) return null;
         const imdbId = await getImdbId(tmdb.id, type);
         if (imdbId !== id) return null;
         return torrent;
       } catch (e) {
         return null;
       }
     })
   );

   const allMatches = matches.filter(Boolean);
   if (!allMatches.length) return res.json({ streams: [] });

   // Collect { file, torrent } pairs
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
         pairs = filtered.map(f => ({ file: f, torrent }));
         break;
       }
     }
   } else {
     // Movies — best file from each matching torrent
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
     url: `https://api.torbox.app/v1/api/torrents/requestdl?token=${TORBOX_API_KEY}&torrent_id=${torrent.id}&file_id=${file.id}&redirect=true`,
     name: '👑 Library ⚡️',
     description: formatStreamDescription(
       file.short_name || file.name || '',
       cleanTitle(torrent.name),
       season,
       episode,
       file.size || 0
     )
   }));

   res.json({ streams });
 } catch (err) {
   console.error(err);
   res.json({ streams: [] });
 }
});

app.get('/manifest.json', (req, res) => res.json(manifest));
app.get('/', (req, res) => res.json(manifest));

app.get('/debug-files/:id', async (req, res) => {
  const torrents = await getTorboxLibrary();
  const torrent = torrents.find(t => String(t.id) === req.params.id);
  res.json(torrent || { error: 'not found' });
});

app.get('/refresh', (req, res) => {
  cache.torboxLibrary = null;
  cache.torboxLibraryExpiry = 0;
  cache.tmdb.clear();
  cache.imdbId.clear();
  res.json({ success: true, message: 'Cache cleared' });
});

app.listen(3000, () => console.log('TorBox addon running'));
