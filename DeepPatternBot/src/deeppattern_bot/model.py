"""Streaming supervised logistic regression over a handcrafted value baseline."""
from __future__ import annotations

import hashlib
import json
import math
import time
from dataclasses import dataclass, field
from pathlib import Path

import chess
from deepmove_botkit.learning import FEATURE_NAMES, FEATURE_VERSION, atomic_json, baseline_white, checked_vector, features, read_json

from .index import connect


def probability(baseline: float, vector: list[float], weights: list[float]) -> float:
    logit = max(-20, min(20, baseline / 400 + sum(x * weight for x, weight in zip(vector, weights))))
    return 1 / (1 + math.exp(-logit))


@dataclass
class Model:
    weights: list[float] = field(default_factory=lambda: [0.0] * len(FEATURE_NAMES))

    def evaluate(self, board: chess.Board) -> int:
        white_cp = max(-20_000, min(20_000, baseline_white(board) + round(400 * sum(x * w for x, w in zip(features(board), self.weights)))))
        return white_cp if board.turn else -white_cp

    @classmethod
    def load(cls, path: Path):
        data = read_json(path)
        if data.get('type') != 'deeppattern' or data.get('version') != 1 or data.get('feature_version') != FEATURE_VERSION:
            raise ValueError('Unsupported DeepPattern model/feature version')
        return cls(checked_vector(data.get('weights'), len(FEATURE_NAMES)))


def corpus_signature(connection) -> str:
    digest = hashlib.sha256()
    for row in connection.execute('SELECT id,result,split FROM games ORDER BY id'):
        digest.update(('|'.join(row) + '\n').encode())
    return digest.hexdigest()


def validation(connection, weights, limit: int = 10_000):
    count = 0
    loss = baseline_loss = 0.0
    for row in connection.execute('''SELECT samples.* FROM samples JOIN games ON games.id=samples.game_id
            WHERE games.split='validation' ORDER BY game_id,ply LIMIT ?''', (limit,)):
        vector = json.loads(row['features'])
        target = row['target']
        p = probability(row['baseline'], vector, weights)
        base = probability(row['baseline'], vector, [0.0] * len(weights))
        loss += -target * math.log(p) - (1 - target) * math.log(1 - p)
        baseline_loss += -target * math.log(base) - (1 - target) * math.log(1 - base)
        count += 1
    return {'positions': count, 'cross_entropy': loss / count if count else None,
            'baseline_cross_entropy': baseline_loss / count if count else None,
            'note': 'No validation games yet' if not count else 'Game-level holdout; first 10000 positions maximum'}


def train(database: Path, path: Path, *, epochs: int = 1, max_samples: int = 100_000,
          max_seconds: float = 60, learning_rate: float = 0.03, l2: float = 0.001):
    if (not 1 <= epochs <= 1000 or not 1 <= max_samples <= 100_000_000 or not 0 < max_seconds <= 86400
            or not math.isfinite(learning_rate) or not 0 < learning_rate <= 1
            or not math.isfinite(l2) or not 0 <= l2 <= 1):
        raise ValueError('Invalid bounded training limits/rate/regularization')
    started = time.monotonic()
    connection = connect(database, readonly=True)
    try:
        signature = corpus_signature(connection)
        if not connection.execute("SELECT 1 FROM games WHERE split='train' LIMIT 1").fetchone():
            raise ValueError('No training games: import PGN first')
        if path.exists():
            model = Model.load(path)
            state = read_json(path)
            if state['corpus'] != signature:
                raise ValueError('Corpus changed: choose a new model path for a fresh reproducible run')
            if state['learning_rate'] != learning_rate or state['l2'] != l2:
                raise ValueError('Resume requires the original learning rate and regularization')
        else:
            model = Model()
            state = {'type': 'deeppattern', 'version': 1, 'feature_version': FEATURE_VERSION,
                     'corpus': signature, 'epoch': 0, 'cursor': ['', -1], 'updates': 0,
                     'learning_rate': learning_rate, 'l2': l2, 'weights': model.weights, 'trained': False}
        target_epoch = state['epoch'] + epochs
        count = 0
        while state['epoch'] < target_epoch and count < max_samples and time.monotonic() - started < max_seconds:
            cursor_game, cursor_ply = state['cursor']
            rows = connection.execute('''SELECT samples.* FROM samples JOIN games ON games.id=samples.game_id
                WHERE games.split='train' AND (game_id,ply) > (?,?) ORDER BY game_id,ply''', (cursor_game, cursor_ply))
            exhausted = True
            for row in rows:
                if count >= max_samples or time.monotonic() - started >= max_seconds:
                    exhausted = False
                    break
                vector = json.loads(row['features'])
                p = probability(row['baseline'], vector, model.weights)
                for index, x in enumerate(vector):
                    gradient = (p - row['target']) * x + l2 * model.weights[index]
                    model.weights[index] = max(-3, min(3, model.weights[index] - learning_rate * gradient))
                state['cursor'] = [row['game_id'], row['ply']]
                state['updates'] += 1
                count += 1
                if count % 256 == 0:
                    state.update(weights=model.weights, trained=True)
                    atomic_json(path, state)
            rows.close()
            if exhausted:
                state['epoch'] += 1
                state['cursor'] = ['', -1]
        state.update(weights=model.weights, trained=state['updates'] > 0)
        state['validation'] = validation(connection, model.weights)
        atomic_json(path, state)
        return {'samples_this_run': count, 'updates': state['updates'], 'completed_epochs': state['epoch'],
                'validation': state['validation']}
    finally:
        connection.close()
