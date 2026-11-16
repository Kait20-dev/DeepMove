"""Small shared primitives for the two learning engines; no training on import.

Feature order is a persisted model ABI. Scores and features are white-oriented.
"""
from __future__ import annotations

import getpass
import json
import math
import os
import tempfile
from pathlib import Path

import chess

from .connector import ArenaClient
from .evaluation import evaluate

FEATURE_VERSION = 1
FEATURE_NAMES = tuple(f'{piece}_{feature}' for piece in ('pawn', 'knight', 'bishop', 'rook', 'queen', 'king')
                      for feature in ('count', 'center', 'advance')) + ('bishop_pair', 'pawn_files', 'tempo')


def features(board: chess.Board) -> list[float]:
    result = []
    for kind in chess.PIECE_TYPES:
        count = center = advance = 0
        for color in chess.COLORS:
            sign = 1 if color else -1
            for square in board.pieces(kind, color):
                file, rank = chess.square_file(square), chess.square_rank(square)
                relative_rank = rank if color else 7 - rank
                count += sign
                center += sign * (14 - abs(2 * file - 7) - abs(2 * rank - 7))
                advance += sign * relative_rank
        result.extend((count / 8, center / 112, advance / 56))
    result.extend((float(len(board.pieces(chess.BISHOP, True)) >= 2) - float(len(board.pieces(chess.BISHOP, False)) >= 2),
                   sum(bool(board.pieces_mask(chess.PAWN, True) & mask) - bool(board.pieces_mask(chess.PAWN, False) & mask)
                       for mask in chess.BB_FILES) / 8,
                   1.0 if board.turn else -1.0))
    return result


def baseline_white(board: chess.Board) -> int:
    score = evaluate(board)
    return score if board.turn else -score


def checked_vector(values, length: int) -> list[float]:
    if not isinstance(values, list) or len(values) != length:
        raise ValueError(f'Expected {length} model coefficients')
    if any(type(value) not in (float, int) or not math.isfinite(value) or abs(value) > 10 for value in values):
        raise ValueError('Model coefficients must be finite and within [-10, 10]')
    return [float(value) for value in values]


def read_json(path: Path, limit: int = 32_000_000) -> dict:
    with path.open('rb') as stream:
        raw = stream.read(limit + 1)
    if len(raw) > limit:
        raise ValueError('JSON file exceeds safety limit')
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise ValueError('Expected a JSON object')
    return data


def atomic_json(path: Path, data: dict):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=path.name + '.', suffix='.tmp')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8', newline='\n') as stream:
            json.dump(data, stream, ensure_ascii=False, allow_nan=False, indent=2)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def positive_time(value: str) -> float:
    number = float(value)
    if not math.isfinite(number) or not 0 < number <= 60:
        raise ValueError('Time must be finite and in (0, 60] seconds')
    return number


def add_play_arguments(parser):
    parser.add_argument('--url', default='http://127.0.0.1:3000')
    parser.add_argument('--game', required=True, help='Game UUID')
    parser.add_argument('--side', required=True, choices=('w', 'b'))
    parser.add_argument('--max-think', type=positive_time, default=0.5)
    parser.add_argument('--reserve', type=float, default=0.2)
    parser.add_argument('--poll', type=float, default=0.1)


def play_arena(args, choose):
    # No command-line secrets, redirects or remote plaintext HTTP.
    token = os.environ.get('DEEPMOVE_BOT_TOKEN') or getpass.getpass('Bot token (hidden): ')
    client = ArenaClient(args.url, args.game, token, args.side, reserve=args.reserve, poll=args.poll)
    def callback(turn):
        result = choose(turn.board, min(args.max_think, turn.seconds_left))
        if result.move is None:
            raise ValueError('No legal move in an active arena position')
        print(json.dumps({'move': result.move.uci(), 'depth': result.depth, 'nodes': result.nodes}), flush=True)
        return result.move.uci()
    state = client.play(callback, on_warning=lambda message: print(message, flush=True))
    print(json.dumps({'result': state['result'], 'reason': state['reason']}), flush=True)
