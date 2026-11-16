"""21 -> 12 -> 1 tanh residual network. No external ML runtime."""
from __future__ import annotations

import math
import random
from dataclasses import dataclass
from pathlib import Path

import chess
from deepmove_botkit.learning import FEATURE_NAMES, FEATURE_VERSION, baseline_white, checked_vector, features, read_json

INPUTS = len(FEATURE_NAMES)
HIDDEN = 12
GENES = HIDDEN * (INPUTS + 1) + HIDDEN + 1


@dataclass
class Genome:
    id: str
    weights: list[float]
    parents: tuple[str, ...] = ()

    @classmethod
    def random(cls, identifier: str, rng: random.Random):
        return cls(identifier, [rng.gauss(0, 0.15) for _ in range(GENES)])

    def dump(self) -> dict:
        return {'id': self.id, 'weights': self.weights, 'parents': list(self.parents)}

    @classmethod
    def load(cls, data: dict):
        if not isinstance(data, dict) or not isinstance(data.get('id'), str):
            raise ValueError('Invalid genome')
        parents = data.get('parents', [])
        if not isinstance(parents, list) or any(not isinstance(value, str) for value in parents):
            raise ValueError('Invalid lineage')
        return cls(data['id'], checked_vector(data.get('weights'), GENES), tuple(parents))

    def evaluate(self, board: chess.Board) -> int:
        x = features(board)
        hidden = []
        for index in range(HIDDEN):
            offset = index * (INPUTS + 1)
            hidden.append(math.tanh(sum(self.weights[offset + j] * x[j] for j in range(INPUTS))
                                    + self.weights[offset + INPUTS]))
        offset = HIDDEN * (INPUTS + 1)
        residual = math.tanh(sum(self.weights[offset + j] * hidden[j] for j in range(HIDDEN)) + self.weights[-1])
        white_cp = max(-20_000, min(20_000, baseline_white(board) + round(250 * residual)))
        return white_cp if board.turn else -white_cp


def load_model(path: Path) -> Genome:
    data = read_json(path)
    if (data.get('type') != 'deepneuro' or data.get('version') != 1
            or data.get('feature_version') != FEATURE_VERSION):
        raise ValueError('Unsupported DeepNeuro model/feature version')
    return Genome.load(data['genome'])
