"""Persistent native process; stdout is exclusively the UCI protocol."""
from __future__ import annotations

import ctypes
import json
import os
import queue
import subprocess
import threading
import time
from pathlib import Path


def pin_one_core(pid: int) -> None:
    """Optional tournament CPU affinity, restricted to an already allowed CPU."""
    if os.name == "nt":
        api = ctypes.WinDLL("kernel32", use_last_error=True)
        api.OpenProcess.restype = ctypes.c_void_p
        api.OpenProcess.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32]
        api.GetProcessAffinityMask.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_size_t), ctypes.POINTER(ctypes.c_size_t)]
        api.SetProcessAffinityMask.argtypes = [ctypes.c_void_p, ctypes.c_size_t]
        api.CloseHandle.argtypes = [ctypes.c_void_p]
        handle = api.OpenProcess(0x0200 | 0x0400, 0, pid)
        if not handle:
            raise OSError(ctypes.get_last_error(), "OpenProcess affinity")
        try:
            allowed, system = ctypes.c_size_t(), ctypes.c_size_t()
            if not api.GetProcessAffinityMask(handle, ctypes.byref(allowed), ctypes.byref(system)):
                raise OSError(ctypes.get_last_error(), "GetProcessAffinityMask")
            mask = allowed.value & -allowed.value
            if not api.SetProcessAffinityMask(handle, mask):
                raise OSError(ctypes.get_last_error(), "SetProcessAffinityMask")
        finally:
            api.CloseHandle(handle)
    elif hasattr(os, "sched_getaffinity"):
        os.sched_setaffinity(pid, {min(os.sched_getaffinity(pid))})
    else:
        raise RuntimeError("CPU affinity unsupported on this platform")


class Engine:
    def __init__(self, executable: Path, mode: str = "adaptive", config: Path | None = None,
                 single_core: bool = False):
        command = [str(executable.resolve())]
        if config:
            command += ["--config", str(config.resolve())]
        command += ["--mode", mode]
        self.process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE, text=True, bufsize=1,
                                        **({"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}))
        self.lines: queue.Queue[str | None] = queue.Queue()
        self.diagnostics: list[dict] = []
        self.last_result: dict = {}
        self.last_opportunity = False
        self.last_features: dict = {}
        self.errors: list[str] = []
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()
        self.error_reader = threading.Thread(target=self._read_errors, daemon=True)
        self.error_reader.start()
        try:
            if single_core:
                pin_one_core(self.process.pid)
            self.send("uci")
            self.wait("uciok", 10)
        except BaseException:
            self.close()
            raise

    def _read(self) -> None:
        assert self.process.stdout
        for line in self.process.stdout:
            self.lines.put(line.rstrip("\r\n"))
        self.lines.put(None)

    def _read_errors(self) -> None:
        assert self.process.stderr
        for line in self.process.stderr:
            self.errors.append(line.rstrip())
            self.errors = self.errors[-20:]

    def send(self, line: str) -> None:
        if "\n" in line or "\r" in line or len(line) > 65000:
            raise ValueError("Invalid protocol command")
        assert self.process.stdin
        self.process.stdin.write(line + "\n")
        self.process.stdin.flush()

    def _dispatch(self, line: str) -> None:
        if line.startswith("info string error"):
            raise RuntimeError(line)
        for prefix, kind in (("info string dmresult ", "search"), ("info string dmponder ", "ponder"),
                             ("info string dmfeatures ", "features"), ("info string dmmodel ", "model")):
            if line.startswith(prefix):
                data = json.loads(line[len(prefix):])
                if kind == "search":
                    self.last_result = data
                elif kind == "features":
                    self.last_features = data
                else:
                    self.diagnostics.append({"event": kind, **data})
                return
        if line.startswith("info string dmopportunity "):
            self.last_opportunity = line.endswith("1")

    def wait(self, prefix: str, timeout: float = 5) -> str:
        deadline = time.monotonic() + timeout
        while True:
            try:
                line = self.lines.get(timeout=max(.001, deadline-time.monotonic()))
            except queue.Empty:
                raise TimeoutError("Native engine response timeout") from None
            if line is None:
                raise RuntimeError("Native engine exited: " + "; ".join(self.errors))
            self._dispatch(line)
            if line.startswith(prefix):
                return line
            if time.monotonic() >= deadline:
                raise TimeoutError("Native engine response timeout")

    def sync(self) -> None:
        self.send("isready")
        self.wait("readyok")

    def position(self, moves: list[str], fen: str | None = None) -> dict:
        self.send(("position fen " + fen if fen else "position startpos") + (" moves " + " ".join(moves) if moves else ""))
        self.send("dmfeatures")
        self.wait("info string dmfeatures ")
        return self.last_features

    def think(self, remaining_ms: int, hard_ms: int, increment_ms: int = 0,
              think_ms: int | None = None, side: str = "w", depth: int | None = None) -> dict:
        command = f"go {side}time {max(0, remaining_ms)} {side}inc {max(0, increment_ms)} hardtime {max(1, hard_ms)}"
        if think_ms is not None:
            command += f" movetime {max(1, min(think_ms, hard_ms))}"
        if depth is not None:
            command += f" depth {depth}"
        self.last_opportunity = False
        self.send(command)
        line = self.wait("bestmove ", max(1, hard_ms/1000 + .5))
        if self.last_result.get("move") != line.split()[1]:
            raise RuntimeError("Search telemetry and bestmove disagree")
        return {**self.last_result, "ponder_opportunity": self.last_opportunity}

    def ponder(self, strategy: str = "adaptive") -> None:
        self.send("dmponder " + strategy)

    def stop(self) -> None:
        self.send("stop")
        self.sync()

    def close(self) -> None:
        if self.process.poll() is None:
            try:
                self.send("quit")
                self.process.wait(timeout=3)
            except (OSError, subprocess.TimeoutExpired):
                self.process.kill()
                self.process.wait(timeout=3)
        self.reader.join(timeout=1)
        self.error_reader.join(timeout=1)
        for stream in (self.process.stdin, self.process.stdout, self.process.stderr):
            if stream:
                stream.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
