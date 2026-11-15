"""Compare binaries at fixed depth, asserting exactly the same search tree/result."""
from __future__ import annotations

import argparse
import json
import os
import platform
import statistics
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from adapter.engine import Engine
from benchmark import CASES


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--candidate", type=Path, default=ROOT/"build"/("deepspeed.exe" if os.name == "nt" else "deepspeed"))
    parser.add_argument("--repeats", type=int, default=5)
    parser.add_argument("--depth", type=int, default=4)
    parser.add_argument("--output", type=Path, default=ROOT/"reports/search-speed.json")
    args = parser.parse_args()
    if args.repeats < 1 or not 1 <= args.depth <= 8:
        parser.error("Expected positive repeats and depth 1..8")
    rows = []
    parity_fields = ("move", "score_cp", "depth", "nodes", "qnodes", "tt_hits", "cutoffs", "reductions")
    with Engine(args.baseline, single_core=True) as baseline, Engine(args.candidate, single_core=True) as candidate:
        for name, fen in CASES.items():
            samples = {"baseline": [], "candidate": []}
            for repeat in range(args.repeats):
                # Alternate ordering to reduce warmup/thermal scheduling bias.
                variants = (("baseline", baseline), ("candidate", candidate))
                for label, engine in variants if repeat % 2 == 0 else variants[::-1]:
                    engine.send("ucinewgame")
                    engine.position([], fen)
                    started = time.perf_counter()
                    result = engine.think(300000, 30000, depth=args.depth)
                    result["roundtrip_ms"] = (time.perf_counter()-started)*1000
                    samples[label].append(result)
                reference = samples["baseline"][-1]
                current = samples["candidate"][-1]
                differences = {key: (reference[key], current[key]) for key in parity_fields if reference[key] != current[key]}
                if differences:
                    raise AssertionError(f"Search parity failed for {name}: {differences}")
                if reference["nodes"] and abs(reference["score_cp"]) < 29000 and reference["depth"] != args.depth:
                    raise AssertionError(f"Fixed-depth search ran out of time: {name}")
            before = statistics.median(row["roundtrip_ms"] for row in samples["baseline"])
            after = statistics.median(row["roundtrip_ms"] for row in samples["candidate"])
            row = {"case": name, "fen": fen, "same_tree_and_result": True,
                   "baseline_median_ms": before, "candidate_median_ms": after,
                   "speedup": before/after, "samples": samples}
            rows.append(row)
            print(f"{name}: {before:.3f} -> {after:.3f} ms ({before/after:.2f}x); identical move/score/depth/nodes")
    report = {"platform": platform.platform(), "python": sys.version,
              "depth": args.depth, "repeats": args.repeats,
              "affinity": "one allowed logical CPU, same CPU for both variants, alternating order",
              "cases": rows}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2)+"\n", encoding="utf-8")


if __name__ == "__main__":
    main()
