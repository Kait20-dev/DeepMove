"""Official DeepMove HTTP API v1. No chess library, engine API or cloud service."""
from __future__ import annotations

import http.client
import json
import math
import re
import time
from urllib.parse import urlsplit

from .engine import Engine

UCI = re.compile(r"[a-h][1-8][a-h][1-8][nbrq]?\Z")
UUID = re.compile(r"[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\Z")


class ArenaError(Exception):
    def __init__(self, status: int, code: str, retry: float = 1):
        super().__init__(f"Arena HTTP {status}: {code}")
        self.status, self.code, self.retry = status, code, retry


class Client:
    def __init__(self, origin: str, game: str, token: str, timeout: float = 2):
        parts = urlsplit(origin)
        if parts.scheme not in ("http", "https") or not parts.hostname or parts.username or parts.password:
            raise ValueError("Expected HTTP(S) origin without credentials")
        if parts.path not in ("", "/") or parts.query or parts.fragment:
            raise ValueError("Origin must not contain a path, query or fragment")
        if parts.scheme != "https" and parts.hostname not in ("localhost", "127.0.0.1", "::1"):
            raise ValueError("Remote arenas require HTTPS")
        if not UUID.fullmatch(game) or not token or any(c.isspace() for c in token):
            raise ValueError("Invalid game UUID or token")
        self.path = "/api/arena/games/" + game
        connection = http.client.HTTPSConnection if parts.scheme == "https" else http.client.HTTPConnection
        self.connection = connection(parts.hostname, parts.port, timeout=timeout)
        self._token = token
        self.rtt_ms = 0.0

    def request(self, action: str = "", data: dict | None = None) -> dict:
        headers = {"Accept": "application/json"}
        if data is not None:
            headers.update({"Authorization": "Bearer " + self._token, "Content-Type": "application/json"})
        started = time.perf_counter()
        try:
            self.connection.request("POST" if data is not None else "GET", self.path + ("/" + action if action else ""),
                                    json.dumps(data) if data is not None else None, headers)
            response = self.connection.getresponse()
            raw = response.read(2_000_001)
            if len(raw) > 2_000_000:
                raise ValueError("Arena response exceeds 2 MB")
            if response.status >= 300:
                # Never follow redirects with a bearer key; no raw body/token in diagnostics.
                try:
                    code = json.loads(raw).get("code", "request_failed")
                except (ValueError, AttributeError):
                    code = "request_failed"
                if not isinstance(code, str) or not re.fullmatch(r"[a-z_]{1,50}", code):
                    code = "request_failed"
                retry = response.getheader("Retry-After", "1")
                try:
                    delay = float(retry)
                except ValueError:
                    delay = 1
                raise ArenaError(response.status, code, min(60, max(.2, delay)) if math.isfinite(delay) else 1)
            state = json.loads(raw)
            if not isinstance(state, dict):
                raise ValueError("Invalid arena object")
            self.rtt_ms = (time.perf_counter()-started)*1000
            return state
        except (OSError, http.client.HTTPException, ValueError):
            self.connection.close()
            raise

    def close(self):
        self.connection.close()


def validate(state: dict, side: str) -> list[str]:
    if state.get("status") not in ("waiting", "playing", "finished") or state.get("turn") not in ("w", "b"):
        raise ValueError("Invalid game state")
    seat = state["seats"][side]
    if seat["kind"] != "bot" or not seat["userId"]:
        raise ValueError("The requested side is not an occupied bot seat")
    moves = [m["uci"] for m in state["moves"]]
    if len(moves) > 1500 or not all(isinstance(m, str) and UCI.fullmatch(m) for m in moves):
        raise ValueError("Invalid or unsupported move history")
    if not all(isinstance(m, str) and UCI.fullmatch(m) for m in state["legalMoves"]):
        raise ValueError("Invalid legal moves")
    return moves


def budget(state: dict, received: float, rtt_ms: float, reserve_ms: int) -> tuple[int, int]:
    now = time.monotonic()
    left = float(state["deadline"]) - float(state["serverNow"]) - (now-received)*1000 - rtt_ms - reserve_ms
    remaining = float(state["clocks"][state["turn"]]) - (float(state["serverNow"])-float(state["turnStartedAt"]))
    if not math.isfinite(left) or not math.isfinite(remaining):
        raise ValueError("Invalid server clock")
    return max(0, int(remaining)), max(0, int(left))


def polling_interval(state: dict, side: str, poll: float) -> float:
    """Short-deadline games need faster detection, with one outstanding GET only."""
    if state.get("status") != "playing" and not (isinstance(state.get("startsAt"), (int, float))
                                                and 0 <= state["startsAt"]-state.get("serverNow", 0) <= 1000):
        return poll
    limits = state.get("format", {})
    limit = limits.get("botMoveMs" if state["seats"][side]["kind"] == "bot" else "humanMoveMs")
    return min(poll, .04) if isinstance(limit, (int, float)) and 0 < limit <= 1000 else poll


