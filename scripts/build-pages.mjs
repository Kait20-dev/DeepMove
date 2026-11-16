import { mkdir, readFile, writeFile, cp, readdir, rm } from 'node:fs/promises';
import { resolve, relative, posix, join, basename, sep } from 'node:path';
import { Marked } from 'marked';
import sharp from 'sharp';
import { build } from 'esbuild';
import { pages } from '../site/pages.mjs';

const root = resolve(import.meta.dirname, '..');
const out = join(root, 'out');
const repository = 'https://github.com/Kait20-dev/DeepMove';
const siteUrl = 'https://kait20-dev.github.io/DeepMove';
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const slugify = value => value.replace(/<[^>]*>/g, '').toLowerCase().replace(/[^\p{L}\p{N}_\-\s]/gu, '').trim().replace(/\s+/g, '-');
const pagePath = page => `docs/${page.slug ? `${page.slug}/` : ''}`;
const byFile = new Map(pages.map(page => [page.file, page]));

// Only the explicitly resolved, ignored build output inside this checkout is removed.
if (!out.startsWith(root + sep) || basename(out) !== 'out') throw new Error('Unsafe output directory');
await rm(out, { recursive: true, force: true });
await mkdir(join(out, 'assets/licenses'), { recursive: true });
await cp(join(root, 'site/assets'), join(out, 'assets'), { recursive: true });
await build({ entryPoints: [join(root, 'site/assets/site.js')], outfile: join(out, 'assets/site.js'), bundle: true, format: 'esm', minify: true, target: 'es2022' });
await cp(join(root, 'public/assets/Deep_Move_Icon_Vector.svg'), join(out, 'assets/mark.svg'));
await sharp(join(root, 'public/assets/kait_logo_white.png')).resize({ width: 220 }).webp({ quality: 86 }).toFile(join(out, 'assets/kait.webp'));
await sharp(join(root, 'public/assets/Deep_Move_Logo_Transparent_4K.png')).resize({ width: 420 }).webp({ quality: 90 }).toFile(join(out, 'assets/deepmove.webp'));
await cp(join(root, 'node_modules/chess.js/LICENSE'), join(out, 'assets/licenses/chess.js.txt'));
await cp(join(root, 'LICENSE'), join(out, 'assets/licenses/DeepMove-MIT.txt'));
await writeFile(join(out, 'index.html'), await readFile(join(root, 'site/index.html')));
await writeFile(join(out, '.nojekyll'), '');

const social = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"><rect width="1200" height="630" fill="#101015"/><path d="M850 0v630M0 500h1200" stroke="#bfa5ff" stroke-opacity=".15"/><text x="75" y="100" fill="#aaa0bd" font-family="Arial" font-size="18" letter-spacing="4">DEEPMOVE / КАИТ №20</text><text x="70" y="260" fill="#f3f2f5" font-family="Arial" font-weight="bold" font-size="94">Твой код</text><text x="70" y="375" fill="#bfa5ff" font-family="Arial" font-weight="bold" font-size="94">делает ход.</text><text x="75" y="555" fill="#a398b5" font-family="Arial" font-size="22">Шахматы × программирование · Open source · MIT</text><text x="925" y="360" fill="#bfa5ff" font-family="DejaVu Sans" font-size="180">♞</text></svg>`;
await sharp(Buffer.from(social)).png().toFile(join(out, 'assets/social.png'));

const search = [];
for (const [index, page] of pages.entries()) {
  const source = await readFile(join(root, page.file), 'utf8');
  const depth = page.slug ? '../../' : '../';
  const headings = [], usedIds = new Map();
  function linkTo(href) {
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(href)) return href;
    const [path, fragment] = href.split('#');
    const targetFile = posix.normalize(posix.join(posix.dirname(page.file), decodeURIComponent(path)));
    const targetPage = byFile.get(targetFile);
    if (targetPage) return `${depth}${pagePath(targetPage)}${fragment ? `#${fragment}` : ''}`;
    return `${repository}/blob/main/${targetFile}${fragment ? `#${fragment}` : ''}`;
  }
  const md = new Marked({ gfm: true, renderer: {
    heading({ tokens, depth: level }) {
      const text = this.parser.parseInline(tokens);
      const base = slugify(text), count = usedIds.get(base) || 0;
      usedIds.set(base, count + 1);
      const id = count ? `${base}-${count}` : base;
      if (level === 2 || level === 3) headings.push({ id, text: text.replace(/<[^>]*>/g, ''), level });
      return `<h${level} id="${escape(id)}">${text}<a class="heading-anchor" href="#${escape(id)}" aria-label="Ссылка на раздел">#</a></h${level}>\n`;
    },
    link({ href, title, tokens }) {
      return `<a href="${escape(linkTo(href))}"${title ? ` title="${escape(title)}"` : ''}>${this.parser.parseInline(tokens)}</a>`;
    },
    code({ text, lang }) {
      return `<div class="code-block"><div class="code-block-top"><span>${escape(lang || 'text')}</span><button type="button" class="copy-code" aria-label="Скопировать код">Копировать</button></div><pre><code>${escape(text)}</code></pre></div>\n`;
    },
    table(token) {
      return `<div class="table-scroll">${renderTable.call(this, token)}</div>`;
    },
  }});
  function renderTable(token) {
    const cell = (entry, tag) => `<${tag}>${this.parser.parseInline(entry.tokens)}</${tag}>`;
    return `<table><thead><tr>${token.header.map(c => cell(c, 'th')).join('')}</tr></thead><tbody>${token.rows.map(row => `<tr>${row.map(c => cell(c, 'td')).join('')}</tr>`).join('')}</tbody></table>`;
  }
  const content = md.parse(source);
  const groups = [...new Set(pages.map(item => item.group))];
  const sidebar = groups.map(group => `<div class="docs-nav-group"><span>${escape(group)}</span>${pages.filter(p => p.group === group).map(item => `<a ${item === page ? 'aria-current="page" class="active"' : ''} href="${depth}${pagePath(item)}">${escape(item.title)}</a>`).join('')}</div>`).join('');
  const toc = headings.filter(h => h.level === 2).map(heading => `<a href="#${escape(heading.id)}">${escape(heading.text)}</a>`).join('');
  const previous = pages[index - 1], next = pages[index + 1];
  const brand = `<a class="brand" href="${depth}" aria-label="DeepMove — главная"><img src="${depth}assets/mark.svg" width="30" height="30" alt=""><span>deep<span class="brand-light">move</span><span class="brand-dot">.</span></span></a>`;
  const html = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#101015"><meta name="description" content="${escape(page.description)}"><title>${escape(page.title)} — DeepMove Docs</title><link rel="canonical" href="${siteUrl}/${pagePath(page)}"><link rel="icon" href="${depth}assets/mark.svg" type="image/svg+xml"><link rel="stylesheet" href="${depth}assets/site.css"><link rel="stylesheet" href="${depth}assets/docs.css"><script type="module" src="${depth}assets/docs.js"></script></head>
