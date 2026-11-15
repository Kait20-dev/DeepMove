import { evaluationDisplay } from './review-presentation';
import type { MoveAnalysis, Side } from './types';

export function EvaluationBar({ move, orientation, checkmateWinner, finished }: { move?: MoveAnalysis; orientation: Side; checkmateWinner?: Side; finished: boolean }) {
  const evaluation = evaluationDisplay(move, checkmateWinner);
  const description = !finished ? 'Оценка доступна после завершения партии' : evaluation.description;
  const whiteLeads = evaluation.whitePercent >= 50;
  const labelAtBottom = whiteLeads === (orientation === 'w');
  return <div className={`evaluation-bar ${evaluation.available ? '' : 'unavailable'}`} role="img" aria-label={`Шкала преимущества: ${description}`} title={description}>
    <div className="evaluation-fill" style={{ height: `${evaluation.whitePercent}%`, [orientation === 'w' ? 'bottom' : 'top']: 0 }} />
    <span className={`evaluation-value ${whiteLeads ? 'on-white' : 'on-black'} ${labelAtBottom ? 'at-bottom' : 'at-top'}`}>{evaluation.label}</span>
    <span className="evaluation-midline" />
  </div>;
}
