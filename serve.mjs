import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, join, extname, sep } from 'node:path';

const root = await realpath(resolve(process.argv[2] ?? 'out'));
const port = Number(process.env.PORT ?? 4173);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT must be 1024–65535.');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg' };

const server = createServer(async (request, response) => {
  try {
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405, { Allow: 'GET, HEAD' }).end('Method not allowed'); return;
    }
    let pathname;
    try { pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname); }
    catch { response.writeHead(400).end('Invalid path'); return; }
    // Preserve the document's real directory so relative CSS/module URLs resolve correctly.
    if (pathname === '/' || pathname === '/dashboard' || pathname === '/dashboard/') {
      response.writeHead(302, { Location: '/dashboard/index.html', 'Cache-Control': 'no-store' }).end();
      return;
    }
    const target = resolve(join(root, pathname));
    if (target !== root && !target.startsWith(root + sep)) { response.writeHead(403).end('Forbidden'); return; }
    const actual = await realpath(target);
    if (!actual.startsWith(root + sep) || !(await stat(actual)).isFile() || !types[extname(actual)]) {
      response.writeHead(404).end('Not found'); return;
    }
    const body = await readFile(actual);
    response.writeHead(200, {
      'Content-Type': types[extname(actual)], 'Content-Length': body.length, 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    });
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') response.writeHead(404).end('Not found');
    else { console.error(`Preview request failed: ${error.message}`); response.writeHead(500).end('Preview request failed'); }
  }
});
server.on('error', error => { console.error(`Preview server: ${error.message}`); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => console.log(`FIELDNOTE preview: http://127.0.0.1:${port}`));
