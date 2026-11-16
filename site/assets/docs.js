const root = document.body.dataset.root;
const dialog = document.querySelector('#search-dialog');
const input = document.querySelector('#docs-search');
const results = document.querySelector('#search-results');
const status = document.querySelector('#search-status');
let indexPromise, previousFocus;
const sidebar = document.querySelector('#docs-sidebar');
const menu = document.querySelector('.docs-menu-button');

function closeMenu() { sidebar.classList.remove('mobile-open'); menu.setAttribute('aria-expanded', 'false'); menu.setAttribute('aria-label', 'Открыть меню документации'); }
menu.addEventListener('click', () => {
  const open = !sidebar.classList.contains('mobile-open');
  sidebar.classList.toggle('mobile-open', open);
  menu.setAttribute('aria-expanded', String(open));
  menu.setAttribute('aria-label', open ? 'Закрыть меню документации' : 'Открыть меню документации');
});
document.addEventListener('click', event => { if (!event.target.closest('#docs-sidebar,.docs-menu-button')) closeMenu(); });

async function search() {
  const query = input.value.toLocaleLowerCase('ru').trim();
  try {
    indexPromise ??= fetch(`${root}assets/search-index.json`).then(response => { if (!response.ok) throw new Error('search'); return response.json(); });
    const index = await indexPromise;
    // Ignore results of an older input event if the user typed during the fetch.
    if (query !== input.value.toLocaleLowerCase('ru').trim()) return;
    const words = query.split(/\s+/).filter(Boolean);
    const found = index.map(page => ({ page, score: words.reduce((score, word) => score + (page.title.toLocaleLowerCase('ru').includes(word) ? 20 : 0) + (page.text.toLocaleLowerCase('ru').includes(word) ? 1 : 0), 0) })).filter(item => !words.length || words.every(word => `${item.page.title} ${item.page.text}`.toLocaleLowerCase('ru').includes(word))).sort((a, b) => b.score - a.score).slice(0, 10);
    results.replaceChildren();
    status.textContent = words.length ? found.length ? `Найдено страниц: ${found.length}` : 'Ничего не найдено. Попробуй другое слово.' : 'Начни с одного из разделов';
    for (const { page } of found) {
      const link = document.createElement('a'); link.href = root + page.path;
      const group = document.createElement('small'); group.textContent = page.group;
      const title = document.createElement('strong'); title.textContent = page.title;
      const snippet = document.createElement('p'); snippet.textContent = page.description;
      link.append(group, title, snippet); results.append(link);
    }
  } catch { status.textContent = 'Поиск недоступен. Открой раздел через боковое меню.'; indexPromise = undefined; }
}
function openSearch() { previousFocus = document.activeElement; dialog.showModal(); input.focus(); void search(); }
document.querySelector('.search-trigger').addEventListener('click', openSearch);
input.addEventListener('input', search);
dialog.addEventListener('close', () => previousFocus?.focus());
dialog.addEventListener('click', event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); } });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && dialog.open) { event.preventDefault(); dialog.close(); return; }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); if (!dialog.open) openSearch(); }
  if (event.key === 'Escape' && sidebar.classList.contains('mobile-open')) { closeMenu(); menu.focus(); }
  if (!dialog.open || !['ArrowDown', 'ArrowUp'].includes(event.key)) return;
  const links = [...results.querySelectorAll('a')]; if (!links.length) return;
  event.preventDefault(); const current = links.indexOf(document.activeElement);
  links[(current + (event.key === 'ArrowDown' ? 1 : -1) + links.length) % links.length].focus();
});
for (const button of document.querySelectorAll('.copy-code')) button.addEventListener('click', async () => {
  const code = button.closest('.code-block').querySelector('code');
  try { await navigator.clipboard.writeText(code.textContent); button.textContent = 'Скопировано ✓'; }
  catch { const selection = getSelection(), range = document.createRange(); range.selectNodeContents(code); selection.removeAllRanges(); selection.addRange(range); button.textContent = 'Выделено — Ctrl+C'; }
  setTimeout(() => { button.textContent = 'Копировать'; }, 2500);
});
const headings = [...document.querySelectorAll('.prose h2[id]')];
if ('IntersectionObserver' in window) {
  const observer = new IntersectionObserver(entries => {
    const current = entries.find(entry => entry.isIntersecting); if (!current) return;
    for (const link of document.querySelectorAll('.docs-toc nav a')) link.classList.toggle('active', decodeURIComponent(link.hash.slice(1)) === current.target.id);
  }, { rootMargin: '-90px 0px -65% 0px' });
  headings.forEach(heading => observer.observe(heading));
}
