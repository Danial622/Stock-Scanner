'use strict';

const express    = require('express');
const path       = require('path');
const { registerTseScanner } = require('./tse-scanner');

const app  = express();
const PORT = process.env.PORT || 30368;
const HOST = '0.0.0.0';

// ── Middleware ──────────────────────────────
app.use(express.json({ limit: '1mb' }));

// Security headers (lightweight — no helmet dep required)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

// Simple in-memory rate limiter for scan endpoint
const scanHits = new Map();
app.use('/api/tse/scan/start', (req, res, next) => {
  const ip   = req.ip || req.connection.remoteAddress || 'unknown';
  const now  = Date.now();
  const last = scanHits.get(ip) || 0;
  if (now - last < 30_000) {
    return res.status(429).json({ ok: false, error: 'Rate limited — wait 30s between manual scans.' });
  }
  scanHits.set(ip, now);
  next();
});

// ── Routes ───────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get('/health', (req, res) => res.json({
  status    : 'ok',
  service   : 'TSE Quant Engine v2.2',
  timestamp : new Date().toISOString(),
  uptime    : `${Math.floor(process.uptime())}s`,
  memory    : `${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`,
}));

registerTseScanner(app);

// 404
app.use((req, res) => res.status(404).json({ ok: false, error: 'Route not found' }));

// Global error handler
app.use((err, req, res, next) => {
  console.error('[Express Error]', err.message);
  res.status(500).json({ ok: false, error: 'Internal server error' });
});

// ── Start ────────────────────────────────────
const server = app.listen(PORT, HOST, () => {
  console.log(`\n🚀 TSE Quant Engine v2.2`);
  console.log(`   Dashboard : http://${HOST}:${PORT}/`);
  console.log(`   Health    : http://${HOST}:${PORT}/health`);
  console.log(`   Signals   : http://${HOST}:${PORT}/api/tse/signals\n`);
});

// ── Graceful shutdown ────────────────────────
['SIGTERM', 'SIGINT'].forEach(sig => {
  process.on(sig, () => {
    console.log(`\n${sig} — shutting down gracefully...`);
    server.close(() => { console.log('Server closed.'); process.exit(0); });
    setTimeout(() => process.exit(1), 3000).unref();
  });
});

// Catch unhandled rejections so the server never crashes silently
process.on('unhandledRejection', (reason) => {
  console.error('[UnhandledRejection]', reason);
});
