import { pieceGlyphs, pieceNames } from './client';
import type { MaterialSummary, Side } from './types';

export function CapturedPieces({ summary, side }: { summary: MaterialSummary; side: Side }) {
  const captured = side === 'w' ? summary.capturedByWhite : summary.capturedByBlack;
  const advantage = summary.balance * (side === 'w' ? 1 : -1);
  return <div className="captured-strip" aria-label={`${side === 'w' ? 'Белые' : 'Чёрные'} взяли`}>
    <span className={`captured-glyphs ${side === 'w' ? 'black-piece' : 'white-piece'}`} role="img" aria-label={captured.length ? captured.map(type => pieceNames[type]).join(', ') : 'Нет взятий'}>
      {captured.length ? ['q', 'r', 'b', 'n', 'p'].map(type => {
        const count = captured.filter(piece => piece === type).length;
        return count ? <span key={type} className="captured-group" aria-hidden="true">{pieceGlyphs[type].repeat(count)}</span> : null;
      }) : <span className="capture-empty" aria-hidden="true">Нет взятий</span>}
    </span>
    {advantage > 0 && <strong className="material-advantage" title="Перевес по материалу: пешка 1, конь/слон 3, ладья 5, ферзь 9" aria-label={`Материальный перевес ${side === 'w' ? 'белых' : 'чёрных'}: ${advantage}`}>+{advantage}</strong>}
  </div>;
}
