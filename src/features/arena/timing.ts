import type { Game, MoveRecord, Side, TimeoutDetails } from './types';

/** Clocks immediately after an accepted ply, including any increment. */
export function clocksAtPly(game: Pick<Game, 'format' | 'moves'>, ply: number): Record<Side, number> {
  const clocks = { w: game.format.initialMs, b: game.format.initialMs };
  for (let index = 0; index < Math.min(Math.max(0, ply), game.moves.length); index++) {
    clocks[index % 2 ? 'b' : 'w'] = game.moves[index].remainingMs;
  }
  return clocks;
}

/** Old archives also contain enough clock data to distinguish the two limits. */
export function timeoutFor(game: Pick<Game, 'status' | 'reason' | 'timeout' | 'moves' | 'clocks' | 'format'> & { seats: Record<Side, Pick<Game['seats'][Side], 'kind'>> }): TimeoutDetails | null {
  if (game.status !== 'finished' || game.reason !== 'timeout') return null;
  if (game.timeout) return game.timeout;
  const side: Side = game.moves.length % 2 ? 'b' : 'w';
  const cap = game.seats[side].kind === 'bot' ? game.format.botMoveMs : game.format.humanMoveMs;
  const remainingMs = game.clocks[side];
  const kind = remainingMs > 0 && cap != null ? 'move' : 'total';
  return { side, kind, ply: game.moves.length + 1, limitMs: kind === 'move' ? cap! : clocksAtPly(game, game.moves.length)[side], remainingMs };
}

export const secondsText = (ms: number) => (Math.max(0, ms) / 1000).toFixed(3).replace('.', ',');

export function clockText(ms: number, precise = false, short = false): string {
  const remaining = Math.max(0, ms);
  if (precise) return `${Math.floor(remaining / 60000)}:${((remaining % 60000) / 1000).toFixed(3).padStart(6, '0')}`;
  if (short && remaining < 10000) return `0:${(Math.ceil(remaining / 100) / 10).toFixed(1).padStart(4, '0')}`;
  const seconds = Math.ceil(remaining / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function moveTiming(record: MoveRecord): string {
  return `На ход: ${secondsText(record.elapsedMs)} с · Осталось: ${clockText(record.remainingMs, true)}`;
}

export function timeoutTitle(timeout: TimeoutDetails): string {
  const side = timeout.side === 'w' ? 'Белые' : 'Чёрные';
  return timeout.kind === 'move' ? `${side}: истёк лимит на ход` : `${side}: закончилось общее время`;
}

export function timeoutDescription(timeout: TimeoutDetails): string {
  const move = `${Math.ceil(timeout.ply / 2)}${timeout.side === 'w' ? '.' : '...'}`;
  return `Ход ${move} не принят до дедлайна. ${timeout.kind === 'move' ? 'Лимит на ход' : 'Общий запас на начало хода'}: ${secondsText(timeout.limitMs)} с. Остаток общего времени: ${secondsText(timeout.remainingMs)} с.`;
}

export function timeoutArrivalText(timeout: TimeoutDetails): string {
  if (timeout.lateMove) return `Опоздание: ${timeout.lateMove.delayMs} мс (${secondsText(timeout.lateMove.delayMs)} с). Поздний ход: ${timeout.lateMove.uci}.`;
  return timeout.deadlineAt == null
    ? 'В этой партии время позднего запроса не записывалось. Точное опоздание неизвестно.'
    : 'Поздний ход пока не получен. Величина опоздания неизвестна; по одному таймауту нельзя определить зависание бота.';
}
