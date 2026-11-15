"""Reproducible latency/memory/optimization measurements; no external engines."""
from __future__ import annotations
import argparse
import ctypes
import json
import os
import platform
import statistics
import sys
import time
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from adapter.engine import Engine

CASES={
    "opening":"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    "middlegame":"r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
    "tactical_mate":"7k/8/5KQ1/8/8/8/8/8 w - - 0 1",
    "endgame":"8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1",
    "wide":"r3k2r/pp1n1ppp/2p1bn2/3qp3/3P4/2N1PN2/PPQ2PPP/R1B1KB1R w KQkq - 0 1",
    "forced":"8/8/8/8/8/8/5k1r/7K w - - 0 1",
}


def memory(pid):
    if os.name=="nt":
        class Counters(ctypes.Structure):
            _fields_=[("cb",ctypes.c_ulong),("page_faults",ctypes.c_ulong),
                      *[(name,ctypes.c_size_t) for name in ("peak_working_set","working_set","peak_paged_pool","paged_pool","peak_nonpaged_pool","nonpaged_pool","pagefile","peak_pagefile")]]
        api=ctypes.WinDLL("kernel32",use_last_error=True)
        api.OpenProcess.restype=ctypes.c_void_p
        api.OpenProcess.argtypes=[ctypes.c_ulong,ctypes.c_int,ctypes.c_ulong]
        api.CloseHandle.argtypes=[ctypes.c_void_p]
        query=ctypes.WinDLL("psapi").GetProcessMemoryInfo
        query.argtypes=[ctypes.c_void_p,ctypes.POINTER(Counters),ctypes.c_ulong]
        handle=api.OpenProcess(0x0400|0x0010,0,pid)
        counters=Counters(); counters.cb=ctypes.sizeof(counters)
        try:
            if not query(handle,ctypes.byref(counters),counters.cb):
                raise OSError(ctypes.get_last_error(),"GetProcessMemoryInfo")
            return {"rss_bytes":counters.working_set,"peak_rss_bytes":counters.peak_working_set}
        finally:
            api.CloseHandle(handle)
    values={}
    for line in Path(f"/proc/{pid}/status").read_text().splitlines():
        if line.startswith("VmRSS:"): values["rss_bytes"]=int(line.split()[1])*1024
        if line.startswith("VmHWM:"): values["peak_rss_bytes"]=int(line.split()[1])*1024
    return values


def main():
    p=argparse.ArgumentParser()
    p.add_argument("--engine",type=Path,default=ROOT/"build"/("deepspeed.exe" if os.name=="nt" else "deepspeed"))
    p.add_argument("--repeats",type=int,default=5)
    p.add_argument("--output",type=Path,default=ROOT/"reports/benchmark.json")
    args=p.parse_args()
    rows=[]
    with Engine(args.engine,"adaptive",single_core=True) as engine:
        for name,fen in CASES.items():
            samples=[]
            for _ in range(args.repeats):
                engine.send("ucinewgame")
                engine.position([],fen)
                engine.send("dmlegal")
                legal=engine.wait("info string dmlegal").split()[3:]
                started=time.perf_counter()
                r=engine.think(300000,2780)
                samples.append({**r,"roundtrip_ms":(time.perf_counter()-started)*1000})
                if r["move"] not in legal:
                    raise RuntimeError("Illegal benchmark move")
            rows.append({"case":name,"fen":fen,"legal_moves":len(legal),"samples":samples,
                         "median_ms":statistics.median(s["elapsed_ms"] for s in samples),
                         "max_ms":max(s["elapsed_ms"] for s in samples),**memory(engine.process.pid)})
        # Same fixed depth/cold TT positions; compare root scores and total work.
        optimizations=[]
        for feature in ("tt","lmr"):
            variants=[]
            for enabled in (0,1):
                for name in ("opening","middlegame","endgame"):
                    engine.send("ucinewgame")
                    engine.send(f"dmconfig {feature} {enabled}")
                    engine.position([],CASES[name])
                    r=engine.think(300000,30000,depth=4)
                    variants.append({"enabled":bool(enabled),"case":name,**r})
            engine.send(f"dmconfig {feature} 1")
            optimizations.append({"feature":feature,"samples":variants})
    result={"platform":platform.platform(),"machine":platform.machine(),"python":sys.version,
            "affinity":"one allowed logical CPU per native engine", "compiler":"See build CMake cache / validation report",
            "repeats":args.repeats,"cases":rows,"optimizations":optimizations}
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(json.dumps(result,indent=2)+"\n",encoding="utf-8")
    print(json.dumps({"output":str(args.output),"latency_ms":{r["case"]:r["median_ms"] for r in rows}},indent=2))


if __name__=="__main__": main()
