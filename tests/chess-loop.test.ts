import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, createFrames, createAnimationGroups, loopMoves } from '../src/features/chess-background/game';

test('all animation moves are legal and the loop returns to the same position', () => {
  const game = createGame();
  const initial = game.fen().split(' ').slice(0, 4).join(' ');
  for (const move of loopMoves) {
    const result = game.move(move);
    assert.ok(result);
    assert.equal(result.captured, undefined);
    const squares = game.board().flatMap(row => row.flatMap(piece => piece ? [piece.square] : []));
    assert.equal(new Set(squares).size, 32);
  }
  assert.equal(game.fen().split(' ').slice(0, 4).join(' '), initial);
});
test('simultaneous pairs move two different pieces along nonintersecting paths', () => {
  for (const group of createAnimationGroups()) {
    assert.equal(group.moves.length, 2);
    assert.notEqual(group.moves[0].from, group.moves[1].from);
    const types = group.moves.map(move => group.pieces.find(piece => piece.square === move.from)?.type);
    assert.notEqual(types[0], types[1], 'simultaneously moving pieces must have different types');
    for (const move of group.moves) {
      assert.ok(group.pieces.some(piece => piece.square === move.from));
      assert.ok(!group.pieces.some(piece => piece.square === move.to));
    }
    const coordinate = (square: string) => [square.charCodeAt(0) - 97, 8 - Number(square[1])];
    for (let step = 0; step <= 100; step++) {
      const positions = group.moves.map((move, index) => {
        const t = Math.max(0, Math.min((step / 100 - index * 0.08) / 0.65, 1));
        const ease = t * t * (3 - 2 * t);
        const [x, y] = coordinate(move.from);
        const [endX, endY] = coordinate(move.to);
        return [x + (endX - x) * ease, y + (endY - y) * ease];
      });
      assert.ok(Math.hypot(positions[0][0] - positions[1][0], positions[0][1] - positions[1][1]) >= 0.85);
    }
  }
});
test('animation frames have one moving piece and an empty destination', () => {
  for (const frame of createFrames()) {
    assert.equal(frame.pieces.filter(piece => piece.square === frame.from).length, 1);
    assert.equal(frame.pieces.filter(piece => piece.square === frame.to).length, 0);
  }
});
test('the sequence includes bishops, rooks, queens, kings and knights', () => {
  const movingTypes = new Set(createFrames().map(frame => frame.pieces.find(piece => piece.square === frame.from)?.type));
  for (const type of ['b', 'r', 'q', 'k', 'n']) assert.ok(movingTypes.has(type as 'b' | 'r' | 'q' | 'k' | 'n'));
  assert.equal(loopMoves.length, 42);
});
test('pieces continue to new squares rather than immediately reversing their own last move', () => {
  const game = createGame();
  const identities = new Map<string, { id: string; previous: string }>(game.board().flatMap(row => row.flatMap(piece => piece ? [[piece.square, { id: piece.square, previous: '' }] as const] : [])));
  for (let cycle = 0; cycle < 2; cycle++) {
    for (const san of loopMoves) {
      const move = game.move(san);
      const identity = identities.get(move.from);
      assert.ok(identity);
      assert.notEqual(move.to, identity.previous, `${san} immediately reverses the previous move of ${identity.id}`);
      identities.delete(move.from);
      identities.set(move.to, { id: identity.id, previous: move.from });
    }
  }
});
