import express from 'express';

// Serve the built app only. Never load .env, call live APIs or expose a key.
const app = express();
app.get('/api/config', (_req, res) => res.json({ browserAk: '', hasServerAk: false, mock: true }));
app.use('/api', (_req, res) => res.status(404).json({ status: -1, message: 'Offline test server' }));
app.use(express.static('dist'));
app.listen(4183, '127.0.0.1');
