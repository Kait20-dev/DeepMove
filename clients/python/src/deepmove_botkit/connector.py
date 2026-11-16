"""A portable example connector for DeepMove's public HTTP protocol.

No imports from the arena repository. The algorithm is supplied as a callback.
"""
from __future__ import annotations

import json
import math
import time
import uuid
from dataclasses import dataclass
from typing import Callable
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

import chess


class ProtocolError(Exception):
    """State or connection does not match the documented protocol."""


class ArenaError(Exception):
    def __init__(self, status: int, message: str, code: str = '', retry_after: float = 1.0):
        super().__init__(message)
        self.status, self.code, self.retry_after = status, code, retry_after


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ProtocolError("Redirect refused: use the arena's final HTTPS origin")


@dataclass(frozen=True)
class Turn:
    state: dict
    board: chess.Board
    deadline: float
    clock: Callable[[], float] = time.monotonic

    @property
    def seconds_left(self) -> float:
        """Monotonic budget, already reduced by RTT and transport reserve."""
        return max(0.0, self.deadline - self.clock())


def board_from_state(state: dict) -> chess.Board:
    """Rebuild full history: FEN alone cannot represent threefold repetition."""
    try:
        board = chess.Board()
        for record in state['moves']:
            uci = record['uci']
            if not isinstance(uci, str) or len(uci) not in (4, 5):
                raise ValueError('Invalid UCI')
            move = chess.Move.from_uci(uci)
            if move not in board.legal_moves:
                raise ValueError('Illegal history')
            board.push(move)
        expected = chess.Board(state['fen'])
        if not expected.is_valid() or board.fen(en_passant='legal') != expected.fen(en_passant='legal'):
            raise ValueError('FEN/history mismatch')
        if state['turn'] != ('w' if board.turn else 'b'):
            raise ValueError('Turn mismatch')
        if state['status'] == 'playing':
            legal = state['legalMoves']
            if not isinstance(legal, list) or set(legal) != {move.uci() for move in board.legal_moves}:
                raise ValueError('Legal-move list mismatch')
        return board
    except (KeyError, TypeError, ValueError) as error:
        raise ProtocolError('Invalid arena position/history: ' + str(error)) from None


class ArenaClient:
    def __init__(self, url: str, game: str, token: str, side: str, *, reserve: float = 0.3,
                 poll: float = 0.2, clock: Callable[[], float] = time.monotonic):
        parts = urlsplit(url)
        if (parts.scheme not in ('http', 'https') or not parts.hostname or parts.username
                or parts.password or parts.path not in ('', '/') or parts.query or parts.fragment):
            raise ValueError('Use an HTTP(S) origin without path, userinfo, query or fragment')
        if parts.scheme != 'https' and parts.hostname not in ('localhost', '127.0.0.1', '::1'):
            raise ValueError('Remote connections require HTTPS')
        try:
            uuid.UUID(game)
        except (ValueError, AttributeError):
            raise ValueError('Game must be a UUID') from None
        if side not in ('w', 'b') or not token or any(char.isspace() for char in token):
            raise ValueError('Choose w/b and provide a nonempty token without whitespace')
        if not math.isfinite(reserve) or not 0.1 <= reserve <= 2:
            raise ValueError('Transport reserve must be 0.1..2 seconds')
        if not math.isfinite(poll) or not 0.1 <= poll <= 2:
            raise ValueError('Poll interval must be 0.1..2 seconds')
        self.base = url.rstrip('/') + '/api/arena/games/' + game
        self.side, self._token, self.reserve, self.poll = side, token, reserve, poll
        self.clock = clock
        self._opener = build_opener(NoRedirects())

    def request(self, action: str = '', payload: dict | None = None) -> dict:
        if action not in ('', 'ready', 'move', 'resign'):
            raise ValueError('Unsupported bot action')
        headers = {'Accept': 'application/json'}
        if payload is not None:
            headers.update({'Content-Type': 'application/json', 'Authorization': 'Bearer ' + self._token})
        request = Request(self.base + ('/' + action if action else ''), headers=headers,
                          data=json.dumps(payload).encode() if payload is not None else None)
        try:
            with self._opener.open(request, timeout=5) as response:
                data = response.read(4_000_001)
                if len(data) > 4_000_000:
                    raise ProtocolError('Arena response exceeds 4 MB')
                result = json.loads(data)
                if not isinstance(result, dict):
                    raise ProtocolError('Expected a JSON object')
                return result
        except HTTPError as error:
            try:
                detail = json.loads(error.read(65536))
                message, code = detail.get('error', 'Arena request failed'), detail.get('code', '')
            except (ValueError, AttributeError):
                message, code = 'Arena request failed', ''
            try:
                retry = float(error.headers.get('Retry-After', '1'))
                if not math.isfinite(retry):
                    retry = 1.0
            except ValueError:
                retry = 1.0
            raise ArenaError(error.code, str(message), str(code), retry) from None
        except (ValueError, UnicodeDecodeError):
            raise ProtocolError('Arena returned malformed JSON') from None

    def play(self, choose_move: Callable[[Turn], str], on_update: Callable[[dict], None] | None = None,
             on_warning: Callable[[str], None] | None = None) -> dict:
        last_version = -1
        while True:
            try:
                sent = self.clock()
                state = self.request()
                received = self.clock()
                seat = state.get('seats', {}).get(self.side, {})
                if seat.get('kind') != 'bot' or not seat.get('userId'):
                    raise ProtocolError('Selected side is not an occupied bot seat')
                if on_update and state.get('version') != last_version:
                    on_update(state)
                    last_version = state.get('version')
                if state['status'] == 'finished':
                    return state
                if state['status'] == 'waiting' and not seat['ready']:
                    ready = self.request('ready', {})
                    if not ready['seats'][self.side]['ready']:
                        raise ProtocolError('Token belongs to the other side; check --side')
                    continue
                if state['status'] not in ('waiting', 'playing'):
                    raise ProtocolError('Unknown game status')
                if state['status'] == 'playing' and state['turn'] == self.side:
                    try:
                        server_left = (state['deadline'] - state['serverNow']) / 1000
                        if not math.isfinite(server_left):
                            raise ValueError('Nonfinite deadline')
                    except (KeyError, TypeError, ValueError):
                        raise ProtocolError('Invalid server clock') from None
                    # Deduct a full observed RTT, conservatively covering response transit.
                    deadline = received + server_left - (received - sent) - self.reserve
                    board = board_from_state(state)
                    turn = Turn(state, board, deadline, self.clock)
                    if turn.seconds_left <= 0:
                        time.sleep(min(self.poll, 0.1))
                        continue
                    move = choose_move(turn)
                    if move not in state['legalMoves']:
                        raise ProtocolError('Algorithm returned an illegal UCI move')
                    # Deliberately do not mutate local history until the server confirms it.
                    self.request('move', {'move': move, 'expectedPly': len(state['moves'])})
                    continue
                time.sleep(self.poll)
            except ArenaError as error:
                if error.status == 429:
                    if on_warning:
                        on_warning('Rate limit: server clocks continue during backoff')
                    time.sleep(min(60, max(self.poll, error.retry_after)))
                elif error.status == 409:
                    # Includes an ambiguous move acceptance: always GET before retrying.
                    time.sleep(self.poll)
                elif error.status >= 500:
                    if on_warning:
                        on_warning('Temporary server error; re-reading authoritative state')
                    time.sleep(0.5)
                else:
                    raise
            except (URLError, TimeoutError, ConnectionError, OSError):
                if on_warning:
                    on_warning('Connection lost; re-reading before any further move')
                time.sleep(self.poll)
