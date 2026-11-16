import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, dirname, join, relative, sep } from 'node:path';

const root = resolve('out');
const files = [];
async function walk(folder) { for (const entry of await readdir(folder, { withFileTypes: true })) { const file = join(folder, entry.name); if (entry.isDirectory()) await walk(file); else files.push(file); } }
await walk(root);
const failures = [], htmlCache = new Map();
let links = 0;
for (const file of files.filter(file => file.endsWith('.html'))) {
  const html = await readFile(file, 'utf8'); htmlCache.set(file, html);
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  if (new Set(ids).size !== ids.length) failures.push(`${relative(root, file)}: duplicate IDs`);
  for (const match of html.matchAll(/\b(?:href|src)="([^"]+)"/g)) {
    const target = match[1].replaceAll('&amp;', '&');
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target)) continue;
    links++;
    const [pathname, fragment] = target.split('#');
    let dest = pathname ? resolve(dirname(file), decodeURIComponent(pathname)) : file;
    if (dest !== root && !dest.startsWith(root + sep)) { failures.push(`${relative(root, file)}: escaped output ${target}`); continue; }
    try {
      if ((await stat(dest)).isDirectory()) dest = join(dest, 'index.html');
      await stat(dest);
      if (fragment && dest.endsWith('.html')) {
        let content = htmlCache.get(dest); if (!content) { content = await readFile(dest, 'utf8'); htmlCache.set(dest, content); }
        if (!content.includes(`id="${decodeURIComponent(fragment)}"`)) failures.push(`${relative(root, file)}: missing anchor ${target}`);
      }
    } catch { failures.push(`${relative(root, file)}: missing ${target}`); }
  }
}
for (const file of files) if (/(?:\.sqlite(?:-wal|-shm)?$|\.env|\.pyc$|(?:^|[\\/])node_modules[\\/]|\.jsonl$)/.test(file)) failures.push(`Private/runtime file in artifact: ${relative(root, file)}`);
assert.deepEqual(failures, []);
console.log(`PASS: ${files.filter(f => f.endsWith('.html')).length} HTML pages, ${links} local links/assets/anchors, no runtime data in Pages artifact`);
