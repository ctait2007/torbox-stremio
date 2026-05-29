const express = require('express');
const app = express();
const manifest = require('./manifest.json');

const TORBOX_API_KEY = process.env.TORBOX_API_KEY;
const TMDB_API_KEY = process.env.TMDB_API_KEY;

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
  if (/\(S\d+/i.test(name)) return 'series';
  if (/INTEGRALE/i.test(name)) return 'series';
  if (/\bLF[_\s]/i.test(name)) return 'series';  // ← LF_ is a complete series tag
  return 'movie';
}

function cleanTitle(name) {
  return name
    .replace(/\.(mkv|mp4|avi|mov|wmv)$/i, '')
    .replace(/\[.*?\]/g, '')
    .replace(/\(S\d+.*?\)/gi, '')
    .replace(/Complete\s*Series.*/gi, '')
    .replace(/INTEGRALE.*/i, '')
    .replace(/\bLF[_\s].*/i, '')               // ← strip LF_ and everything after
    .replace(/S\d{2}(E\d{2})?.*$/i, '')
    .replace(/Season\s*\d+.*/i, '')
    .replace(/\b(19|20)\d{2}\b.*/, '')
    .replace(/\b(MULTi|MULTI|VFF|VF|VO|VOST|TRUEFRENCH)\b.*/i, '')
    .replace(/\b(LF|proper|repack|extended|theatrical|directors.cut)\b.*/i, '')
    .replace(/\b(1080p|720p|2160p|4k|bluray|bdrip|webrip|web-dl|web|hdtv|x264|x265|hevc|aac|dd5|h264|h265|remux|hdlight|10bit|ac3)\b.*/i, '')
    .replace(/[\._]/g, ' ')
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

async function getTorboxLibrary() {
 const res = await fetch('https://api.torbox.app/v1/api/torrents/mylist', {
   headers: { Authorization: `Bearer ${TORBOX_API_KEY}` }
 });
 const json = await res.json();
 return json.data || [];
}

async function searchTmdb(title, year, type) {
  const url = `https://api.themoviedb.org/3/search/multi?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(title)}`;
  const res = await fetch(url);
  const json = await res.json();

  const normalizedSearch = normalizeTitle(title);
  const tmdbType = type === 'series' ? 'tv' : 'movie';

  // exact title match
  let match = json.results?.find(r => {
    if (r.media_type !== tmdbType) return false;
    const resultTitle = normalizeTitle(r.title || r.name || '');
    return resultTitle === normalizedSearch;
  });

  // colon subtitle match e.g. "Scream: The TV Series" → "Scream"
  if (!match) {
    match = json.results?.find(r => {
      if (r.media_type !== tmdbType) return false;
      const beforeColon = normalizeTitle((r.title || r.name || '').split(':')[0]);
      return beforeColon === normalizedSearch;
    });
  }

  return match || null;
}


async function getImdbId(tmdbId, type) {
 const endpoint = type === 'movie' ? 'movie' : 'tv';
 const res = await fetch(
   `https://api.themoviedb.org/3/${endpoint}/${tmdbId}/external_ids?api_key=${TMDB_API_KEY}`
 );
 const json = await res.json();
 return json.imdb_id || null;
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
   description: tmdb.overview,
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

   res.json({ metas: results.filter(Boolean) });
 } catch (err) {
   console.error(err);
   res.status(500).json({ metas: [] });
 }
});

app.get('/meta/:type/:id.json', async (req, res) => {
 try {
   const { type, id } = req.params;
   const torrents = await getTorboxLibrary();

   for (const torrent of torrents) {
     try {
       const detectedType = detectType(torrent.name);
       if (detectedType !== type) continue;

       const title = cleanTitle(torrent.name);
       const year = extractYear(torrent.name);
       const tmdb = await searchTmdb(title, year, type);
       if (!tmdb) continue;
       const imdbId = await getImdbId(tmdb.id, type);
       if (imdbId !== id) continue;
       return res.json({ meta: toMeta(tmdb, imdbId, torrent.id, type) });
     } catch (e) {
       continue;
     }
   }

   res.json({ meta: {} });
 } catch (err) {
   console.error(err);
   res.json({ meta: {} });
 }
});

app.get('/stream/:type/:id.json', async (req, res) => {
  try {
    const { type } = req.params;
    const rawId = req.params.id;
    
    // Stremio sends tt1234567:1:1 for series — strip season/episode
    const id = rawId.split(':')[0];

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

    const torrent = matches.find(Boolean);
    if (!torrent || !torrent.files?.length) return res.json({ streams: [] });

    const streams = torrent.files.map(file => ({
      url: `https://api.torbox.app/v1/api/torrents/requestdl?token=${TORBOX_API_KEY}&torrent_id=${torrent.id}&file_id=${file.id}&redirect=true`,
      title: file.name || 'Play'
    }));

    res.json({ streams });
  } catch (err) {
    console.error(err);
    res.json({ streams: [] });
  }
});


app.get('/manifest.json', (req, res) => res.json(manifest));
app.get('/', (req, res) => res.json(manifest));

app.listen(3000, () => console.log('TorBox addon running'));

app.get('/debug', async (req, res) => {
  const torrents = await getTorboxLibrary();
  const debug = torrents.map(t => ({
    original: t.name,
    cleaned: cleanTitle(t.name),
    detectedType: detectType(t.name)
  }));
  res.json(debug);
});

app.get('/debug-stream/:type/:id', async (req, res) => {
  const { type, id } = req.params;
  const torrents = await getTorboxLibrary();

  const results = await Promise.all(
    torrents.map(async (torrent) => {
      try {
        const detectedType = detectType(torrent.name);
        const title = cleanTitle(torrent.name);
        const year = extractYear(torrent.name);
        const tmdb = await searchTmdb(title, year, type);
        const imdbId = tmdb ? await getImdbId(tmdb.id, type) : null;
        return {
          torrent: torrent.name,
          detectedType,
          title,
          imdbId,
          matchesRequested: imdbId === id,
          fileCount: torrent.files?.length || 0
        };
      } catch (e) {
        return { torrent: torrent.name, error: e.message };
      }
    })
  );

  res.json(results);
});
app.get('/debug-files/:id', async (req, res) => {
  const torrents = await getTorboxLibrary();
  const torrent = torrents.find(t => String(t.id) === req.params.id);
  res.json(torrent || { error: 'not found' });
});
