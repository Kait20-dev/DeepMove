"""Paired, legal local matches vs unchanged DeepMoveBot. Not an Elo estimate.

Uses Python chess rules ONLY for arbitration. Native search has no chess dependency.
Run with DeepMoveBot's existing virtualenv; output includes every PGN and JSONL move.
"""
from __future__ import annotations
import argparse
import datetime
import json
import math
import os
import statistics
import sys
import time
from pathlib import Path
import chess
import chess.pgn

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
sys.path.insert(0,str(ROOT.parent/"DeepMoveBot/src"))
from adapter.engine import Engine
from deepmove_bot.search import Engine as Baseline, SearchConfig

OPENINGS=[
    [],
    ["e2e4","e7e5","g1f3","b8c6","f1b5","a7a6"],
    ["d2d4","d7d5","c2c4","e7e6","b1c3","g8f6"],
    ["c2c4","e7e5","b1c3","g8f6","g2g3","d7d5"],
]
VARIANTS=[
    ("adaptive","adaptive",{}),
    ("balanced","adaptive",{}),
    ("speed","adaptive",{}),
    ("survival","adaptive",{}),
    ("pressure","adaptive",{}),
    ("no_ponder","off",{}),
    ("no_complexity","adaptive",{"complexity":0}),
    ("no_exchange_preference","adaptive",{"avoid_exchanges":0}),
]


def terminal(board):
    if board.is_checkmate(): return ("0-1" if board.turn else "1-0"),"checkmate"
    if board.is_stalemate(): return "1/2-1/2","stalemate"
    if board.is_insufficient_material(): return "1/2-1/2","insufficient_material"
    if board.is_repetition(3): return "1/2-1/2","repetition"
    if board.is_fifty_moves(): return "1/2-1/2","fifty_moves"
    return "*",None


def correlation(pairs):
    if len(pairs)<3: return None
    xmean=statistics.mean(x for x,_ in pairs); ymean=statistics.mean(y for _,y in pairs)
    xx=sum((x-xmean)**2 for x,_ in pairs); yy=sum((y-ymean)**2 for _,y in pairs)
    return sum((x-xmean)*(y-ymean) for x,y in pairs)/math.sqrt(xx*yy) if xx and yy else None


