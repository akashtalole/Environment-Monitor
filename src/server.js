// Serves the dashboard (web/) and its data (data/dashboard.json).
//   npm run serve                    → http://localhost:8787
//   npm run serve -- --monitor 60    → also runs due sources every 60 minutes
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { ROOT, DATA_DIR } from './lib/store.js';
import { runMonitor } from './monitor.js';
import { buildDashboard } from './dashboard.js';

const { values } = parseArgs({ options: { port: { type: 'string', default: process.env.PORT || '8787' }, monitor: { type: 'string' } } });
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
const WEB = path.join(ROOT, 'web');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  let file;
  if (/^\/data\/(dashboard|analytics|statewide)\.json$/.test(url.pathname)) file = path.join(DATA_DIR, path.basename(url.pathname));
  else file = path.join(WEB, path.normalize(url.pathname === '/' ? '/index.html' : url.pathname));
  if (!file.startsWith(WEB) && !file.startsWith(DATA_DIR)) return res.writeHead(403).end();
  try {
    const body = await fs.readFile(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
});

await buildDashboard().catch(() => {});
server.listen(+values.port, () => console.log(`Dashboard: http://localhost:${values.port}`));

if (values.monitor) {
  const minutes = Math.max(5, +values.monitor || 60);
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runMonitor();
    } catch (e) {
      console.error(e);
    } finally {
      running = false;
    }
  };
  tick();
  setInterval(tick, minutes * 60_000);
  console.log(`Monitoring every ${minutes} min`);
}
