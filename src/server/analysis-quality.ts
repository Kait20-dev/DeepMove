import type { Side } from '@/features/arena/types';

// A deliberately small, explicit catalogue; it is used only in archived analysis,
// never as a book for participant bots. An arbitrary early move is not "theory".
const openingLines = [
  'e2e4 e7e5 g1f3 b8c6 f1b5 a7a6 b5a4 g8f6 e1g1 f8e7',
  'e2e4 e7e5 g1f3 b8c6 f1c4 f8c5 c2c3 g8f6 d2d3',
  'e2e4 e7e5 g1f3 b8c6 d2d4 e5d4 f3d4',
  'e2e4 c7c5 g1f3 d7d6 d2d4 c5d4 f3d4 g8f6 b1c3',
  'e2e4 e7e6 d2d4 d7d5 b1c3 g8f6 e4e5',
  'e2e4 c7c6 d2d4 d7d5 b1c3 d5e4 c3e4',
  'd2d4 d7d5 c2c4 e7e6 b1c3 g8f6 c1g5',
  'd2d4 g8f6 c2c4 e7e6 b1c3 f8b4',
  'd2d4 d7d5 g1f3 g8f6 c1f4',
  'c2c4 e7e5 b1c3 g8f6 g1f3 b8c6',
].map(line => line.split(' '));

export function isBookMove(history: readonly string[], ply: number): boolean {
  return ply > 0 && openingLines.some(line => ply <= line.length && line.slice(0, ply).every((move, index) => history[index] === move));
}

export function isGreatMove(loss: number, bestCp: number, alternativeCp: number, side: Side): boolean {
  const sign = side === 'w' ? 1 : -1;
  return loss <= 15 && bestCp * sign >= -100 && alternativeCp * sign < 100 && (bestCp - alternativeCp) * sign >= 150;
}

export function isBrilliantSacrifice(input: { loss: number; legalChoices: number; pieceValue: number; replyTakesPiece: boolean; materialBefore: number; materialAfterReply: number; beforeCp: number; replyCp: number; side: Side }): boolean {
  const sign = input.side === 'w' ? 1 : -1;
  return input.loss <= 20 && input.legalChoices > 1 && input.pieceValue >= 3 && input.replyTakesPiece
    && (input.materialBefore - input.materialAfterReply) * sign >= 2
    && input.replyCp * sign >= -100 && (input.beforeCp - input.replyCp) * sign <= 75;
}