<body class="docs-body" data-root="${depth}"><a class="skip-link" href="#main">Перейти к содержимому</a>
<header class="docs-header">${brand}<a class="docs-header-label" href="${depth}docs/">Документация</a><button class="search-trigger" type="button"><span>⌕</span> Поиск по документации <kbd>Ctrl K</kbd></button><a class="docs-github" href="${repository}">GitHub ↗</a><button class="docs-menu-button" type="button" aria-label="Открыть меню документации" aria-expanded="false" aria-controls="docs-sidebar">☰</button></header>
<div class="docs-layout"><aside class="docs-sidebar" id="docs-sidebar"><a class="back-to-site" href="${depth}">← На сайт проекта</a><nav aria-label="Разделы документации">${sidebar}</nav><div class="sidebar-foot"><span class="status-dot"></span> Open source · MIT</div></aside>
<main class="docs-content" id="main"><div class="docs-breadcrumb">DEEPMOVE <span>/</span> ${escape(page.group)}</div><article class="prose">${content}</article><div class="docs-source"><a href="${repository}/blob/main/${page.file}">Читать исходник ↗</a><a href="${repository}/edit/main/${page.file}">Предложить исправление ↗</a></div><nav class="docs-pagination" aria-label="Предыдущая и следующая страницы">${previous ? `<a href="${depth}${pagePath(previous)}"><small>← Предыдущая</small>${escape(previous.title)}</a>` : '<span></span>'}${next ? `<a href="${depth}${pagePath(next)}"><small>Следующая →</small>${escape(next.title)}</a>` : '<span></span>'}</nav><footer class="docs-footer">© 2026 Ярослав Бойков Владимирович и другие разработчики проекта DeepMove · <a href="${depth}docs/license/">MIT</a></footer></main>
<aside class="docs-toc"><span>НА ЭТОЙ СТРАНИЦЕ</span><nav aria-label="Оглавление">${toc}</nav><a class="toc-github" href="${repository}/issues">Есть вопрос? Открой issue ↗</a></aside></div>
<dialog id="search-dialog" class="search-dialog" aria-labelledby="search-title"><form method="dialog"><h2 id="search-title">Поиск по документации</h2><button class="search-close" aria-label="Закрыть поиск">Esc</button></form><label class="sr-only" for="docs-search">Поиск</label><input id="docs-search" type="search" placeholder="Например: HardBullet, ключ, PGN…" autocomplete="off"><div id="search-status" role="status" aria-live="polite"></div><div id="search-results"></div><div class="search-hint">↑ ↓ выбрать · Enter открыть · Esc закрыть</div></dialog>
</body></html>`;
  const folder = join(out, pagePath(page));
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'index.html'), html);
  search.push({ title: page.title, description: page.description, path: pagePath(page), group: page.group, text: source.replace(/```[\s\S]*?```/g, ' ').replace(/[#*`|]/g, '').replace(/\s+/g, ' '), headings });
}
await writeFile(join(out, 'assets/search-index.json'), JSON.stringify(search));
await writeFile(join(out, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${siteUrl}/</loc></url>${pages.map(page => `<url><loc>${siteUrl}/${pagePath(page)}</loc></url>`).join('')}</urlset>`);
await writeFile(join(out, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${siteUrl}/sitemap.xml\n`);
await writeFile(join(out, '404.html'), `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Страница не найдена — DeepMove</title><style>body{background:#101015;color:#eee;font:18px/1.8 system-ui;max-width:650px;margin:15vh auto;padding:30px}h1{font-size:50px}a{color:#bfa5ff}</style><h1>Этот ход не найден.</h1><p>Возможно, адрес изменился.</p><a href="${siteUrl}/">На главную →</a> · <a href="${siteUrl}/docs/">Документация →</a></html>`);
async function size(folder) { let total = 0; for (const entry of await readdir(folder, { withFileTypes: true })) { const path = join(folder, entry.name); total += entry.isDirectory() ? await size(path) : (await readFile(path)).length; } return total; }
console.log(`Pages built: landing + ${pages.length} documentation pages, ${(await size(out) / 1024 / 1024).toFixed(2)} MiB → ${relative(root, out)}/`);
