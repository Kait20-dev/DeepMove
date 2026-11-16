"""Use indexed moves only when tactical search considers them near-best."""
from __future__ import annotations

import time
from dataclasses import replace
from pathlib import Path

from deepmove_botkit.search import Engine, SearchConfig

from .index import candidates, connect
from .model import Model


class PatternEngine:
    def __init__(self, database: Path | None = None, model: Model | None = None, *, minimum: int = 3,
                 depth: int = 5, nodes: int = 20_000):
        if not 1 <= minimum <= 1_000_000:
            raise ValueError('Minimum pattern samples must be 1..1000000')
        self.engine = Engine(SearchConfig(max_depth=depth, max_nodes=nodes, noise_cp=80, max_candidates=20),
                             seed=0, evaluator=(model or Model()).evaluate)
        self.connection = connect(database, readonly=True) if database else None
        if self.connection:
            self.connection.execute('PRAGMA busy_timeout=20')
        self.minimum = minimum
        self.last_patterns = []
        self.source = 'search'

    def close(self):
        if self.connection:
            self.connection.close()
            self.connection = None

    def search(self, board, seconds):
        started = time.monotonic()
        self.last_patterns = candidates(self.connection, board, self.minimum) if self.connection else []
        result = self.engine.search(board, max(0, seconds - (time.monotonic() - started)))
        self.source = 'search'
        if not result.candidates:
            return result
        best = max(result.candidates, key=lambda item: item.score)
        selected = best
        allowed = {item.move.uci(): item for item in result.candidates}
        for pattern in self.last_patterns:
            item = allowed.get(pattern['move'])
            # Never replace a searched mate with corpus statistics.
            if item and abs(best.score) < 29_000:
                selected = item
                self.source = 'pattern+search'
                break
        return replace(result, move=selected.move, score_cp=selected.score, pv=selected.pv)
