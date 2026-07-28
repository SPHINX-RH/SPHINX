// SPHINX — Static server for SPHINX web app
import express from 'express';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB = join(__dirname, 'web');
const APP = join(WEB, 'app');
const PORT = process.env.PORT || 4200;

const app = express();

// No-cache for HTML (prevent stale CDN serving)
app.use((req, res, next) => {
  if (req.path.endsWith('.html') || req.path === '/' || req.path.endsWith('/')) {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
  next();
});

// Landing page
app.use(express.static(WEB));

// App at /app
app.use('/app', express.static(APP));

// Fallback to landing
app.use((req, res) => {
  res.sendFile(join(WEB, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🦁 SPHINX server → http://localhost:${PORT}`);
  console.log(`   Landing:  http://localhost:${PORT}`);
  console.log(`   App:      http://localhost:${PORT}/app`);
});
