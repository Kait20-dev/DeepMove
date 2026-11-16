from __future__ import annotations

import argparse
import json
import random
import sys
from pathlib import Path

import chess
from deepmove_botkit.connector import ArenaError, ProtocolError
from deepmove_botkit.learning import FEATURE_VERSION, add_play_arguments, atomic_json, play_arena, positive_time
from deepmove_botkit.search import Engine, SearchConfig

from .evolution import export_pgn, initialize, load_state, schedule, train
from .model import Genome, load_model


def main(argv=None):
    parser = argparse.ArgumentParser(description='DeepNeuroBot — explicit, bounded neuroevolution')
    commands = parser.add_subparsers(dest='command', required=True)
    init = commands.add_parser('init', help='Create an untrained population; plays no games')
    init.add_argument('--checkpoint', type=Path, required=True)
    init.add_argument('--population', type=int, default=8)
    init.add_argument('--seed', type=int, default=42)
    init.add_argument('--nodes', type=int, default=512)
    init.add_argument('--max-plies', type=int, default=160)
    fit = commands.add_parser('train', help='Explicit opt-in: resume self-play and selection')
    fit.add_argument('--checkpoint', type=Path, required=True)
    fit.add_argument('--games', type=int, default=32)
    fit.add_argument('--generations', type=int, default=1)
    fit.add_argument('--max-seconds', type=float, default=60)
    inspect = commands.add_parser('inspect')
    inspect.add_argument('--checkpoint', type=Path, required=True)
    export = commands.add_parser('export', help='Export league champion and/or PGN')
    export.add_argument('--checkpoint', type=Path, required=True)
    export.add_argument('--model', type=Path)
    export.add_argument('--pgn', type=Path)
    for name in ('analyze', 'play'):
        command = commands.add_parser(name)
        command.add_argument('--model', type=Path, help='Exported champion JSON; omitted = seeded untrained network')
        command.add_argument('--seed', type=int, default=42)
        command.add_argument('--depth', type=int, default=5)
        command.add_argument('--nodes', type=int, default=20_000)
        if name == 'play':
            add_play_arguments(command)
        else:
            command.add_argument('--fen', default=chess.STARTING_FEN)
            command.add_argument('--time', type=positive_time, default=0.5)
    args = parser.parse_args(argv)
    try:
        if args.command == 'init':
            state = initialize(args.checkpoint, args.population, args.seed, nodes=args.nodes, max_plies=args.max_plies)
            print(json.dumps({'initialized': True, 'trained': False, 'population': len(state['population']),
                              'fixtures': len(schedule(args.population)), 'feature_version': FEATURE_VERSION}))
        elif args.command == 'train':
            print(json.dumps(train(args.checkpoint, games=args.games, generations=args.generations, max_seconds=args.max_seconds)))
        elif args.command == 'inspect':
            state = load_state(args.checkpoint)
            print(json.dumps({key: state[key] for key in ('generation', 'cursor', 'scores', 'completed_generations')}, indent=2))
        elif args.command == 'export':
            state = load_state(args.checkpoint)
            if not args.model and not args.pgn:
                raise ValueError('Choose --model and/or --pgn')
            destinations = [path.resolve() for path in (args.model, args.pgn) if path]
            if args.checkpoint.resolve() in destinations or len(destinations) != len(set(destinations)):
                raise ValueError('Use separate checkpoint, model and PGN paths')
            if args.model:
                if not state['champion']:
                    raise ValueError('No completed generation: no trained champion to export')
                atomic_json(args.model, state['champion'])
            if args.pgn:
                args.pgn.parent.mkdir(parents=True, exist_ok=True)
                args.pgn.write_text(export_pgn(state), encoding='utf-8')
            print(json.dumps({'exported': True}))
        else:
            genome = load_model(args.model) if args.model else Genome.random('untrained', random.Random(args.seed))
            engine = Engine(SearchConfig(max_depth=args.depth, max_nodes=args.nodes, noise_cp=0), evaluator=genome.evaluate)
            if args.command == 'play':
                play_arena(args, engine.search)
            else:
                result = engine.search(chess.Board(args.fen), args.time)
                print(json.dumps({'move': result.move.uci() if result.move else None, 'depth': result.depth,
                                  'nodes': result.nodes, 'score_cp_side_to_move': result.score_cp,
                                  'model': genome.id, 'trained_model_loaded': args.model is not None}))
        return 0
    except (ValueError, KeyError, TypeError, OSError, ArenaError, ProtocolError) as error:
        parser.exit(1, f'DeepNeuroBot stopped: {error}\n')
    except KeyboardInterrupt:
        print('Stopped. Committed games remain in checkpoint; arena clocks continue.', file=sys.stderr)
        return 130
