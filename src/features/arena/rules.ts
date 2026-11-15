import { Chess, type Color, type PieceSymbol } from 'chess.js';
import type { Game, GameView, MaterialSummary, Side } from './types';
import { ApiError, ensure } from '@/server/errors';

export const values: Record<PieceSymbol, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
export const opposite = (side: Side): Side => side === 'w' ? 'b' : 'w';
export function chessFor(game: Game): Chess {
  return new Chess(game.moves.at(-1)?.fen);
}
export function fullChess(game: Game): Chess {
  const chess = new Chess();
  for (const move of game.moves) chess.move(move.uci);
  return chess;
}
export function finish(game: Game, result: Game['result'], reason: string) {
  game.status = 'finished'; game.result = result; game.reason = reason; game.turnStartedAt = null; game.version++;
}
export function deadlineFor(game: Game): number | null {
  if (game.status !== 'playing' || game.turnStartedAt === null) return null;
  const turn = chessFor(game).turn();
  const cap = game.seats[turn].kind === 'bot' ? game.format.botMoveMs : null;
  return game.turnStartedAt + Math.min(game.clocks[turn], cap ?? Infinity);
}
function canPossiblyMate(chess: Chess, side: Side): boolean {
  const pieces = chess.board().flat().filter(piece => piece?.color === side && piece.type !== 'k');
  if (!pieces.length) return false;
  if (pieces.some(piece => piece && ['p', 'r', 'q'].includes(piece.type)) || pieces.length > 1) return true;
  // A lone minor piece can sometimes mate with opposing material blocking escape.
  return chess.board().flat().some(piece => piece && piece.color !== side && piece.type !== 'k');
}
export function settleClock(game: Game, now: number) {
  if (game.status === 'waiting' && game.startsAt !== null && now >= game.startsAt) {
    game.status = 'playing';
    game.turnStartedAt = game.startsAt;
    game.version++;
  }
  const deadline = deadlineFor(game);
  if (deadline === null || now < deadline) return;
  const chess = chessFor(game);
  const side = chess.turn();
  game.clocks[side] = Math.max(0, game.clocks[side] - (deadline - game.turnStartedAt!));
  const winner = opposite(side);
  finish(game, canPossiblyMate(chess, winner) ? winner === 'w' ? '1-0' : '0-1' : '1/2-1/2', 'timeout');
}
export function applyMove(game: Game, side: Side, uci: string, expectedPly: number, now: number) {
  settleClock(game, now);
  ensure(!(game.status === 'waiting' && game.startsAt !== null), 409, 'Идёт обратный отсчёт до старта', 'not_started');
  ensure(game.status === 'playing', 409, 'Партия не идёт', 'not_playing');
  ensure(expectedPly === game.moves.length, 409, 'Позиция устарела. Обновите состояние.', 'stale_position');
  const chess = fullChess(game);
  ensure(chess.turn() === side, 403, 'Сейчас ход соперника', 'not_your_turn');
  ensure(/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci), 400, 'Ход должен быть в UCI: e2e4 или a7a8q');
  ensure(chess.moves({ verbose: true }).some(move => `${move.from}${move.to}${move.promotion || ''}` === uci), 422, 'Нелегальный ход', 'illegal_move');
  let move;
  try { move = chess.move(uci); } catch { throw new ApiError(422, 'Нелегальный ход', 'illegal_move'); }
  const elapsedMs = Math.max(0, now - game.turnStartedAt!);
  game.clocks[side] = Math.max(0, game.clocks[side] - elapsedMs) + game.format.incrementMs;
  game.moves.push({ uci, san: move.san, fen: chess.fen(), elapsedMs, remainingMs: game.clocks[side] });
  game.turnStartedAt = now; game.version++;
  if (chess.isCheckmate()) finish(game, side === 'w' ? '1-0' : '0-1', 'checkmate');
  else if (chess.isDraw()) finish(game, '1/2-1/2', chess.isStalemate() ? 'stalemate' : chess.isThreefoldRepetition() ? 'repetition' : chess.isInsufficientMaterial() ? 'insufficient_material' : 'fifty_moves');
}
export function material(chess: Chess): MaterialSummary {
  const summary: MaterialSummary = { white: 0, black: 0, balance: 0, capturedByWhite: [], capturedByBlack: [] };
  for (const piece of chess.board().flat()) if (piece) summary[piece.color === 'w' ? 'white' : 'black'] += values[piece.type];
  for (const move of chess.history({ verbose: true })) if (move.captured) summary[move.color === 'w' ? 'capturedByWhite' : 'capturedByBlack'].push(move.captured);
  summary.balance = summary.white - summary.black;
  return summary;
}
const safeHeader = (value: string) => value.replace(/[\[\]"\\\r\n]/g, '').slice(0, 80);
export function pgnFor(game: Game): string {
  const chess = new Chess();
  const headers = { Event: 'DeepMove Arena', Site: 'DeepMove', Date: new Date(game.createdAt).toISOString().slice(0, 10).replaceAll('-', '.'), Round: '-', White: safeHeader(game.seats.w.name), Black: safeHeader(game.seats.b.name), Result: game.result, TimeControl: `${game.format.initialMs / 1000}+${game.format.incrementMs / 1000}`, BotMoveLimit: game.format.botMoveMs === null ? '-' : `${game.format.botMoveMs / 1000}`, Termination: game.reason || 'unterminated' };
  for (const [key, value] of Object.entries(headers)) chess.setHeader(key, value);
  for (const record of game.moves) {
    chess.move(record.uci);
    const seconds = record.remainingMs / 1000;
    chess.setComment(`[%clk ${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${(seconds % 60).toFixed(3).padStart(6, '0')}] [%emt ${(record.elapsedMs / 1000).toFixed(3)}]`);
  }
  return chess.pgn();
}
export function viewGame(game: Game, now: number): GameView {
  const chess = fullChess(game);
  const seats = Object.fromEntries((['w', 'b'] as Color[]).map(side => {
    const { userId, name, kind, ready } = game.seats[side]; return [side, { userId, name, kind, ready }];
  })) as GameView['seats'];
  const { joinHash: _joinHash, ...publicGame } = game;
  void _joinHash;
  return { ...publicGame, seats, analysis: game.status === 'finished' ? game.analysis || null : null, fen: chess.fen(), turn: chess.turn(), legalMoves: game.status === 'playing' ? chess.moves({ verbose: true }).map(move => `${move.from}${move.to}${move.promotion || ''}`) : [], serverNow: now, deadline: deadlineFor(game), pgn: pgnFor(game), material: material(chess) };
}
