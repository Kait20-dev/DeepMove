import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import { isBookMove, isBrilliantSacrifice, isGreatMove } from '../src/server/analysis-quality';

test('theory requires a matching catalogue prefix, never just an early move', () => {
  assert.equal(isBookMove(['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5'], 5), true);
  assert.equal(isBookMove(['e2e4', 'e7e5', 'f2f3'], 3), false);
  assert.equal(isBookMove(['a2a4'], 1), false);
  assert.equal(isBookMove([], 0), false);
  for (const line of [
    'e2e4 e7e5 g1f3 b8c6 f1b5 a7a6 b5a4 g8f6 e1g1 f8e7',
    'e2e4 c7c5 g1f3 d7d6 d2d4 c5d4 f3d4 g8f6 b1c3',
    'd2d4 g8f6 c2c4 e7e6 b1c3 f8b4',
  ]) {
    const chess = new Chess();
    for (const move of line.split(' ')) assert.ok(chess.move(move));
  }
});
test('great moves require a separately verified inferior alternative from either colour', () => {
  assert.equal(isGreatMove(0, 50, -150, 'w'), true);
  assert.equal(isGreatMove(0, -50, 150, 'b'), true);
  assert.equal(isGreatMove(0, 50, 40, 'w'), false);
  assert.equal(isGreatMove(0, 400, 200, 'w'), false, 'several winning moves are not a unique saving move');
  assert.equal(isGreatMove(16, 50, -150, 'w'), false);
  assert.equal(isGreatMove(0, -200, -400, 'w'), false);
});
test('brilliant requires a real unforced material sacrifice with surviving compensation', () => {
  const sacrifice = { loss: 10, legalChoices: 15, pieceValue: 3, replyTakesPiece: true, materialBefore: 0, materialAfterReply: -3, beforeCp: 20, replyCp: 10, side: 'w' as const };
  assert.equal(isBrilliantSacrifice(sacrifice), true);
  assert.equal(isBrilliantSacrifice({ ...sacrifice, materialAfterReply: 3, beforeCp: -20, replyCp: -10, side: 'b' }), true);
  assert.equal(isBrilliantSacrifice({ ...sacrifice, materialAfterReply: 0 }), false, 'equal trades are not sacrifices');
  assert.equal(isBrilliantSacrifice({ ...sacrifice, legalChoices: 1 }), false);
  assert.equal(isBrilliantSacrifice({ ...sacrifice, replyCp: -500 }), false, 'a blunder is not a brilliant sacrifice');
  assert.equal(isBrilliantSacrifice({ ...sacrifice, replyTakesPiece: false }), false);
  assert.equal(isBrilliantSacrifice({ ...sacrifice, pieceValue: 1 }), false);
});
