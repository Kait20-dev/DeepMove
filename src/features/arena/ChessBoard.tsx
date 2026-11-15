'use client';
import { useState } from 'react';
import { Chess, type Square } from 'chess.js';
import { pieceGlyphs, pieceNames } from './client';
import type { Side } from './types';

export function ChessBoard({ fen, orientation = 'w', legalMoves = [], onMove, lastMove, busy = false }: { fen: string; orientation?: Side; legalMoves?: string[]; onMove?: (uci: string) => void; lastMove?: string; busy?: boolean }) {
  const [selection, setSelection] = useState<{ fen: string; square: Square } | null>(null);
  const [promotion, setPromotion] = useState<{ fen: string; from: Square; to: Square } | null>(null);
  const chess = new Chess(fen);
  const selected = selection?.fen === fen ? selection.square : null;
  const pending = promotion?.fen === fen ? promotion : null;
  const files = orientation === 'w' ? 'abcdefgh' : 'hgfedcba';
  const ranks = orientation === 'w' ? '87654321' : '12345678';
  const king = chess.isCheck() ? chess.board().flat().find(piece => piece?.type === 'k' && piece.color === chess.turn())?.square : null;
  function click(square: Square) {
    if (!onMove || busy || pending) return;
    const options = selected ? legalMoves.filter(move => move.startsWith(selected + square)) : [];
    if (selected && options.length) {
      if (options.some(move => move.length === 5)) { setPromotion({ fen, from: selected, to: square }); return; }
      onMove(selected + square); setSelection(null);
    } else setSelection(legalMoves.some(move => move.startsWith(square)) ? { fen, square } : null);
  }
  return <div className="chess-board-wrap"><div className="play-board" role="group" aria-label={onMove ? 'Шахматная доска: выберите фигуру и клетку назначения' : 'Шахматная доска, режим просмотра'}>{[...ranks].flatMap((rank, row) => [...files].map((file, column) => {
    const square = `${file}${rank}` as Square, piece = chess.get(square);
    const target = selected && legalMoves.some(move => move.startsWith(selected + square));
    const moved = lastMove?.slice(0, 2) === square || lastMove?.slice(2, 4) === square;
    return <button type="button" key={square} className={`board-square ${(Number(rank) + file.charCodeAt(0)) % 2 === 0 ? 'light' : 'dark'} ${selected === square ? 'selected' : ''} ${moved ? 'last-move' : ''} ${king === square ? 'king-check' : ''}`} onClick={() => click(square)} aria-label={`${square}${piece ? `, ${piece.color === 'w' ? 'белые' : 'чёрные'} ${pieceNames[piece.type]}` : ', пусто'}${target ? ', возможный ход' : ''}`} aria-pressed={selected === square} onKeyDown={event => {
      const offset: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -8, ArrowDown: 8 };
      if (Object.hasOwn(offset, event.key)) { event.preventDefault(); const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button'); const index = row * 8 + column + offset[event.key]; if (index >= 0 && index < 64) buttons?.[index]?.focus(); }
      if (event.key === 'Escape') setSelection(null);
    }}>
      {column === 0 && <span className="rank-label" aria-hidden="true">{rank}</span>}{row === 7 && <span className="file-label" aria-hidden="true">{file}</span>}
      {piece && <span className={`chess-piece ${piece.color === 'w' ? 'white-piece' : 'black-piece'}`} aria-hidden="true">{pieceGlyphs[piece.type]}</span>}{target && <span className={piece ? 'capture-target' : 'move-target'} aria-hidden="true" />}
    </button>;
  }))}</div>{pending && <div className="promotion-overlay" role="dialog" aria-modal="true" aria-label="Превращение пешки"><p>Выбери фигуру</p><div>{['q', 'r', 'b', 'n'].map(type => <button type="button" autoFocus={type === 'q'} key={type} aria-label={pieceNames[type]} onClick={() => { onMove?.(pending.from + pending.to + type); setPromotion(null); setSelection(null); }}>{pieceGlyphs[type]}</button>)}</div><button className="text-button" onClick={() => setPromotion(null)}>Отмена</button></div>}</div>;
}
