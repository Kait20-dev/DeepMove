import { Chess, type PieceSymbol, type Color, type Square } from 'chess.js';

const opening = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'd3', 'd6', 'Nc3', 'Nf6'];
export const loopMoves = [
  'Qd2', 'Bb6',
  'Ke2', 'Ba5',
  'Na4', 'Be6',
  'Rg1', 'Ke7',
  'Nb6', 'Bf5',
  'Bb3', 'Rg8',
  'Kf1', 'Rf8',
  'Ba4', 'Qd7',
  'Qe2', 'Bg4',
  'Qd1', 'Rh8',
  'Bb5', 'Kf8',
  'Be3', 'Qe7',
  'Bf4', 'Qd8',
  'Bg5', 'Ke8',
  'Nd5', 'Bc8',
  'Nc3', 'Bb4',
  'Ke1', 'Bc5',
  'Bc4', 'Na5',
  'Rf1', 'Nb3',
  'Bc1', 'Nd4',
  'Rh1', 'Nc6',
] as const;
export interface VisualPiece { square: Square; type: PieceSymbol; color: Color }
export interface AnimationFrame { pieces: VisualPiece[]; from: Square; to: Square }
export interface AnimationGroup { pieces: VisualPiece[]; moves: { from: Square; to: Square }[] }
export function visualPieces(game: Chess): VisualPiece[] {
  return game.board().flatMap(row => row.flatMap(piece => piece ? [{ square: piece.square, type: piece.type, color: piece.color }] : []));
}
export function createGame(): Chess {
  const game = new Chess();
  opening.forEach(move => game.move(move));
  // A middlegame demonstration without castling: king/rook excursions can loop.
  game.setCastlingRights('w', { k: false, q: false });
  game.setCastlingRights('b', { k: false, q: false });
  return game;
}
export function createFrames(): AnimationFrame[] {
  const game = createGame();
  return loopMoves.map(san => {
    const pieces = visualPieces(game);
    const move = game.move(san);
    return { pieces, from: move.from, to: move.to };
  });
}
/** Each pair is checked sequentially; independent moves animate together. */
export function createAnimationGroups(): AnimationGroup[] {
  const frames = createFrames();
  return frames.filter((_, index) => index % 2 === 0).map((frame, index) => ({
    pieces: frame.pieces,
    moves: frames.slice(index * 2, index * 2 + 2).map(({ from, to }) => ({ from, to })),
  }));
}
