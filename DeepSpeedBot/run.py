"""Example: python run.py --url http://127.0.0.1:3000 --game UUID --side w"""
from __future__ import annotations
import argparse
import getpass
import json
import os
import sys
from pathlib import Path
from adapter.arena import Client, play
from adapter.engine import Engine


def main() -> int:
    root = Path(__file__).resolve().parent
    p = argparse.ArgumentParser(description="DeepSpeedBot: Я уже сходил. Теперь твоя очередь думать.")
    p.add_argument("--url", default="http://127.0.0.1:3000")
    p.add_argument("--game", required=True)
    p.add_argument("--side", choices=["w", "b"], required=True)
    p.add_argument("--engine", type=Path, default=root/"build"/("deepspeed.exe" if os.name=="nt" else "deepspeed"))
    p.add_argument("--mode", choices=["speed", "survival", "pressure", "balanced", "adaptive"], default="adaptive")
    p.add_argument("--ponder", choices=["off", "single", "multi", "adaptive"], default="adaptive")
    p.add_argument("--config", type=Path, default=root/"config/default.conf")
    p.add_argument("--poll", type=float, default=.2)
    p.add_argument("--reserve-ms", type=int, default=220)
    p.add_argument("--think-ms", type=int, help="Override adaptive target; still bounded by server deadline")
    p.add_argument("--single-core", action="store_true", help="Pin native engine to one allowed CPU")
    p.add_argument("--log", type=Path, help="JSONL diagnostics, no secrets")
    args=p.parse_args()
    token=os.environ.pop("DEEPSPEED_BOT_TOKEN", None) or getpass.getpass("Bot token (hidden): ")
    log=None
    try:
        client=Client(args.url,args.game,token)
        if args.log:
            args.log.parent.mkdir(parents=True,exist_ok=True)
            log=args.log.open("a",encoding="utf-8")
        def emit(data):
            line=json.dumps(data,ensure_ascii=False)
            print(line,flush=True)
            if log:
                log.write(line+"\n"); log.flush()
        with Engine(args.engine,args.mode,args.config,args.single_core) as engine:
            play(client,engine,args.side,emit,args.poll,args.reserve_ms,args.ponder,args.think_ms)
        return 0
    except KeyboardInterrupt:
        print("Stopped locally; arena clocks continue. Reconnect or resign in the arena.",file=sys.stderr)
        return 130
    except Exception as error:
        print(f"DeepSpeedBot: {error}",file=sys.stderr)
        return 1
    finally:
        if log:
            log.close()


if __name__=="__main__":
    raise SystemExit(main())
