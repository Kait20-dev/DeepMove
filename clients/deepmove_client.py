"""DeepMove HTTP client. Python 3.10+, standard library only.

The algorithm runs on the participant's machine; the arena accepts only UCI moves.
"""
from __future__ import annotations

import json
import time
from collections.abc import Callable
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen


class ArenaError(Exception):
    def __init__(self, status: int, message: str, code: str = "", retry_after: float = 1):
        super().__init__(message)
        self.status = status
        self.code = code
        self.retry_after = retry_after


class DeepMoveClient:
    def __init__(self, url: str, game_id: str, token: str, side: str):
        parts = urlsplit(url)
        if parts.scheme not in ("http", "https") or not parts.hostname or parts.username or parts.password:
            raise ValueError("Use an HTTP(S) origin without userinfo")
        if parts.scheme != "https" and parts.hostname not in ("localhost", "127.0.0.1", "::1"):
            raise ValueError("Remote connections require HTTPS to protect the bot token")
        if parts.path not in ("", "/") or parts.query or parts.fragment:
            raise ValueError("URL must be an origin without path, query or fragment")
        if side not in ("w", "b"):
            raise ValueError("side must be w or b")
        if not game_id or any(c not in "abcdef0123456789-" for c in game_id):
            raise ValueError("Invalid game UUID")
        self.base = url.rstrip("/") + "/api/arena/games/" + game_id
        self._token = token
        self.side = side

    def _request(self, action: str = "", data: dict | None = None) -> dict:
        headers = {"Accept": "application/json"}
        if data is not None:
            headers.update({"Content-Type": "application/json", "Authorization": "Bearer " + self._token})
        request = Request(self.base + ("/" + action if action else ""),
                          data=json.dumps(data).encode() if data is not None else None, headers=headers)
        try:
            with urlopen(request, timeout=5) as response:
                return json.load(response)
        except HTTPError as error:
            try:
                detail = json.load(error)
            except (ValueError, UnicodeDecodeError):
                detail = {"error": "HTTP request failed"}
            raise ArenaError(error.code, detail.get("error", "Request failed"), detail.get("code", ""),
                             float(error.headers.get("Retry-After", "1"))) from None

    def state(self) -> dict:
        return self._request()

    def ready(self) -> dict:
        return self._request("ready", {})

    def move(self, uci: str, expected_ply: int) -> dict:
        return self._request("move", {"move": uci, "expectedPly": expected_ply})

    def resign(self) -> dict:
        return self._request("resign", {})

    def play(self, choose_move: Callable[[dict, float], str], on_update: Callable[[dict], None] | None = None) -> dict:
        """choose_move(state, budget_seconds) -> UCI, e.g. e2e4 or a7a8q.

        budget_seconds reserves 200ms for transport. The callback must enforce its
        own time limit. After an ambiguous network error, re-read before retrying.
        """
        last_version = -1
        while True:
            try:
                state = self.state()
                seat = state["seats"][self.side]
                if seat["kind"] != "bot" or not seat["userId"]:
                    raise ValueError("This seat is not an occupied bot seat")
                if on_update and state["version"] != last_version:
                    on_update(state)
                    last_version = state["version"]
                if state["status"] == "finished":
                    return state
                if state["status"] == "waiting" and not seat["ready"]:
                    confirmed = self.ready()
                    if not confirmed["seats"][self.side]["ready"]:
                        raise ValueError("The token belongs to the other side; check --side")
                    continue
                if state["status"] == "playing" and state["turn"] == self.side:
                    budget = max(0, (state["deadline"] - state["serverNow"]) / 1000 - 0.2)
                    if budget > 0:
                        move = choose_move(state, budget)
                        if move not in state["legalMoves"]:
                            raise ValueError("Algorithm returned a move outside legalMoves: " + str(move))
                        self.move(move, len(state["moves"]))
                        continue
                time.sleep(0.2)
            except ArenaError as error:
                if error.status in (401, 403, 404, 422):
                    raise
                if error.status == 429:
                    time.sleep(min(60, max(0.2, error.retry_after)))
                elif error.status == 409:
                    time.sleep(0.1)
                elif error.status >= 500:
                    time.sleep(0.5)
                else:
                    raise
            except (URLError, TimeoutError, ConnectionError):
                time.sleep(0.2)
