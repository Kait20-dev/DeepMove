'use client';

import { useEffect, useRef } from 'react';
import { createAnimationGroups } from './game';
import type { Square } from 'chess.js';

const glyphs = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
const position = (square: Square) => [square.charCodeAt(0) - 97, 8 - Number(square[1])];

export function ChessBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    const frames = createAnimationGroups();
    const durations = frames.map((_, index) => [850, 1050, 780, 940, 820, 1000, 880][index % 7]);
    const cycleDuration = durations.reduce((total, duration) => total + duration, 0);
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    let request = 0;
    let width = 0;
    let height = 0;
    let elapsed = 0;
    let last = 0;
    const render = () => {
      const size = Math.max(height / 8, width / 14) * 0.84;
      const left = width - size * 8 - width * 0.025;
      const top = (height - size * 8) / 2;
      context.clearRect(0, 0, width, height);
      for (let y = -1; y < Math.ceil(height / size) + 1; y++) {
        for (let x = -Math.ceil(width / size); x < 10; x++) {
          context.fillStyle = (x + y) % 2 === 0 ? '#292039' : '#15121e';
          context.fillRect(left + x * size, top + y * size, size, size);
        }
      }
      let localTime = elapsed % cycleDuration;
      let frameIndex = 0;
      while (localTime >= durations[frameIndex]) localTime -= durations[frameIndex++];
      const frame = frames[frameIndex];
      const phase = localTime / durations[frameIndex];
      context.font = `${size * 0.77}px "Segoe UI Symbol", "DejaVu Sans", serif`;
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      for (const piece of frame.pieces) {
        let [x, y] = position(piece.square);
        const moveIndex = frame.moves.findIndex(candidate => candidate.from === piece.square);
        const move = frame.moves[moveIndex];
        if (move) {
          const t = Math.max(0, Math.min((phase - moveIndex * 0.08) / 0.65, 1));
          const ease = t * t * (3 - 2 * t);
          const [toX, toY] = position(move.to);
          x += (toX - x) * ease;
          y += (toY - y) * ease;
        }
        context.fillStyle = piece.color === 'w' ? '#b4a9cb' : '#0d0b13';
        context.strokeStyle = piece.color === 'w' ? '#c7bdd9' : '#645572';
        context.lineWidth = Math.max(1, size * 0.009);
        context.strokeText(glyphs[piece.type], left + (x + 0.5) * size, top + (y + 0.52) * size);
        context.fillText(glyphs[piece.type], left + (x + 0.5) * size, top + (y + 0.52) * size);
      }
    };
    const tick = (time: number) => {
      if (last) elapsed += Math.min(time - last, 64);
      last = time;
      render();
      request = requestAnimationFrame(tick);
    };
    const synchronize = () => {
      cancelAnimationFrame(request);
      last = 0;
      render();
      if (!motion.matches && !document.hidden) request = requestAnimationFrame(tick);
    };
    const resize = () => {
      width = window.innerWidth;
      height = window.innerHeight;
      const ratio = Math.min(devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      render();
    };
    resize();
    synchronize();
    window.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', synchronize);
    motion.addEventListener('change', synchronize);
    return () => {
      cancelAnimationFrame(request);
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', synchronize);
      motion.removeEventListener('change', synchronize);
    };
  }, []);
  return <div className="chess-background" aria-hidden="true"><canvas ref={canvasRef} /><div className="board-shade" /></div>;
}
