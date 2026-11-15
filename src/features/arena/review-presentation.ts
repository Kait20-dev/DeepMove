import type { MoveAnalysis, MoveQuality, Side } from './types';

export const qualityNames: Record<MoveQuality, string> = {
  book: 'Теоретический', great: 'Замечательный', brilliant: 'Бриллиантовый', best: 'Лучший', good: 'Хороший', inaccuracy: 'Неточность', mistake: 'Неточность', blunder: 'Зевок', 'brilliant-candidate': 'Кандидат !!',
};

/** Analysis only: material and the game's result never stand in for an engine score. */
export function evaluationDisplay(move?: MoveAnalysis, checkmateWinner?: Side) {
  if (!move) return { available: false, whitePercent: 50, label: '—', description: 'Оценка этой позиции недоступна' };
  if (move.mate !== null) {
    const winner = checkmateWinner ?? (move.mate > 0 ? 'w' : 'b');
    return { available: true, whitePercent: winner === 'w' ? 100 : 0,
      label: checkmateWinner ? 'M' : `M${Math.abs(move.mate)}`,
      description: `${checkmateWinner ? 'Мат' : `Мат в ${Math.abs(move.mate)}`} · ${winner === 'w' ? 'белые' : 'чёрные'}` };
  }
  const score = Number.isFinite(move.evaluation) ? move.evaluation : 0;
  return { available: true, whitePercent: Math.max(2, Math.min(98, 50 + 50 * Math.tanh(score / 4))),
    label: `${score > 0 ? '+' : ''}${score.toFixed(1)}`,
    description: `Оценка ${score > 0 ? '+' : ''}${score.toFixed(2)} · ${score === 0 ? 'равенство' : score > 0 ? 'в пользу белых' : 'в пользу чёрных'}` };
}
