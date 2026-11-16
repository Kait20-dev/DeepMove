import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';

const output = resolve('out');
const port = Number(process.env.PAGES_PORT || 4173);
const prefix = '/DeepMove';
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png', '.json': 'application/json; charset=utf-8', '.xml': 'application/xml; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };
createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    if (url.pathname === '/' || url.pathname === prefix) { response.writeHead(302, { Location: `${prefix}/` }); response.end(); return; }
    if (!url.pathname.startsWith(`${prefix}/`)) { response.writeHead(404); response.end('Not found'); return; }
    let file = resolve(output, '.' + decodeURIComponent(url.pathname.slice(prefix.length)));
    if (file !== output && !file.startsWith(output + sep)) { response.writeHead(403); response.end(); return; }
    const info = await stat(file);
    if (info.isDirectory()) {
      if (!url.pathname.endsWith('/')) { response.writeHead(301, { Location: url.pathname + '/' }); response.end(); return; }
      file = resolve(file, 'index.html');
    }
    const content = await readFile(file);
    response.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    response.end(request.method === 'HEAD' ? undefined : content);
  } catch { response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); response.end('Not found'); }
}).listen(port, '127.0.0.1', () => console.log(`DeepMove Pages: http://127.0.0.1:${port}${prefix}/`));
