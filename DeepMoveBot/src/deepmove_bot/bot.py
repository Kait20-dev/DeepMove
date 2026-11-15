"""Adapter between independent search and independent transport."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from .connector import Turn, ProtocolError
from .search import Engine, SearchResult


@dataclass(frozen=True)
class TimePolicy:
    max_think: float = 1.8

    def allocate(self, turn: Turn) -> float:
        side = 'w' if turn.board.turn else 'b'
        state = turn.state
        total = max(0.0, (state['clocks'][side] - (state['serverNow'] - state['turnStartedAt'])) / 1000)
        increment = state['format']['incrementMs'] / 1000
        # Spend about 1/35 of remaining total time plus half the increment.
        target = max(0.02, total / 35 + increment / 2)
        return max(0.0, min(self.max_think, target, turn.seconds_left * 0.9))


class DeepMoveBot:
    def __init__(self, engine: Engine | None = None, policy: TimePolicy | None = None,
                 on_search: Callable[[SearchResult], None] | None = None):
        self.engine = engine or Engine()
        self.policy = policy or TimePolicy()
        self.on_search = on_search

    def choose_move(self, turn: Turn) -> str:
        result = self.engine.search(turn.board, self.policy.allocate(turn))
        if result.move is None:
            raise ProtocolError('The server requested a move in a terminal position')
        if self.on_search:
            self.on_search(result)
        return result.move.uci()
