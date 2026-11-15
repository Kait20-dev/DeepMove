"""Local, explicitly bounded matches against simple baselines; no Elo claims."""
from __future__ import annotations

import datetime
import random
import time
from pathlib import Path

import chess
import chess.pgn

from .evaluation import evaluate
from .search import Engine, SearchConfig


def baseline_move(board: chess.Board, rng: random.Random, greedy: bool) -> chess.Move:
    legal = list(board.legal_moves)
    if not greedy:
        return rng.choice(legal)
    scored = []
    for move in legal:
        board.push(move)
        try:
            score = 30000 if board.is_checkmate() else 0 if board.is_stalemate() else -evaluate(board)
        finally:
            board.pop()
        scored.append((score, move))
    best = max(score for score, _ in scored)
    return rng.choice([move for score, move in scored if score == best])


def benchmark(games: int, seconds: float, max_plies: int, seed: int, opponent: str,
              output: Path | None = None) -> dict:
    rng = random.Random(seed)
    totals = dict(wins=0, losses=0, draws=0, unfinished=0)
    depths, times, nodes, pgns = [], [], [], []
    started = time.monotonic()
    for index in range(games):
        board = chess.Board()
        color = index % 2 == 0
        engine = Engine(SearchConfig(max_depth=6), seed + index)
        record = chess.pgn.Game()
        record.headers.update(Event='DeepMoveBot local benchmark',
                              Date=datetime.datetime.now(datetime.timezone.utc).strftime('%Y.%m.%d'),
                              White='DeepMoveBot' if color else opponent,
                              Black=opponent if color else 'DeepMoveBot')
        node = record
        result = '*'
        for _ in range(max_plies):
            if board.is_checkmate():
                result = '0-1' if board.turn else '1-0'
                break
            if board.is_stalemate() or board.is_insufficient_material() or board.is_fifty_moves() or board.is_repetition(3):
                result = '1/2-1/2'
                break
            if board.turn == color:
                search = engine.search(board, seconds)
                move = search.move
                depths.append(search.depth)
                times.append(search.elapsed_seconds)
                nodes.append(search.nodes)
            else:
                move = baseline_move(board, rng, opponent == 'greedy')
            if move is None or move not in board.legal_moves:
                raise RuntimeError('A benchmark participant returned an illegal move')
            board.push(move)
            node = node.add_variation(move)
        # Adjudicate a terminal position reached on the last permitted ply too.
        if board.is_checkmate():
            result = '0-1' if board.turn else '1-0'
        elif board.is_stalemate() or board.is_insufficient_material() or board.is_fifty_moves() or board.is_repetition(3):
            result = '1/2-1/2'
        record.headers['Result'] = result
        record.headers['Termination'] = 'ply limit (unfinished)' if result == '*' else 'normal'
        if result == '*':
            totals['unfinished'] += 1
        elif result == '1/2-1/2':
            totals['draws'] += 1
        elif (result == '1-0') == color:
            totals['wins'] += 1
        else:
            totals['losses'] += 1
        pgns.append(str(record))
    if output:
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text('\n\n'.join(pgns) + '\n', encoding='utf-8')
    return {
        'opponent': opponent, 'games': games, 'seed': seed, 'budget_seconds': seconds,
        'max_plies': max_plies, **totals, 'engine_moves': len(depths),
        'average_completed_depth': round(sum(depths) / max(1, len(depths)), 2),
        'average_move_ms': round(1000 * sum(times) / max(1, len(times)), 1),
        'max_move_ms': round(1000 * max(times, default=0), 1),
        'nodes': sum(nodes), 'wall_seconds': round(time.monotonic() - started, 2),
        'pgn': str(output) if output else None,
        'note': 'Local baseline matches, not an Elo estimate. Ply-limited games stay unfinished.',
    }