def main():
    p=argparse.ArgumentParser()
    p.add_argument("--games-per-variant",type=int,default=8)
    p.add_argument("--think-ms",type=int,default=20)
    p.add_argument("--baseline-ms",type=int,default=20)
    p.add_argument("--max-plies",type=int,default=240)
    p.add_argument("--seed",type=int,default=20261115)
    p.add_argument("--output",type=Path,default=ROOT/"reports/matches")
    p.add_argument("--variants",nargs="*",help="Subset of variants")
    args=p.parse_args()
    if not 1<=args.games_per_variant<=100 or not 1<=args.think_ms<=2500 or not 1<=args.baseline_ms<=2500:
        p.error("Invalid budgets/game count")
    args.output.mkdir(parents=True,exist_ok=True)
    exe=ROOT/"build"/("deepspeed.exe" if os.name=="nt" else "deepspeed")
    all_games=[]; all_moves=[]; started=time.monotonic()
    log=(args.output/"moves.jsonl").open("w",encoding="utf-8")
    pgn_file=(args.output/"games.pgn").open("w",encoding="utf-8")
    try:
        for name,ponder,overrides in VARIANTS:
            if args.variants and name not in args.variants: continue
            for index in range(args.games_per_variant):
                native_white=index%2==0; color=chess.WHITE if native_white else chess.BLACK
                opening=OPENINGS[(index//2)%len(OPENINGS)]
                baseline=Baseline(SearchConfig(max_depth=8),args.seed+index)
                board=chess.Board(); history=[]
                game=chess.pgn.Game(); game.headers.update(Event="DeepSpeedBot local paired benchmark",Date=datetime.datetime.now(datetime.timezone.utc).strftime("%Y.%m.%d"),White="DeepSpeedBot "+name if native_white else "DeepMoveBot",Black="DeepMoveBot" if native_white else "DeepSpeedBot "+name,TimeControl="300+0",BotMoveLimit="3",VariantLabel=name,Seed=str(args.seed+index))
                node=game
                for uci in opening:
                    move=chess.Move.from_uci(uci); board.push(move); history.append(uci); node=node.add_variation(move)
                clocks={chess.WHITE:300000.0,chess.BLACK:300000.0}
                samples=[]; opponent_pairs=[]; ponder_nodes=ponder_ms=useful_nodes=0; hits=opportunities=exchanges=0
                result,reason=terminal(board)
                with Engine(exe,name if name in ("adaptive","balanced","speed","survival","pressure") else "balanced",single_core=True) as native:
                    for key,value in overrides.items(): native.send(f"dmconfig {key} {value}")
                    features=native.position(history)
                    if board.turn!=color and ponder!="off": native.ponder(ponder)
                    for ply in range(len(opening),args.max_plies):
                        result,reason=terminal(board)
                        if result!="*": break
                        active=board.turn
                        turn_started=time.monotonic()
                        if active==color:
                            features=native.position(history)
                            for diag in native.diagnostics:
                                if diag["event"]=="ponder": ponder_nodes+=diag["nodes"]; ponder_ms+=diag["elapsed_ms"]
                            native.diagnostics.clear()
                            r=native.think(int(clocks[active]),max(1,int(min(2780,clocks[active]-220))),think_ms=args.think_ms,side="w" if active else "b")
                            move=chess.Move.from_uci(r["move"])
                            hits+=r["ponder_hit"]; opportunities+=r["ponder_opportunity"]
                            if r["ponder_hit"]: useful_nodes+=r["ponder_nodes"]
                            samples.append(r)
                        else:
                            baseline_result=baseline.search(board,args.baseline_ms/1000)
                            move=baseline_result.move
                            r={"move":move.uci() if move else None,"elapsed_ms":baseline_result.elapsed_seconds*1000,"depth":baseline_result.depth,"nodes":baseline_result.nodes}
                        elapsed=(time.monotonic()-turn_started)*1000
                        clocks[active]-=elapsed
                        if elapsed>=3000 or clocks[active]<=0:
                            # This mirrors the normal material-bearing tournament cases.
                            result="0-1" if active else "1-0"; reason="timeout"; break
                        if move not in board.legal_moves: raise RuntimeError(f"Illegal move at {name}/{index}/{ply}")
                        if active!=color:
                            opponent_pairs.append((features["complexity"],elapsed))
                            native.send(f"dmobserve {elapsed} {int(features['check'])} {int(board.is_capture(move))} {features['complexity']} {features['phase']} {clocks[active]}")
                        capture=board.is_capture(move); exchanges+=capture
                        san=board.san(move); board.push(move); history.append(move.uci()); node=node.add_variation(move)
                        node.comment=f"[%emt {elapsed/1000:.6f}]"
                        row={"variant":name,"game":index,"ply":ply,"side":"w" if active else "b","native":active==color,"server_equivalent_ms":elapsed,"position_complexity":features["complexity"],"in_check":features["check"],"phase":features["phase"],"san":san,**r}
                        all_moves.append(row); log.write(json.dumps(row)+"\n")
                        if active==color and terminal(board)[0]=="*":
                            features=native.position(history)
                            if ponder!="off": native.ponder(ponder)
                    if result=="*": result,reason=terminal(board)
                    native.stop()
                    for diag in native.diagnostics:
                        if diag["event"]=="ponder": ponder_nodes+=diag["nodes"]; ponder_ms+=diag["elapsed_ms"]
                game.headers["Result"]=result
                game.headers["Termination"]=reason or "ply limit (unfinished)"
                pgn_file.write(str(game)+"\n\n"); pgn_file.flush(); log.flush()
                outcome="unfinished" if result=="*" else "draw" if result=="1/2-1/2" else "win" if (result=="1-0")==native_white else "loss"
                summary={"variant":name,"game":index,"native_white":native_white,"opening":opening,"result":result,"reason":reason or "ply_limit","outcome":outcome,"plies":len(history),"native_moves":len(samples),"native_mean_ms":statistics.mean(s["elapsed_ms"] for s in samples) if samples else 0,"native_max_ms":max((s["elapsed_ms"] for s in samples),default=0),"native_clock_used_ms":300000-clocks[color],"baseline_clock_used_ms":300000-clocks[not color],"nodes":sum(s["nodes"] for s in samples),"ponder_nodes":ponder_nodes,"ponder_ms":ponder_ms,"ponder_hits":hits,"ponder_opportunities":opportunities,"useful_ponder_nodes":useful_nodes,"complexity_latency_correlation":correlation(opponent_pairs),"exchanges":exchanges}
                all_games.append(summary)
                print(json.dumps({"variant":name,"game":index+1,"outcome":outcome,"plies":len(history),"hits":hits}),flush=True)
        totals={}
        for name,_,_ in VARIANTS:
            rows=[g for g in all_games if g["variant"]==name]
            if not rows: continue
            moves=[m for m in all_moves if m["variant"]==name and m["native"]]
            totals[name]={"games":len(rows),**{o:sum(g["outcome"]==o for g in rows) for o in ("win","loss","draw","unfinished")},"time_wins":sum(g["outcome"]=="win" and g["reason"]=="timeout" for g in rows),"time_losses":sum(g["outcome"]=="loss" and g["reason"]=="timeout" for g in rows),"mean_plies":statistics.mean(g["plies"] for g in rows),"median_move_ms":statistics.median(m["elapsed_ms"] for m in moves),"max_move_ms":max(m["elapsed_ms"] for m in moves),"mean_depth":statistics.mean(m["depth"] for m in moves),"ponder_hits":sum(g["ponder_hits"] for g in rows),"ponder_opportunities":sum(g["ponder_opportunities"] for g in rows),"ponder_nodes":sum(g["ponder_nodes"] for g in rows),"useful_ponder_nodes":sum(g["useful_ponder_nodes"] for g in rows)}
        report={"seed":args.seed,"games_per_variant":args.games_per_variant,"native_target_ms":args.think_ms,"baseline_target_ms":args.baseline_ms,"max_plies":args.max_plies,"wall_seconds":time.monotonic()-started,"affinity":"native pinned to one allowed logical CPU; baseline single Python search thread, OS scheduled", "note":"Local paired matches, not API games/Elo. Target equal wall search budgets, different implementation languages. Ponder useful fraction counts nodes in hit branches, not proof every node was reused. Unfinished games are not counted as draws.","totals":totals,"games":all_games}
        (args.output/"summary.json").write_text(json.dumps(report,indent=2)+"\n",encoding="utf-8")
        print(json.dumps(totals,indent=2))
    finally:
        log.close(); pgn_file.close()


if __name__=="__main__": main()
