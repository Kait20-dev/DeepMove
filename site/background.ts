import { createAnimationGroups } from '../src/features/chess-background/game';
import type { Square } from 'chess.js';

// The same legal, non-reversing simultaneous sequence as the server site's hero.
export function startBackground(canvas: HTMLCanvasElement, button: HTMLButtonElement) {
  const context = canvas.getContext('2d');
  if (!context) return;
  const frames = createAnimationGroups();
  const durations = frames.map((_, i) => [1250, 1500, 1180, 1370, 1290, 1440, 1320][i % 7]);
  const cycle = durations.reduce((a, b) => a + b, 0);
  const glyphs = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
  const position = (square: Square) => [square.charCodeAt(0) - 97, 8 - Number(square[1])];
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let width = 0, height = 0, elapsed = 0, previous = 0, request = 0;
  let enabled = !reduced.matches, visible = true;

  function render() {
    const ctx = context!;
    const size = Math.max(height / 8.2, width / 15) * .94;
    const left = width - size * 8 - width * .015;
    const top = (height - size * 8) / 2 + 7;
    ctx.clearRect(0, 0, width, height);
    let local = elapsed % cycle, index = 0;
    while (local >= durations[index]) local -= durations[index++];
    const frame = frames[index], phase = local / durations[index];
    for (let y = -2; y < Math.ceil(height / size) + 2; y++) for (let x = -Math.ceil(width / size); x < 11; x++) {
      ctx.fillStyle = (x + y) % 2 === 0 ? '#2c203b' : '#15101f';
      ctx.fillRect(left + x * size, top + y * size, size, size);
      ctx.strokeStyle = '#b99bdc08'; ctx.lineWidth = .7;
      ctx.strokeRect(left + x * size, top + y * size, size, size);
    }
    for (const [i, move] of frame.moves.entries()) {
      const t = Math.max(0, Math.min((phase - i * .1) / .82, 1));
      const [x, y] = position(move.to);
      ctx.fillStyle = `rgba(151,100,207,${Math.sin(t * Math.PI) * .18})`;
      ctx.fillRect(left + x * size, top + y * size, size, size);
    }
    ctx.font = `${size * .79}px "Segoe UI Symbol", "DejaVu Sans", serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const piece of frame.pieces) {
      let [x, y] = position(piece.square);
      const i = frame.moves.findIndex(move => move.from === piece.square);
      const move = frame.moves[i];
      if (move) {
        const t = Math.max(0, Math.min((phase - i * .1) / .82, 1));
        const ease = t * t * t * (t * (t * 6 - 15) + 10);
        const [toX, toY] = position(move.to);
        x += (toX - x) * ease; y += (toY - y) * ease;
      }
      ctx.fillStyle = piece.color === 'w' ? '#baaccf' : '#100b18';
      ctx.strokeStyle = piece.color === 'w' ? '#ded2ef' : '#7a608d';
      ctx.lineWidth = Math.max(1, size * .009);
      ctx.shadowColor = '#0008'; ctx.shadowBlur = size * .06; ctx.shadowOffsetY = size * .025;
      ctx.strokeText(glyphs[piece.type], left + (x + .5) * size, top + (y + .53) * size);
      ctx.fillText(glyphs[piece.type], left + (x + .5) * size, top + (y + .53) * size);
      ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
    }
  }
  function tick(now: number) {
    if (previous) elapsed += Math.min(now - previous, 60);
    previous = now; render(); request = requestAnimationFrame(tick);
  }
  function sync() {
    cancelAnimationFrame(request); previous = 0; render();
    button.setAttribute('aria-pressed', String(enabled));
    button.setAttribute('aria-label', enabled ? 'Приостановить фоновую анимацию' : 'Включить фоновую анимацию');
    button.innerHTML = enabled ? '<span>Ⅱ</span> Пауза' : '<span>▶</span> Анимация';
    if (enabled && visible && !document.hidden) request = requestAnimationFrame(tick);
  }
  function resize() {
    const parent = canvas.parentElement!;
    width = parent.clientWidth; height = parent.clientHeight;
    const ratio = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
    context!.setTransform(ratio, 0, 0, ratio, 0, 0); render();
  }
  const observer = new ResizeObserver(resize); observer.observe(canvas.parentElement!);
  const intersection = new IntersectionObserver(entries => { visible = entries[0].isIntersecting; sync(); }); intersection.observe(canvas);
  button.addEventListener('click', () => { enabled = !enabled; sync(); });
  reduced.addEventListener('change', () => { if (reduced.matches) enabled = false; sync(); });
  document.addEventListener('visibilitychange', sync);
  window.addEventListener('pagehide', () => { cancelAnimationFrame(request); observer.disconnect(); intersection.disconnect(); }, { once: true });
  resize(); sync();
}
