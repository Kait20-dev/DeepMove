import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readdirSync } from 'node:fs';
import { Chess } from 'chess.js';
import { loadGame, saveGame, transaction } from './db';
import { ensure, ApiError } from './errors';
import { opposite, values } from '@/features/arena/rules';
import type { AnalysisReport, Game, MoveAnalysis, MoveQuality, Side } from '@/features/arena/types';

interface Evaluation { cp: number; mate: number | null; bestMove: string | null; depth: number }
/** A bounded, isolated analysis process; it never receives participant code. */
class UciEngine {
  private process: ChildProcessWithoutNullStreams;
  private listener: ((line: string) => void) | null = null;
  private failed: Error | null = null;
  constructor() {
    const require = createRequire(import.meta.url);
    const bin = join(dirname(require.resolve('stockfish')), 'bin');
    const filename = readdirSync(bin).find(name => /^stockfish-\d+-lite-single\.js$/.test(name));
    ensure(filename, 503, 'Stockfish не установлен');
    this.process = spawn(process.execPath, [join(bin, filename)], { windowsHide: true, stdio: 'pipe' });
    const lines = createInterface({ input: this.process.stdout });
    lines.on('line', line => this.listener?.(line));
    this.process.stderr.on('data', () => { /* drain bounded child stderr */ });
    this.process.on('error', error => { this.failed = error; this.listener?.('__engine_error__'); });
    this.process.on('exit', () => { this.failed = new Error('Stockfish exited'); this.listener?.('__engine_error__'); });
  }
  private command(commands: string[], done: (line: string) => boolean, onLine?: (line: string) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.failed) { reject(new ApiError(503, 'Движок анализа недоступен')); return; }
      const timer = setTimeout(() => { this.listener = null; reject(new ApiError(503, 'Движок анализа не ответил вовремя')); this.close(); }, 5000);
      this.listener = line => {
        if (line === '__engine_error__') { clearTimeout(timer); this.listener = null; reject(new ApiError(503, 'Движок анализа остановился')); return; }
        onLine?.(line);
        if (done(line)) { clearTimeout(timer); this.listener = null; resolve(); }
      };
      for (const command of commands) this.process.stdin.write(`${command}\n`);
    });
  }
  async ready() {
    await this.command(['uci'], line => line === 'uciok');
    await this.command(['setoption name Hash value 32', 'isready'], line => line === 'readyok');
  }
  async evaluate(fen: string): Promise<Evaluation> {
    const chess = new Chess(fen);
    if (chess.isCheckmate()) return { cp: chess.turn() === 'w' ? -100000 : 100000, mate: chess.turn() === 'w' ? -1 : 1, bestMove: null, depth: 0 };
    if (chess.isStalemate() || chess.isInsufficientMaterial()) return { cp: 0, mate: null, bestMove: null, depth: 0 };
    let result: Evaluation | null = null;
    await this.command([`position fen ${fen}`, 'go depth 12 nodes 30000'], line => line.startsWith('bestmove '), line => {
      const score = line.match(/\bscore (cp|mate) (-?\d+)/);
      if (line.startsWith('info ') && score && !/\b(upperbound|lowerbound)\b/.test(line)) {
        const sign = chess.turn() === 'w' ? 1 : -1;
        const value = Number(score[2]) * sign;
        result = { cp: score[1] === 'mate' ? Math.sign(value) * (100000 - Math.abs(value) * 100) : value, mate: score[1] === 'mate' ? value : null, bestMove: line.match(/\bpv ([a-h][1-8][a-h][1-8][qrbn]?)/)?.[1] || null, depth: Number(line.match(/\bdepth (\d+)/)?.[1] || 0) };
      }
    });
    ensure(result, 503, 'Движок не вернул оценку позиции');
    return result;
  }
  close() { this.process.kill(); }
}
export function classifyLoss(loss: number): MoveQuality {
  return loss <= 15 ? 'best' : loss <= 50 ? 'good' : loss <= 100 ? 'inaccuracy' : loss <= 250 ? 'mistake' : 'blunder';
}
export async function analyzeGame(game: Game): Promise<AnalysisReport> {
  ensure(game.status === 'finished', 409, 'Анализ доступен только после завершения партии');
  ensure(game.moves.length <= 400, 422, 'Для анализа этой версии поддерживается до 400 полуходов');
  const engine = new UciEngine();
  const deadline = Date.now() + 120_000;
  try {
    await engine.ready();
    const chess = new Chess();
    let before = await engine.evaluate(chess.fen());
    const moves: MoveAnalysis[] = [];
    for (const [index, record] of game.moves.entries()) {
      ensure(Date.now() < deadline, 503, 'Разбор превысил лимит 120 секунд. Попробуйте позже.');
      const played = chess.move(record.uci);
      const after = await engine.evaluate(chess.fen());
      const sign = played.color === 'w' ? 1 : -1;
      const loss = Math.min(1000, Math.max(0, (before.cp - after.cp) * sign));
      let quality = classifyLoss(loss);
      const replyRecord = game.moves[index + 1];
      if (loss <= 20 && values[played.piece] >= 3 && after.cp * sign >= -50 && replyRecord && chess.isAttacked(played.to, opposite(played.color))) {
        const reply = new Chess(chess.fen()).move(replyRecord.uci);
        if (reply.to === played.to && reply.captured === played.piece) quality = 'brilliant-candidate';
      }
      moves.push({ ply: index + 1, san: record.san, evaluation: after.cp / 100, mate: after.mate, loss: Math.round(loss), accuracy: Math.round(100 * Math.exp(-loss / 150)), quality, bestMove: before.bestMove });
      before = after;
    }
    const accuracy = Object.fromEntries((['w', 'b'] as Side[]).map(side => {
      const scores = moves.filter(move => (move.ply % 2 === 1 ? 'w' : 'b') === side);
      return [side, scores.length ? Math.round(scores.reduce((total, move) => total + move.accuracy, 0) / scores.length) : null];
    })) as AnalysisReport['accuracy'];
    return { engine: 'Stockfish 19 Lite · 30k nodes / position', depth: 12, createdAt: Date.now(), moves, accuracy, methodology: 'До глубины 12 или 30 000 узлов на позицию. Потеря оценки в сантипешках: ≤15 лучший, ≤50 хороший, ≤100 неточность, ≤250 ошибка, >250 зевок. Точность = среднее 100·exp(−потеря/150). Это метрика DeepMove, не Chess.com. «Кандидат !!»: не ухудшающий оценку ход с последующим взятием пожертвованной фигуры, требует проверки человеком.' };
  } finally { engine.close(); }
}
let running: Promise<AnalysisReport> | null = null;
let runningId: string | null = null;
export async function requestAnalysis(id: string): Promise<AnalysisReport> {
  const game = loadGame(id);
  ensure(game.status === 'finished', 409, 'Во время игры подсказки и анализ недоступны');
  if (game.analysis) return game.analysis;
  if (runningId === id && running) return running;
  ensure(!running, 429, 'Сейчас разбирается другая партия. Повторите позже.');
  runningId = id;
  running = analyzeGame(game).then(report => {
    transaction(() => { const latest = loadGame(id); latest.analysis = report; saveGame(latest); });
    return report;
  });
  try { return await running; }
  finally { running = null; runningId = null; }
}
