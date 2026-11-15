import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import { boardPosition } from '../src/features/arena/board-position';

const records = (moves: string[]) => moves.map(uci => ({ uci }));
test('pieces retain identity while moving, being captured and rewinding', () => {
  const moves = records(['e2e4', 'd7d5', 'e4d5']);
  const forward = boardPosition(moves, 3);
  assert.equal(forward.pieces.find(piece => piece.id === 'e2')?.square, 'd5');
  assert.equal(forward.pieces.find(piece => piece.id === 'd7')?.active, false);
  assert.equal(forward.pieces.length, 32);
  const previous = boardPosition(moves, 2);
  assert.equal(previous.pieces.find(piece => piece.id === 'd7')?.active, true);
  assert.equal(previous.pieces.find(piece => piece.id === 'e2')?.square, 'e4');
});
test('castling animates king and rook with their original identities', () => {
  const moves = records(['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'f8c5', 'e1g1']);
  const { pieces } = boardPosition(moves, moves.length);
  assert.equal(pieces.find(piece => piece.id === 'e1')?.square, 'g1');
  assert.equal(pieces.find(piece => piece.id === 'h1')?.square, 'f1');
});
test('en passant fades the captured pawn on its own square', () => {
  const moves = records(['e2e4', 'a7a6', 'e4e5', 'd7d5', 'e5d6']);
  const { pieces } = boardPosition(moves, moves.length);
  assert.equal(pieces.find(piece => piece.id === 'e2')?.square, 'd6');
  const captured = pieces.find(piece => piece.id === 'd7');
  assert.equal(captured?.active, false); assert.equal(captured?.square, 'd5');
});
test('promotion keeps the pawn identity and replay restores its pawn glyph', () => {
  const moves = records(['a2a4', 'h7h5', 'a4a5', 'h5h4', 'a5a6', 'h4h3', 'a6b7', 'h3g2', 'b7a8q']);
  const after = boardPosition(moves, 9);
  assert.equal(after.pieces.find(piece => piece.id === 'a2')?.type, 'q');
  assert.equal(after.pieces.find(piece => piece.id === 'a8')?.active, false);
  assert.equal(boardPosition(moves, 8).pieces.find(piece => piece.id === 'a2')?.type, 'p');
  const board = new Chess(); moves.forEach(move => board.move(move.uci));
  assert.equal(after.chess.fen(), board.fen());
});
