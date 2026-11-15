"""Console entry points: play, analyze, bench."""
from __future__ import annotations

import argparse
import getpass
import json
import math
import os
import sys
from dataclasses import asdict
from pathlib import Path

import chess
import chess.pgn

from . import __version__
from .benchmark import benchmark
from .bot import DeepMoveBot, TimePolicy
from .connector import ArenaClient, ArenaError, ProtocolError
from .evaluation import explain
from .search import Engine, SearchConfig, SearchResult


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(prog='deepmove-bot', description='Handcrafted chess engine and DeepMove connector')
    root.add_argument('--version', action='version', version=__version__)
    commands = root.add_subparsers(dest='command', required=True)
    for name in ('play', 'analyze'):
        command = commands.add_parser(name)
        command.add_argument('--depth', type=int, default=8, help='Maximum completed search depth, 1..32')
        command.add_argument('--noise', type=int, default=20, help='Near-best sampling window in cp; 0 is deterministic')
        command.add_argument('--temperature', type=float, default=8, help='Softmax temperature in cp')
        command.add_argument('--seed', type=int, help='Random seed; fixed-depth runs are reproducible')
        command.add_argument('--nodes', type=int, help='Optional node limit, useful for reproducible experiments')
    play = commands.choices['play']
    play.add_argument('--url', default='http://127.0.0.1:3000', help='Final arena origin; use HTTPS remotely')
    play.add_argument('--game', required=True, help='Game UUID')
    play.add_argument('--side', required=True, choices=('w', 'b'))
    play.add_argument('--max-think', type=float, default=1.8, help='Maximum seconds per search; server deadline also applies')
    play.add_argument('--reserve', type=float, default=0.3, help='Extra network reserve, 0.1..2 seconds')
    play.add_argument('--poll', type=float, default=0.2, help='State polling interval, 0.1..2 seconds')
    play.add_argument('--quiet', action='store_true', help='Only print final result and warnings')
    analyze = commands.choices['analyze']
    source = analyze.add_mutually_exclusive_group()
    source.add_argument('--fen', default=chess.STARTING_FEN)
    source.add_argument('--pgn', type=Path, help='Analyze final position of the first PGN game, preserving history')
    analyze.add_argument('--time', type=float, default=1, help='Search time in seconds, 0..60')
    bench = commands.add_parser('bench', help='Local test against random or 1-ply greedy baseline')
    bench.add_argument('--games', type=int, default=4)
    bench.add_argument('--time', type=float, default=0.15)
    bench.add_argument('--max-plies', type=int, default=100)
    bench.add_argument('--seed', type=int, default=42)
    bench.add_argument('--opponent', choices=('random', 'greedy'), default='greedy')
    bench.add_argument('--out', type=Path, help='Save actual match records as PGN')
    return root


def _seconds(value: float, minimum: float = 0) -> float:
    if not math.isfinite(value) or not minimum <= value <= 60:
        raise ValueError(f'Time must be finite and {minimum}..60 seconds')
    return value


def _config(args) -> SearchConfig:
    return SearchConfig(max_depth=args.depth, noise_cp=args.noise,
                        temperature_cp=args.temperature, max_nodes=args.nodes)


def _search_json(result: SearchResult) -> dict:
    return {
        'move': result.move.uci() if result.move else None,
        'score_cp_side_to_move': result.score_cp, 'best_score_cp': result.best_score_cp,
        'completed_depth': result.depth, 'nodes': result.nodes,
        'elapsed_ms': round(result.elapsed_seconds * 1000, 1),
        'pv': [move.uci() for move in result.pv], 'stopped_early': result.stopped_early,
        'candidates': [{'move': item.move.uci(), 'cp': item.score} for item in result.candidates],
    }


def main(argv: list[str] | None = None) -> int:
    root = parser()
    args = root.parse_args(argv)
    try:
        if args.command == 'analyze':
            if args.pgn:
                if args.pgn.stat().st_size > 1_000_000:
                    raise ValueError('PGN file exceeds 1 MB')
                with args.pgn.open(encoding='utf-8-sig') as stream:
                    game = chess.pgn.read_game(stream)
                if not game or game.errors:
                    raise ValueError('Invalid or empty PGN')
                board = game.end().board()
            else:
                board = chess.Board(args.fen)
            engine = Engine(_config(args), args.seed)
            result = engine.search(board, _seconds(args.time))
            payload = {**_search_json(result), 'static_evaluation': asdict(explain(board))}
            print(json.dumps(payload, ensure_ascii=False, indent=2))
        elif args.command == 'play':
            max_think = _seconds(args.max_think, 0.01)
            # There is deliberately no --token argument: do not expose secrets in ps.
            token = os.environ.get('DEEPMOVE_BOT_TOKEN') or getpass.getpass('Bot token (hidden): ')
            client = ArenaClient(args.url, args.game, token, args.side, reserve=args.reserve, poll=args.poll)
            def log_search(result: SearchResult):
                if not args.quiet:
                    print(json.dumps(_search_json(result)), flush=True)
            bot = DeepMoveBot(Engine(_config(args), args.seed), TimePolicy(max_think), log_search)
            result = client.play(bot.choose_move,
                                 on_warning=lambda message: print(message, file=sys.stderr, flush=True))
            print(json.dumps({'result': result['result'], 'reason': result['reason'],
                              'plies': len(result['moves'])}), flush=True)
        else:
            if not 1 <= args.games <= 100 or not 2 <= args.max_plies <= 1000:
                raise ValueError('Games must be 1..100; ply limit 2..1000')
            report = benchmark(args.games, _seconds(args.time, 0.001), args.max_plies,
                               args.seed, args.opponent, args.out)
            print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0
    except (ValueError, OSError, ArenaError, ProtocolError) as error:
        root.exit(1, f'DeepMoveBot stopped: {error}\n')
    except KeyboardInterrupt:
        print('Disconnected. The arena clock continues to run.', file=sys.stderr)
        return 130


if __name__ == '__main__':
    raise SystemExit(main())
