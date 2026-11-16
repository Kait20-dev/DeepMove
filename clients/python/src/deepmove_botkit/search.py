"""Iterative-deepening negamax, alpha-beta, quiescence and bounded randomness."""
from __future__ import annotations

import math
import random
import time
from collections import Counter
from dataclasses import dataclass
from typing import Callable

import chess

from .evaluation import MG_PST, MG_VALUE, evaluate

MATE = 30_000
MATE_THRESHOLD = 29_000
INFINITY = 32_000
MAX_PLY = 64
PositionKey = tuple[int, ...]
TTKey = tuple[PositionKey, int, frozenset[tuple[PositionKey, int]]]


def position_key(board: chess.Board) -> PositionKey:
    """Exact public bitboards, with legally relevant en-passant rights.

    No probabilistic Zobrist collision and no private python-chess API.
    Halfmove clock and reversible history are added separately in TTKey.
    """
    ep = board.ep_square if board.ep_square is not None and board.has_legal_en_passant() else -1
    return (board.pawns, board.knights, board.bishops, board.rooks, board.queens,
            board.kings, board.occupied_co[chess.WHITE], board.occupied_co[chess.BLACK],
            int(board.turn), board.clean_castling_rights(), ep)


@dataclass(frozen=True)
class SearchConfig:
    max_depth: int = 8
    quiescence_depth: int = 8
    noise_cp: int = 20
    temperature_cp: float = 8.0
    max_candidates: int = 3
    tt_capacity: int = 15_000
    max_nodes: int | None = None

    def __post_init__(self):
        if not 1 <= self.max_depth <= 32 or not 0 <= self.quiescence_depth <= 16:
            raise ValueError("Depth must be 1..32; quiescence depth 0..16")
        if not 0 <= self.noise_cp <= 100 or not math.isfinite(self.temperature_cp) or self.temperature_cp <= 0:
            raise ValueError("Noise must be 0..100 cp; temperature must be finite and positive")
        if not 1 <= self.max_candidates <= 20 or not 0 <= self.tt_capacity <= 100_000:
            raise ValueError("Candidates must be 1..20; TT capacity 0..100000")
        if self.max_nodes is not None and self.max_nodes < 1:
            raise ValueError("max_nodes must be positive")


@dataclass(frozen=True)
class RootScore:
    move: chess.Move
    score: int
    pv: tuple[chess.Move, ...]


@dataclass(frozen=True)
class SearchResult:
    move: chess.Move | None
    score_cp: int
    best_score_cp: int
    depth: int
    nodes: int
    elapsed_seconds: float
    pv: tuple[chess.Move, ...]
    candidates: tuple[RootScore, ...]
    stopped_early: bool


@dataclass(frozen=True)
class TTEntry:
    depth: int
    score: int
    bound: str
    move: chess.Move | None


class SearchStopped(Exception):
    """Internal unwind: push/pop must always be paired with try/finally."""


def select_candidate(scores: list[RootScore], config: SearchConfig, rng: random.Random) -> RootScore:
    if not scores:
        raise ValueError("No scored moves")
    ordered = sorted(scores, key=lambda result: (-result.score, result.move.uci()))
    best = ordered[0]
    # Never randomize a forced mate score or a failed/partial iteration.
    if config.noise_cp == 0 or abs(best.score) >= MATE_THRESHOLD:
        return best
    pool = [result for result in ordered if result.score >= best.score - config.noise_cp][:config.max_candidates]
    weights = [math.exp((result.score - best.score) / config.temperature_cp) for result in pool]
    return rng.choices(pool, weights=weights, k=1)[0]


