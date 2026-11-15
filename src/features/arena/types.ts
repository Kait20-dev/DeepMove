export type Side = 'w' | 'b';
export type PlayerKind = 'human' | 'bot';
export interface TimeFormat { name: string; initialMs: number; incrementMs: number; botMoveMs: number | null; humanMoveMs?: number | null }
export const formats: Record<string, TimeFormat> = {
  arena: { name: 'Арена · 10 мин / бот ≤3 с', initialMs: 600_000, incrementMs: 0, botMoveMs: 3000 },
  hardbullet: { name: 'HardBullet Arena · 15 с / ход ≤1 с', initialMs: 15_000, incrementMs: 0, botMoveMs: 1000, humanMoveMs: 1000 },
  rapid: { name: 'Рапид · 10 мин', initialMs: 600_000, incrementMs: 0, botMoveMs: null },
  blitz: { name: 'Блиц · 3+2', initialMs: 180_000, incrementMs: 2000, botMoveMs: null },
};
export interface Seat { userId: string | null; name: string; kind: PlayerKind; ready: boolean; tokenHash: string | null }
export interface MoveRecord { uci: string; san: string; fen: string; elapsedMs: number; remainingMs: number }
export interface Game {
  id: string; createdAt: number; createdBy: string; joinHash: string;
  status: 'waiting' | 'playing' | 'finished'; result: '*' | '1-0' | '0-1' | '1/2-1/2'; reason: string | null;
  seats: Record<Side, Seat>; format: TimeFormat; moves: MoveRecord[];
  clocks: Record<Side, number>; turnStartedAt: number | null; version: number;
  startDelayMs: number; startsAt: number | null;
  analysis?: AnalysisReport;
}
export interface PublicSeat { userId: string | null; name: string; kind: PlayerKind; ready: boolean }
export interface GameView extends Omit<Game, 'seats' | 'analysis' | 'joinHash'> {
  seats: Record<Side, PublicSeat>; fen: string; turn: Side; legalMoves: string[];
  serverNow: number; deadline: number | null; pgn: string; material: MaterialSummary;
  analysis: AnalysisReport | null;
}
export interface MaterialSummary { white: number; black: number; balance: number; capturedByWhite: string[]; capturedByBlack: string[] }
export type MoveQuality = 'best' | 'good' | 'inaccuracy' | 'mistake' | 'blunder' | 'brilliant-candidate';
export interface MoveAnalysis { ply: number; san: string; evaluation: number; mate: number | null; loss: number; accuracy: number; quality: MoveQuality; bestMove: string | null }
export interface AnalysisReport { engine: string; depth: number; createdAt: number; moves: MoveAnalysis[]; accuracy: Record<Side, number | null>; methodology: string }
export interface UserView { id: string; handle: string; name: string; bio: string; createdAt: number }
export interface TeamView { id: string; name: string; ownerId: string; members: UserView[] }
export interface Dashboard { user: UserView | null; games: GameView[]; teams: TeamView[] }
