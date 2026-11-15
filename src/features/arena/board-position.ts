import { Chess, type PieceSymbol, type Square } from 'chess.js';
import type { Side } from './types';

/** A piece keeps its starting-square identity throughout moves and replay. */
export interface BoardPiece {
  id: string;
  square: Square;
  type: PieceSymbol;
  color: Side;
  active: boolean;
}

export function boardPosition(moves: readonly { uci: string }[], ply: number) {
  const chess = new Chess();
  const pieces: BoardPiece[] = chess.board().flatMap(row => row.flatMap(piece =>
    piece ? [{ id: piece.square, square: piece.square, type: piece.type, color: piece.color, active: true }] : []));
  for (const record of moves.slice(0, ply)) {
    const move = chess.move(record.uci);
    const moving = pieces.find(piece => piece.active && piece.square === move.from)!;
    if (move.captured) {
      const square = move.flags.includes('e') ? `${move.to[0]}${move.from[1]}` : move.to;
      const captured = pieces.find(piece => piece.active && piece.square === square)!;
      captured.active = false;
    }
    moving.square = move.to;
    moving.type = move.promotion || move.piece;
    if (move.flags.includes('k') || move.flags.includes('q')) {
      const kingside = move.flags.includes('k');
      const rook = pieces.find(piece => piece.active && piece.square === `${kingside ? 'h' : 'a'}${move.from[1]}`)!;
      rook.square = `${kingside ? 'f' : 'd'}${move.from[1]}` as Square;
    }
  }
  return { chess, pieces };
}
