const express = require('express');
const app = express();
const manifest = require('./manifest.json');

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

app.get('/', (req, res) => res.json(manifest));
app.get('/manifest.json', (req, res) => res.json(manifest));

app.listen(3000, () => console.log('Addon running on port 3000'));