class Engine:
    def __init__(self, config: SearchConfig | None = None, seed: int | None = None,
                 clock: Callable[[], float] = time.monotonic,
                 evaluator: Callable[[chess.Board], int] = evaluate):
        self.config = config or SearchConfig()
        self.rng = random.Random(seed)
        self.clock = clock
        self.evaluate = evaluator
        self.nodes = 0
        self._board = chess.Board()
        self._counts: Counter[PositionKey] = Counter()
        self._tt: dict[TTKey, TTEntry] = {}
        self._ordering: dict[PositionKey, chess.Move] = {}
        self._killers: dict[int, list[chess.Move]] = {}
        self._history: dict[tuple[bool, int, int], int] = {}
        self._pv: dict[int, list[chess.Move]] = {}
        self._deadline = 0.0

    def search(self, board: chess.Board, seconds: float) -> SearchResult:
        if not math.isfinite(seconds) or seconds < 0:
            raise ValueError("Search time must be finite and nonnegative")
        if not board.is_valid() or board.chess960:
            raise ValueError("A valid standard-chess position is required")
        started = self.clock()
        self._deadline = started + seconds
        self._board = board.copy(stack=True)
        self._tt.clear()
        self._ordering.clear()
        self._killers.clear()
        self._history.clear()
        self._pv.clear()
        self.nodes = 0
        self._counts = self._initial_counts(self._board)
        legal = list(self._board.legal_moves)
        if not legal or self._draw():
            score = -MATE if not legal and self._board.is_check() else 0
            return SearchResult(None, score, score, 0, 0, self.clock() - started, (), (), False)
        # A legal fallback exists before any deep search; no unfinished scores are sampled.
        fallback = self._ordered(legal, None, 0)[0]
        completed: list[RootScore] = []
        depth = 0
        interrupted = False
        root_order = legal
        for target_depth in range(1, self.config.max_depth + 1):
            try:
                self._check_time()
                iteration: list[RootScore] = []
                # Full windows intentionally make root scores comparable for sampling.
                # Alpha-beta still prunes inside every root subtree.
                for move in root_order:
                    self._check_time()
                    self._push(move)
                    try:
                        score = -self._negamax(target_depth - 1, -INFINITY, INFINITY, 1)
                        pv = (move, *self._pv.get(1, []))
                    finally:
                        self._pop()
                    iteration.append(RootScore(move, score, pv))
                completed = sorted(iteration, key=lambda item: (-item.score, item.move.uci()))
                root_order = [item.move for item in completed]
                depth = target_depth
                if completed[0].score >= MATE_THRESHOLD:
                    break
            except SearchStopped:
                interrupted = True
                break
        if completed:
            chosen = select_candidate(completed, self.config, self.rng)
            best = completed[0].score
            pool = tuple(item for item in completed if item.score >= best - self.config.noise_cp)[:self.config.max_candidates]
        else:
            chosen = RootScore(fallback, self.evaluate(self._board), (fallback,))
            best, pool = chosen.score, ()
        return SearchResult(chosen.move, chosen.score, best, depth, self.nodes,
                            self.clock() - started, chosen.pv, pool, interrupted)

    @staticmethod
    def _initial_counts(board: chess.Board) -> Counter[PositionKey]:
        replay = board.root()
        counts = Counter({position_key(replay): 1})
        for move in board.move_stack:
            if replay.is_irreversible(move):
                counts.clear()
            replay.push(move)
            counts[position_key(replay)] += 1
        return counts

    def _check_time(self):
        if self.clock() >= self._deadline or self.config.max_nodes is not None and self.nodes >= self.config.max_nodes:
            raise SearchStopped

    def _visit(self):
        self.nodes += 1
        if self.nodes % 16 == 0 or self.config.max_nodes is not None and self.nodes >= self.config.max_nodes:
            self._check_time()

    def _push(self, move: chess.Move):
        self._board.push(move)
        self._counts[position_key(self._board)] += 1

    def _pop(self):
        key = position_key(self._board)
        self._counts[key] -= 1
        if not self._counts[key]:
            del self._counts[key]
        self._board.pop()

    def _draw(self) -> bool:
        return (self._board.halfmove_clock >= 100 or self._board.is_insufficient_material()
                or self._counts[position_key(self._board)] >= 3)

    def _negamax(self, depth: int, alpha: int, beta: int, ply: int) -> int:
        self._pv[ply] = []
        if depth <= 0:
            return self._quiescence(alpha, beta, ply, 0)
        self._visit()
        board = self._board
        legal = list(board.legal_moves)
        if not legal:
            return -MATE + ply if board.is_check() else 0
        if self._draw():
            return 0
        if ply >= MAX_PLY:
            return self.evaluate(board)
        key: TTKey = (position_key(board), board.halfmove_clock, frozenset(self._counts.items()))
        entry = self._tt.get(key)
        original_alpha = alpha
        if entry and entry.depth >= depth:
            score = self._from_tt(entry.score, ply)
            if entry.bound == 'exact' or entry.bound == 'lower' and score >= beta or entry.bound == 'upper' and score <= alpha:
                return score
        preferred = entry.move if entry else self._ordering.get(key[0])
        best_score, best_move = -INFINITY, None
        for move in self._ordered(legal, preferred, ply):
            quiet = not board.is_capture(move) and not move.promotion
            self._push(move)
            try:
                score = -self._negamax(depth - 1, -beta, -alpha, ply + 1)
            finally:
                self._pop()
            if score > best_score:
                best_score, best_move = score, move
                self._pv[ply] = [move, *self._pv.get(ply + 1, [])]
            alpha = max(alpha, score)
            if alpha >= beta:
                if quiet:
                    killers = self._killers.setdefault(ply, [])
                    if move not in killers:
                        killers.insert(0, move)
                        del killers[2:]
                    history_key = (board.turn, move.from_square, move.to_square)
                    self._history[history_key] = min(10_000, self._history.get(history_key, 0) + depth * depth)
                break
        bound = 'upper' if best_score <= original_alpha else 'lower' if best_score >= beta else 'exact'
        if len(self._tt) < self.config.tt_capacity or key in self._tt:
            self._tt[key] = TTEntry(depth, self._to_tt(best_score, ply), bound, best_move)
        if best_move:
            self._ordering[key[0]] = best_move
        return best_score

    def _quiescence(self, alpha: int, beta: int, ply: int, qdepth: int) -> int:
        self._visit()
        board = self._board
        legal = list(board.legal_moves)
        in_check = board.is_check()
        if not legal:
            return -MATE + ply if in_check else 0
        if self._draw():
            return 0
        if ply >= MAX_PLY:
            return self.evaluate(board)
        if not in_check:
            stand_pat = self.evaluate(board)
            if stand_pat >= beta:
                return stand_pat
            alpha = max(alpha, stand_pat)
            if qdepth >= self.config.quiescence_depth:
                return alpha
            legal = [move for move in legal if board.is_capture(move) or move.promotion]
        # In check, stand-pat is illegal: search every evasion, including quiet ones.
        for move in self._ordered(legal, None, ply):
            self._push(move)
            try:
                score = -self._quiescence(-beta, -alpha, ply + 1, qdepth + 1)
            finally:
                self._pop()
            if score >= beta:
                return score
            alpha = max(alpha, score)
        return alpha

    def _ordered(self, moves: list[chess.Move], preferred: chess.Move | None, ply: int) -> list[chess.Move]:
        board = self._board
        def priority(move: chess.Move) -> int:
            if move == preferred:
                return 1_000_000
            piece = board.piece_type_at(move.from_square) or chess.PAWN
            score = 0
            if board.is_capture(move):
                victim = chess.PAWN if board.is_en_passant(move) else board.piece_type_at(move.to_square) or 0
                score += 100_000 + 16 * MG_VALUE[victim] - MG_VALUE[piece]
            if move.promotion:
                score += 150_000 + MG_VALUE[move.promotion]
            if move in self._killers.get(ply, []):
                score += 20_000
            score += self._history.get((board.turn, move.from_square, move.to_square), 0)
            start = move.from_square if board.turn else chess.square_mirror(move.from_square)
            end = move.to_square if board.turn else chess.square_mirror(move.to_square)
            return score + MG_PST[piece][end] - MG_PST[piece][start]
        return sorted(moves, key=lambda move: (-priority(move), move.uci()))

    @staticmethod
    def _to_tt(score: int, ply: int) -> int:
        return score + ply if score >= MATE_THRESHOLD else score - ply if score <= -MATE_THRESHOLD else score

    @staticmethod
    def _from_tt(score: int, ply: int) -> int:
        return score - ply if score >= MATE_THRESHOLD else score + ply if score <= -MATE_THRESHOLD else score
