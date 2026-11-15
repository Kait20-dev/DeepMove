'use client';
import { useState } from 'react';
import { api, pieceGlyphs } from './client';
import { material } from './rules';
import { Chess } from 'chess.js';
import type { AnalysisReport, GameView, MoveQuality } from './types';
import { MoveQualityBadge } from './MoveQualityBadge';
import { qualityNames } from './review-presentation';

export function MaterialPanel({ chess }: { chess: Chess }) {
  const summary = material(chess);
  return <section className="material-panel"><div className="material-top"><span>Материал на доске</span><strong>{summary.balance === 0 ? 'Равенство' : `${summary.balance > 0 ? 'Белые' : 'Чёрные'} +${Math.abs(summary.balance)}`}</strong></div><div><span>Белые взяли</span><span className="captured-pieces black-piece">{summary.capturedByWhite.map(type => pieceGlyphs[type]).join('') || '—'}</span></div><div><span>Чёрные взяли</span><span className="captured-pieces white-piece">{summary.capturedByBlack.map(type => pieceGlyphs[type]).join('') || '—'}</span></div><p>♟ 1 · ♞ 3 · ♝ 3 · ♜ 5 · ♛ 9. Материал не равен оценке позиции.</p></section>;
}
export function ReviewPanel({ game, ply, onPly, onAnalysis, authenticated }: { game: GameView; ply: number; onPly: (ply: number) => void; onAnalysis: (report: AnalysisReport) => void; authenticated: boolean }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const report = game.analysis;
  const qualities: MoveQuality[] = ['book', 'best', 'good', 'great', 'brilliant', 'inaccuracy', 'blunder', ...(report?.moves.some(move => move.quality === 'brilliant-candidate') ? ['brilliant-candidate' as const] : [])];
  const current = report?.moves[ply - 1];
  const currentIsMate = ply > 0 && new Chess(game.moves[ply - 1].fen).isCheckmate();
  let bestMoveLabel = current?.bestMove || '';
  if (current?.bestMove) {
    try { bestMoveLabel = new Chess(game.moves[ply - 2]?.fen).move(current.bestMove).san; } catch { /* Old/imported reports may lack a replayable recommendation. */ }
  }
  const recommendation = current?.bestMove === game.moves[ply - 1]?.uci ? 'Выбор движка' : bestMoveLabel ? `Лучше было: ${bestMoveLabel}` : `Потеря: ${current?.loss ?? 0} cp`;
  async function analyze() { setBusy(true); setError(''); try { onAnalysis(await api<AnalysisReport>(`/games/${game.id}/analysis`, {})); } catch (error) { setError((error as Error).message); } finally { setBusy(false); } }
  return <section className="arena-panel review-panel" aria-label="Разбор партии">
    {!report ? <><div className="review-heading"><h2>Разбор партии</h2><span className="arena-outline-badge">Stockfish</span></div><button className="button" onClick={analyze} disabled={busy || !authenticated || !game.moves.length}>{busy ? 'Stockfish разбирает партию…' : 'Анализировать партию'}</button><p className="field-hint">{!authenticated ? 'Войди в аккаунт, чтобы запустить анализ. Готовый разбор доступен всем.' : 'Точность, оценки и качество ходов. До 400 полуходов, не более 2 минут.'}</p></> : <>
      <div className="accuracy-cards"><div><span>Белые · точность</span><strong>{report.accuracy.w ?? '—'}{report.accuracy.w !== null ? '%' : ''}</strong></div><div><span>Чёрные · точность</span><strong>{report.accuracy.b ?? '—'}{report.accuracy.b !== null ? '%' : ''}</strong></div></div>
      <div className="current-analysis" aria-live="polite">{current ? <><MoveQualityBadge quality={current.quality} /><div><span className={`quality ${current.quality}`}>{current.san} · {qualityNames[current.quality]}</span><small>{recommendation}</small></div><strong>{current.mate !== null ? currentIsMate ? 'Мат' : `M${Math.abs(current.mate)}` : `${current.evaluation > 0 ? '+' : ''}${current.evaluation.toFixed(2)}`}</strong></> : <span>Выбери ход для подробностей.</span>}</div>
      <details className="review-extra"><summary>График и статистика <span className="review-engine">Stockfish ↗</span><span className="compact-accuracy" title="Точность белых / чёрных">Б {report.accuracy.w ?? '—'}% · Ч {report.accuracy.b ?? '—'}%</span></summary><div className="review-extra-content">{report.version !== 2 && <div className="refresh-analysis"><button className="text-button" disabled={busy || !authenticated} onClick={analyze}>{busy ? 'Обновляем разбор…' : 'Обновить разбор'}</button><p className="field-hint">Теория, ! и !! доступны после обновления разбора.{!authenticated && ' Для запуска войди в аккаунт.'}</p></div>}<EvaluationChart report={report} onPly={onPly} /><div className="quality-counts">{qualities.map(quality => <div key={quality}><span className={`quality ${quality}`}><MoveQualityBadge quality={quality} />{qualityNames[quality]}</span><strong>{report.moves.filter(move => move.quality === quality || quality === 'inaccuracy' && move.quality === 'mistake').length}</strong></div>)}</div><details className="analysis-method"><summary>Как считаем оценки и «бриллианты»</summary><p>{report.methodology}</p><p>{report.engine}. Это ограниченный по глубине анализ, а не окончательный вердикт.</p></details></div></details>
    </>}{error && <p role="alert" className="arena-error">{error}</p>}
  </section>;
}
function EvaluationChart({ report, onPly }: { report: AnalysisReport; onPly: (ply: number) => void }) {
  const positions = report.moves.map((move, index) => ({ x: 10 + index * 380 / Math.max(1, report.moves.length - 1), y: 60 - Math.max(-8, Math.min(8, move.evaluation)) * 6 }));
  return <div className="evaluation-chart"><p>Оценка позиции · выше — в пользу белых</p><svg viewBox="0 0 400 120" role="img" aria-label="График оценки позиций белых относительно чёрных"><line x1="0" x2="400" y1="60" y2="60" stroke="#5d4c71" strokeDasharray="4 4" /><polyline points={positions.map(p => `${p.x},${p.y}`).join(' ')} fill="none" stroke="#bc9de4" strokeWidth="2" />{positions.map((point, index) => <circle key={index} cx={point.x} cy={point.y} r="5" fill="transparent" tabIndex={0} role="button" aria-label={`Полуход ${index + 1}, оценка ${report.moves[index].evaluation}`} onClick={() => onPly(index + 1)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onPly(index + 1); } }} />)}</svg></div>;
}