def play(client: Client, engine: Engine, side: str, emit, poll: float = .2, reserve_ms: int = 220,
         ponder: str = "adaptive", think_ms: int | None = None, stop_event=None) -> dict | None:
    if side not in ("w", "b") or not .2 <= poll <= 5 or reserve_ms < 50:
        raise ValueError("Invalid side, poll interval or reserve")
    pondering_at = None
    observed = 0
    enemy_features: dict = {}
    hits = opportunities = exchanges = 0
    cpu_search_ms = pondering_ms = 0.0
    started = time.monotonic()

    def diagnostics():
        nonlocal pondering_ms
        for event in engine.diagnostics:
            if event.get("event") == "ponder":
                pondering_ms += event["elapsed_ms"]
            emit(event)
        engine.diagnostics.clear()

    try:
        state = None
        while stop_event is None or not stop_event.is_set():
            try:
                if state is None:
                    state = client.request()
                received = time.monotonic()
                received_precise = time.perf_counter()
                snapshot_rtt = client.rtt_ms
                moves = validate(state, side)
                if state["status"] == "finished":
                    engine.stop()
                    engine.send("dmmodel")
                    engine.wait("info string dmmodel ")
                    diagnostics()
                    confirmed_own = sum((i % 2 == 0) == (side == "w") for i in range(len(moves)))
                    own_used = state["format"]["initialMs"] + confirmed_own*state["format"]["incrementMs"] - state["clocks"][side]
                    emit({"event": "finished", "result": state["result"], "reason": state["reason"],
                          "plies": len(moves), "own_moves": confirmed_own, "ponder_hits": hits,
                          "ponder_opportunities": opportunities, "ponder_hit_rate": hits/max(1, opportunities),
                          "search_ms": cpu_search_ms, "ponder_ms": pondering_ms,
                          "own_clock_used_ms": own_used, "captures": sum("x" in m["san"] for m in state["moves"]), "opponent_captures": exchanges,
                          "wall_seconds": time.monotonic()-started})
                    return state
                if state["status"] == "waiting" and not state["seats"][side]["ready"]:
                    ready = client.request("ready", {})
                    if not ready["seats"][side]["ready"]:
                        raise ValueError("Token belongs to the other side")
                    state = ready
                    continue
                if state["status"] == "playing" and state["turn"] == side:
                    position_started = time.perf_counter()
                    engine.position(moves)
                    positioned = time.perf_counter()
                    # Feed only official opponent timings and features of the position they faced.
                    for i in range(observed, len(moves)):
                        if (i % 2 == 0) != (side == "w"):
                            record = state["moves"][i]
                            capture = "x" in record["san"]
                            exchanges += capture
                            engine.send(f"dmobserve {record['elapsedMs']} {int(enemy_features.get('check', False))} {int(capture)} {enemy_features.get('complexity', 0)} {enemy_features.get('phase', 0)} {record['remainingMs']}")
                    observed = len(moves)
                    remaining, hard = budget(state, received, client.rtt_ms, reserve_ms)
                    if not hard:
                        # Search reserve is exhausted: send an official legal fallback immediately.
                        if not state["legalMoves"]:
                            raise ValueError("Active game has no legal moves")
                        result = {"move": state["legalMoves"][0], "elapsed_ms": 0, "nodes": 0, "depth": 0,
                                  "ponder_hit": False, "ponder_opportunity": pondering_at is not None, "emergency": True}
                    else:
                        result = engine.think(remaining, hard, state["format"]["incrementMs"], think_ms, side)
                    thought = time.perf_counter()
                    move = result["move"]
                    if move not in state["legalMoves"]:
                        raise ValueError("Native engine returned a move outside official legalMoves")
                    opportunities += bool(result.get("ponder_opportunity"))
                    hits += bool(result.get("ponder_hit"))
                    cpu_search_ms += result["elapsed_ms"]
                    result.update(event="move", ply=len(moves), hard_budget_ms=hard,
                                  poll_rtt_ms=round(snapshot_rtt, 3),
                                  position_ms=round((positioned-position_started)*1000, 3),
                                  search_roundtrip_ms=round((thought-positioned)*1000, 3))
                    # Never retry a POST without re-reading the authoritative state.
                    # Logging can block on a slow terminal/file: send the move first.
                    post_started = time.perf_counter()
                    result["decision_ms"] = round((post_started-received_precise)*1000, 3)
                    result["estimated_margin_ms"] = round(float(state["deadline"])-float(state["serverNow"])
                                                           -(post_started-received_precise)*1000-snapshot_rtt, 3)
                    try:
                        state = client.request("move", {"move": move, "expectedPly": len(moves)})
                        accepted = state.get("moves", [])[len(moves):len(moves)+1]
                        result["accepted"] = bool(accepted and accepted[0]["uci"] == move)
                        if result["accepted"]:
                            result["server_move_ms"] = accepted[0].get("elapsedMs")
                    finally:
                        result["move_http_ms"] = round((time.perf_counter()-post_started)*1000, 3)
                        emit(result)
                        diagnostics()
                    pondering_at = None
                    if state["status"] == "playing" and state["turn"] != side:
                        enemy_features = engine.position([m["uci"] for m in state["moves"]])
                        if ponder != "off":
                            engine.ponder(ponder)
                            pondering_at = len(state["moves"])
                    continue
                if state["status"] == "playing" and state["turn"] != side and pondering_at != len(moves):
                    enemy_features = engine.position(moves)
                    if ponder != "off":
                        engine.ponder(ponder)
                    pondering_at = len(moves)
                # Sleep only the remainder of the cadence, rather than adding a
                # full poll delay after every HTTP response and IPC exchange.
                interval = polling_interval(state, side, poll)
                time.sleep(max(0, interval-client.rtt_ms/1000-(time.perf_counter()-received_precise)))
                state = None
            except ArenaError as error:
                if error.status in (401, 403, 404, 422) or 300 <= error.status < 400:
                    raise
                if error.status == 429:
                    emit({"event": "warning", "code": "rate_limit", "retry_seconds": error.retry})
                    time.sleep(error.retry)
                elif error.status == 409 or error.status >= 500:
                    time.sleep(poll)
                else:
                    raise
                state = None
            except (OSError, http.client.HTTPException):
                emit({"event": "warning", "code": "connection_lost_rereading"})
                state = None
                time.sleep(poll)
        return None
    finally:
        engine.stop()
        diagnostics()
        client.close()
