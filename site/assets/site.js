import { startBackground } from '../background';

const canvas = document.querySelector('#hero-canvas');
if (canvas) startBackground(canvas, document.querySelector('#scene-toggle'));

const menuButton = document.querySelector('.menu-button');
const mobileNav = document.querySelector('#mobile-nav');
menuButton?.addEventListener('click', () => {
  const open = menuButton.getAttribute('aria-expanded') !== 'true';
  menuButton.setAttribute('aria-expanded', String(open));
  menuButton.setAttribute('aria-label', open ? 'Закрыть меню' : 'Открыть меню');
  mobileNav.hidden = !open;
});
mobileNav?.addEventListener('click', event => {
  if (event.target.closest('a')) {
    mobileNav.hidden = true;
    menuButton.setAttribute('aria-expanded', 'false');
    menuButton.setAttribute('aria-label', 'Открыть меню');
  }
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && mobileNav && !mobileNav.hidden) {
    mobileNav.hidden = true;
    menuButton.setAttribute('aria-expanded', 'false');
    menuButton.setAttribute('aria-label', 'Открыть меню');
    menuButton.focus();
  }
});
