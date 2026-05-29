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

// Helper: clean torrent name into a searchable title
function cleanTitle(name) {
  return name
    .replace(/\.(mkv|mp4|avi)$/i, '')
    .replace(/[\._]/g, ' ')
    .replace(/\b(19|20)\d{2}\b.*/, '')   // strip year and everything after
    .replace(/\b(1080p|720p|4k|bluray|webrip|hdtv|x264|x265|hevc)\b.*/i, '')
    .trim();
}

// Helper: guess year from torrent name
function extractYear(name) {
  const match = name.match(/\b(19|20)(\d{2})\b/);
  return match ? parseInt(match[0]) : null;
}

// Fetch TorBox library
async function getTorboxLibrary() {
  const res = await fetch('https://api.torbox.app/v1/api/torrents/mylist', {
    headers: { Authorization: `Bearer ${TORBOX_API_KEY}` }
  });
  const json = await res.json();
  return json.data || [];
}

// Search TMDB for a title
async function searchTmdb(title, year, type) {
  const endpoint = type === 'movie' ? 'movie' : 'tv';
  const yearParam = year ? `&year=${year}` : '';
  const url = `https://api.themoviedb.org/3/search/${endpoint}?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(title)}${yearParam}`;
  const res = await fetch(url);
  const json = await res.json();
  return json.results?.[0] || null;
}

// Convert TMDB result to Stremio meta object
function toMeta(tmdb, torrentId, type) {
  const title = tmdb.title || tmdb.name;
  const poster = tmdb.poster_path
    ? `https://image.tmdb.org/t/p/w500${tmdb.poster_path}`
    : null;
  const background = tmdb.backdrop_path
    ? `https://image.tmdb.org/t/p/original${tmdb.backdrop_path}`
    : null;

  return {
    id: `torbox:${torrentId}`,
    type,
    name: title,
    poster,
    background,
    description: tmdb.overview,
    releaseInfo: (tmdb.release_date || tmdb.first_air_date || '').slice(0, 4),
    imdbRating: tmdb.vote_average?.toFixed(1)
  };
}

// Catalog handler
app.get('/catalog/:type/:id.json', async (req, res) => {
  try {
    const { type, id } = req.params;
    const torrents = await getTorboxLibrary();

    const results = await Promise.all(
      torrents.map(async (torrent) => {
        const title = cleanTitle(torrent.name);
        const year = extractYear(torrent.name);
        const tmdb = await searchTmdb(title, year, type);
        if (!tmdb) return null;
        return toMeta(tmdb, torrent.id, type);
      })
    );

    const metas = results.filter(Boolean);
    res.json({ metas });
  } catch (err) {
    console.error(err);
    res.status(500).json({ metas: [] });
  }
});

// Meta handler
app.get('/meta/:type/:id.json', async (req, res) => {
  const { type, id } = req.params;
  const torrentId = id.replace('torbox:', '');

  const torrents = await getTorboxLibrary();
  const torrent = torrents.find(t => String(t.id) === torrentId);
  if (!torrent) return res.json({ meta: {} });

  const title = cleanTitle(torrent.name);
  const year = extractYear(torrent.name);
  const tmdb = await searchTmdb(title, year, type);
  if (!tmdb) return res.json({ meta: {} });

  res.json({ meta: toMeta(tmdb, torrent.id, type) });
});

// Stream handler - uses TorBox permalink
app.get('/stream/:type/:id.json', async (req, res) => {
  const { id } = req.params;
  const torrentId = id.replace('torbox:', '');

  const torrents = await getTorboxLibrary();
  const torrent = torrents.find(t => String(t.id) === torrentId);
  if (!torrent || !torrent.files?.length) return res.json({ streams: [] });

  const streams = torrent.files.map(file => ({
    url: `https://api.torbox.app/v1/api/torrents/requestdl?token=${TORBOX_API_KEY}&torrent_id=${torrentId}&file_id=${file.id}&redirect=true`,
    title: file.name || 'Play'
  }));

  res.json({ streams });
});

app.get('/manifest.json', (req, res) => res.json(manifest));
app.get('/', (req, res) => res.json(manifest));

app.listen(3000, () => console.log('TorBox addon running'));
