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

function cleanTitle(name) {
 return name
   .replace(/\.(mkv|mp4|avi)$/i, '')
   .replace(/[\._]/g, ' ')
   .replace(/\b(19|20)\d{2}\b.*/, '')
   .replace(/\b(1080p|720p|4k|bluray|webrip|hdtv|x264|x265|hevc)\b.*/i, '')
   .trim();
}

function extractYear(name) {
 const match = name.match(/\b(19|20)(\d{2})\b/);
 return match ? parseInt(match[0]) : null;
}

async function getTorboxLibrary() {
 const res = await fetch('https://api.torbox.app/v1/api/torrents/mylist', {
   headers: { Authorization: `Bearer ${TORBOX_API_KEY}` }
 });
 const json = await res.json();
 return json.data || [];
}

function normalizeTitle(str) {
  return str.toLowerCase().replace(/[^a-z0-9]/g, '').trim();
}

async function searchTmdb(title, year, type) {
  const endpoint = type === 'movie' ? 'movie' : 'tv';
  const yearParam = year ? `&year=${year}` : '';
  const url = `https://api.themoviedb.org/3/search/${endpoint}?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(title)}${yearParam}`;
  const res = await fetch(url);
  const json = await res.json();

  const normalizedSearch = normalizeTitle(title);

  // Find the first result whose title is an exact normalized match
  const exact = json.results?.find(r => {
    const resultTitle = normalizeTitle(r.title || r.name || '');
    return resultTitle === normalizedSearch;
  });

  // Fall back to first result only if nothing matched exactly
  return exact || null;
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
   const { type, id } = req.params;
   const torrents = await getTorboxLibrary();

   const matches = await Promise.all(
     torrents.map(async (torrent) => {
       try {
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
