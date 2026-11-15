"""Optional independent oracle: python-chess rules only, never used by native engine."""
import os
import random
import sys
from pathlib import Path
import chess

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from adapter.engine import Engine


def perft(board,depth):
    if depth==0: return 1
    if depth==1: return board.legal_moves.count()
    nodes=0
    for move in list(board.legal_moves):
        board.push(move); nodes+=perft(board,depth-1); board.pop()
    return nodes


def main():
    rng=random.Random(20261115)
    checked=nodes=0
    with Engine(ROOT/"build"/("deepspeed.exe" if os.name=="nt" else "deepspeed")) as engine:
        for game in range(8):
            board=chess.Board()
            for ply in range(100):
                if board.is_game_over(): break
                if ply%4==0:
                    engine.position([m.uci() for m in board.move_stack])
                    engine.send("dmlegal")
                    native=set(engine.wait("info string dmlegal").split()[3:])
                    oracle={m.uci() for m in board.legal_moves}
                    if native!=oracle: raise AssertionError((board.fen(),native^oracle))
                    engine.send("perft 2")
                    n=int(engine.wait("info string perft ").split()[-1])
                    expected=perft(board,2)
                    if n!=expected: raise AssertionError((board.fen(),n,expected))
                    nodes+=n; checked+=1
                board.push(rng.choice(list(board.legal_moves)))
    print(f"PASS: {checked} random legal positions, exact move sets and {nodes} depth-2 perft nodes agree with python-chess")


if __name__=="__main__": main()
