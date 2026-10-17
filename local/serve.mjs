#!/usr/bin/env node
// Local static server for docs/, no dependencies: node local/serve.mjs [port] (default 8080).
// Caching is off, so the browser always loads the latest files. .gz files are sent
// as-is without Content-Encoding, as GitHub Pages does; the page unzips them itself.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// docs/ next to the local/ folder, whatever the working directory.
const DOCS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs');
const PORT = parseInt(process.argv[2] || '8080', 10);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.gz': 'application/gzip',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.fa': 'text/plain; charset=utf-8',
  '.fasta': 'text/plain; charset=utf-8',
  '.fastq': 'text/plain; charset=utf-8',
  '.fq': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.tsv': 'text/plain; charset=utf-8',
  '.sam': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8'
};

const NO_CACHE = { 'Cache-Control': 'no-store, must-revalidate', Pragma: 'no-cache', Expires: '0' };

function send(res, code, text) {
  res.writeHead(code, { ...NO_CACHE, 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');

  let rel;
  try {
    rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    return send(res, 400, 'Bad request');
  }
  let file = path.join(DOCS, rel);
  // Refuse any path that leaves docs/.
  const back = path.relative(DOCS, file);
  if (back.startsWith('..') || path.isAbsolute(back)) return send(res, 403, 'Forbidden');

  fs.stat(file, (err, st) => {
    if (!err && st.isDirectory()) {
      file = path.join(file, 'index.html');
      st = fs.existsSync(file) ? fs.statSync(file) : null;
    }
    if (err || !st || !st.isFile()) return send(res, 404, 'Not found');

    res.writeHead(200, {
      ...NO_CACHE,
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`ExCas-Analyzer serving ${DOCS} at http://localhost:${PORT}`);
});
