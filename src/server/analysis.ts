import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { readdirSync } from 'node:fs';
import { Chess, type Move } from 'chess.js';
import { loadGame, saveGame, transaction } from './db';
import { ensure, ApiError } from './errors';
import { values } from '@/features/arena/rules';
import { isBookMove, isBrilliantSacrifice, isGreatMove } from './analysis-quality';
import type { AnalysisReport, Game, MoveAnalysis, MoveQuality, Side } from '@/features/arena/types';

interface Evaluation { cp: number; mate: number | null; bestMove: string | null; depth: number }
/** A bounded, isolated analysis process; it never receives participant code. */
class UciEngine {
  private process: ChildProcessWithoutNullStreams;
  private listener: ((line: string) => void) | null = null;
  private failed: Error | null = null;
  constructor() {
    // Resolve the CLI file on disk, not a bundled require.resolve module ID.
    const bin = join(process.cwd(), 'node_modules', 'stockfish', 'bin');
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
  async evaluate(fen: string, searchMoves?: string[]): Promise<Evaluation> {
    const chess = new Chess(fen);
    if (chess.isCheckmate()) return { cp: chess.turn() === 'w' ? -100000 : 100000, mate: chess.turn() === 'w' ? -1 : 1, bestMove: null, depth: 0 };
    if (chess.isStalemate() || chess.isInsufficientMaterial()) return { cp: 0, mate: null, bestMove: null, depth: 0 };
    let result: Evaluation | null = null;
    await this.command([`position fen ${fen}`, `go depth 12 nodes 30000${searchMoves ? ` searchmoves ${searchMoves.join(' ')}` : ''}`], line => line.startsWith('bestmove '), line => {
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
  return loss <= 15 ? 'best' : loss <= 50 ? 'good' : loss <= 250 ? 'inaccuracy' : 'blunder';
}
export async function analyzeGame(game: Game): Promise<AnalysisReport> {
  ensure(game.status === 'finished', 409, 'Анализ доступен только после завершения партии');
  ensure(game.moves.length <= 400, 422, 'Для анализа этой версии поддерживается до 400 полуходов');
  const engine = new UciEngine();
  const deadline = Date.now() + 120_000;
  try {
    await engine.ready();
    const chess = new Chess();
    const initial = await engine.evaluate(chess.fen());
    const samples: { played: Move; beforeFen: string; beforeMaterial: number; afterMaterial: number; legalChoices: number; after: Evaluation }[] = [];
    let balance = 0;
    for (const record of game.moves) {
      ensure(Date.now() < deadline, 503, 'Разбор превысил лимит 120 секунд. Попробуйте позже.');
      const beforeFen = chess.fen(), beforeMaterial = balance, legalChoices = chess.moves().length;
      const played = chess.move(record.uci);
      balance = chess.board().flat().reduce((sum, piece) => sum + (piece ? values[piece.type] * (piece.color === 'w' ? 1 : -1) : 0), 0);
      samples.push({ played, beforeFen, beforeMaterial, afterMaterial: balance, legalChoices, after: await engine.evaluate(chess.fen()) });
    }
    const moves: MoveAnalysis[] = [];
    const history = game.moves.map(move => move.uci);
    for (const [index, record] of game.moves.entries()) {
      ensure(Date.now() < deadline, 503, 'Разбор превысил лимит 120 секунд. Попробуйте позже.');
      const sample = samples[index], { played, after } = sample;
      const before = index ? samples[index - 1].after : initial;
      const sign = played.color === 'w' ? 1 : -1;
      const loss = Math.min(1000, Math.max(0, (before.cp - after.cp) * sign));
      let quality = classifyLoss(loss);
      const reply = samples[index + 1];
      if (reply && isBrilliantSacrifice({ loss, legalChoices: sample.legalChoices, pieceValue: reply.played.captured ? values[reply.played.captured] : 0,
        replyTakesPiece: !!reply.played.captured,
        materialBefore: sample.beforeMaterial, materialAfterReply: reply.afterMaterial,
        beforeCp: before.cp, replyCp: reply.after.cp, side: played.color })) quality = 'brilliant';
      else if (loss <= 50 && isBookMove(history, index + 1)) quality = 'book';
      else if (quality === 'best' && before.bestMove === record.uci && sample.legalChoices > 1) {
        const alternatives = new Chess(sample.beforeFen).moves({ verbose: true }).map(move => `${move.from}${move.to}${move.promotion || ''}`).filter(move => move !== record.uci);
        const alternative = await engine.evaluate(sample.beforeFen, alternatives);
        if (isGreatMove(loss, before.cp, alternative.cp, played.color)) quality = 'great';
      }
      moves.push({ ply: index + 1, san: record.san, evaluation: after.cp / 100, mate: after.mate, loss: Math.round(loss), accuracy: Math.round(100 * Math.exp(-loss / 150)), quality, bestMove: before.bestMove });
    }
    const accuracy = Object.fromEntries((['w', 'b'] as Side[]).map(side => {
      const scores = moves.filter(move => (move.ply % 2 === 1 ? 'w' : 'b') === side);
      return [side, scores.length ? Math.round(scores.reduce((total, move) => total + move.accuracy, 0) / scores.length) : null];
    })) as AnalysisReport['accuracy'];
    return { version: 2, engine: 'Stockfish 19 Lite · 30k nodes / position', depth: 12, createdAt: Date.now(), moves, accuracy, methodology: 'До глубины 12 или 30 000 узлов на позицию. Потеря оценки в сантипешках: ≤15 лучший, ≤50 хороший, ≤250 неточность (?), >250 зевок (??). Точность = среднее 100·exp(−потеря/150). Книжка — совпадение с одним из 10 явных дебютных продолжений и потеря ≤50 cp. «!» — лучший ход с потерей ≤15 cp: лучший другой ход отдельно проверяется Stockfish, уступает ≥150 cp и оставляет оценку <+100 cp со стороны игрока; оценка выбранного ≥−100 cp. «!!» — не вынужденная жертва фигуры: после фактического взятия потеря материала ≥2 пешек, потеря оценки исходного хода ≤20 cp, после взятия оценка ≥−100 cp и снижение относительно начала ≤75 cp. Это ограниченные по глубине критерии DeepMove, не классификация Chess.com.' };
  } finally { engine.close(); }
}
let running: Promise<AnalysisReport> | null = null;
let runningId: string | null = null;
export async function requestAnalysis(id: string): Promise<AnalysisReport> {
  const game = loadGame(id);
  ensure(game.status === 'finished', 409, 'Во время игры подсказки и анализ недоступны');
  if (game.analysis?.version === 2) return game.analysis;
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
