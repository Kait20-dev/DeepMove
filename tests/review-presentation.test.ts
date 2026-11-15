import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluationDisplay } from '../src/features/arena/review-presentation';
import type { MoveAnalysis } from '../src/features/arena/types';

const move = (evaluation: number, mate: number | null = null): MoveAnalysis => ({ ply: 1, san: 'e4', evaluation, mate, loss: 0, accuracy: 100, quality: 'best', bestMove: 'e2e4' });
test('advantage bar uses a white-relative engine score, with a neutral unavailable state', () => {
  assert.equal(evaluationDisplay().available, false);
  assert.equal(evaluationDisplay().label, '—');
  assert.equal(evaluationDisplay().whitePercent, 50);
  assert.equal(evaluationDisplay(move(0)).whitePercent, 50);
  assert.ok(evaluationDisplay(move(2)).whitePercent > evaluationDisplay(move(1)).whitePercent);
  assert.ok(evaluationDisplay(move(-2)).whitePercent < 50);
  assert.ok(Math.abs(evaluationDisplay(move(2)).whitePercent + evaluationDisplay(move(-2)).whitePercent - 100) < .001);
  assert.equal(evaluationDisplay(move(1000)).whitePercent, 98);
  assert.equal(evaluationDisplay(move(-1000)).whitePercent, 2);
});
test('forced and completed mates fill the winning side, including zero mate scores', () => {
  assert.equal(evaluationDisplay(move(999, 3)).label, 'M3');
  assert.equal(evaluationDisplay(move(999, 3)).whitePercent, 100);
  assert.equal(evaluationDisplay(move(-999, -2)).whitePercent, 0);
  assert.equal(evaluationDisplay(move(0, 0), 'w').whitePercent, 100);
  assert.equal(evaluationDisplay(move(0, 0), 'b').whitePercent, 0);
  assert.equal(evaluationDisplay(move(0, 0), 'w').label, 'M');
});
