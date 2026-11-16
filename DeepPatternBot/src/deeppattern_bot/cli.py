from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path

import chess
from deepmove_botkit.connector import ArenaError, ProtocolError
from deepmove_botkit.learning import add_play_arguments, play_arena, positive_time

from .engine import PatternEngine
from .index import connect, ingest, statistics
from .model import Model, train


def main(argv=None):
    parser = argparse.ArgumentParser(description='DeepPatternBot — local PGN knowledge and supervised evaluation')
    commands = parser.add_subparsers(dest='command', required=True)
    init = commands.add_parser('init', help='Create an empty index; downloads nothing')
    init.add_argument('--db', required=True, type=Path)
    load = commands.add_parser('import-pgn', help='Bounded, resumable import from a local UTF-8 PGN')
    load.add_argument('pgn', type=Path)
    load.add_argument('--db', required=True, type=Path)
    load.add_argument('--max-games', type=int, default=1000)
    load.add_argument('--max-plies', type=int, default=600)
    load.add_argument('--max-db-mb', type=int, default=256)
    stats = commands.add_parser('stats')
    stats.add_argument('--db', required=True, type=Path)
    fit = commands.add_parser('train', help='Explicit opt-in: bounded streaming SGD, no download')
    fit.add_argument('--db', required=True, type=Path)
    fit.add_argument('--model', required=True, type=Path)
    fit.add_argument('--epochs', type=int, default=1)
    fit.add_argument('--max-samples', type=int, default=100_000)
    fit.add_argument('--max-seconds', type=float, default=60)
    fit.add_argument('--learning-rate', type=float, default=0.03)
    fit.add_argument('--l2', type=float, default=0.001)
    for name in ('analyze', 'play'):
        command = commands.add_parser(name)
        command.add_argument('--db', type=Path, help='Optional read-only index; omitted = search only')
        command.add_argument('--model', type=Path, help='Optional trained JSON evaluator')
        command.add_argument('--min-samples', type=int, default=3)
        command.add_argument('--depth', type=int, default=5)
        command.add_argument('--nodes', type=int, default=20_000)
        if name == 'play':
            add_play_arguments(command)
        else:
            command.add_argument('--fen', default=chess.STARTING_FEN)
            command.add_argument('--time', type=positive_time, default=0.5)
    args = parser.parse_args(argv)
    engine = None
    try:
        if args.command == 'init':
            connection = connect(args.db)
            connection.close()
            print(json.dumps(statistics(args.db)))
        elif args.command == 'import-pgn':
            print(json.dumps(ingest(args.db, args.pgn, max_games=args.max_games, max_plies=args.max_plies, max_db_mb=args.max_db_mb)))
        elif args.command == 'stats':
            print(json.dumps(statistics(args.db)))
        elif args.command == 'train':
            print(json.dumps(train(args.db, args.model, epochs=args.epochs, max_samples=args.max_samples,
                                   max_seconds=args.max_seconds, learning_rate=args.learning_rate, l2=args.l2)))
        else:
            engine = PatternEngine(args.db, Model.load(args.model) if args.model else None,
                                   minimum=args.min_samples, depth=args.depth, nodes=args.nodes)
            if args.command == 'play':
                play_arena(args, engine.search)
            else:
                result = engine.search(chess.Board(args.fen), args.time)
                print(json.dumps({'move': result.move.uci() if result.move else None, 'depth': result.depth,
                                  'nodes': result.nodes, 'score_cp_side_to_move': result.score_cp,
                                  'source': engine.source, 'patterns': engine.last_patterns,
                                  'trained_model_loaded': args.model is not None}))
        return 0
    except (ValueError, KeyError, TypeError, OSError, sqlite3.Error, ArenaError, ProtocolError) as error:
        parser.exit(1, f'DeepPatternBot stopped: {error}\n')
    except KeyboardInterrupt:
        print('Stopped. Resume from committed checkpoint; arena clocks continue.', file=sys.stderr)
        return 130
    finally:
        if engine:
            engine.close()
