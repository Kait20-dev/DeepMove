"""Balanced four-game fixtures, score-based selection, crash-safe checkpoints."""
from __future__ import annotations

import itertools
import random
import time
from pathlib import Path

import chess
import chess.pgn
from deepmove_botkit.learning import FEATURE_VERSION, atomic_json, read_json
from deepmove_botkit.search import Engine, SearchConfig

from .model import GENES, Genome

# Each pair gets both colors in each of two identical starting positions.
OPENINGS = ((), ('e2e4', 'e7e5', 'g1f3', 'b8c6'))


def schedule(size: int) -> list[tuple[int, int, int]]:
    return [(white, black, opening) for a, b in itertools.combinations(range(size), 2)
            for opening in range(len(OPENINGS)) for white, black in ((a, b), (b, a))]


def initialize(path: Path, size: int = 8, seed: int = 42, *, nodes: int = 512, max_plies: int = 160):
    if path.exists():
        raise ValueError('Checkpoint already exists; choose a new path or resume with train')
    if not 2 <= size <= 32 or not 16 <= nodes <= 1_000_000 or not 4 <= max_plies <= 600:
        raise ValueError('Population 2..32, nodes 16..1000000, max plies 4..600 required')
    rng = random.Random(seed)
    population = [Genome.random(f'g0-{index}', rng) for index in range(size)]
    state = {'type': 'deepneuro-league', 'version': 1, 'feature_version': FEATURE_VERSION,
             'generation': 0, 'seed': seed, 'nodes': nodes, 'max_plies': max_plies,
             'population': [genome.dump() for genome in population], 'cursor': 0,
             'scores': [0.0] * size, 'matches': [], 'completed_generations': 0,
             'rng': rng.getstate(), 'champion': None}
    atomic_json(path, state)
    return state


def load_state(path: Path) -> dict:
    state = read_json(path, limit=128_000_000)
    if (state.get('type') != 'deepneuro-league' or state.get('version') != 1
            or state.get('feature_version') != FEATURE_VERSION):
        raise ValueError('Unsupported league checkpoint')
    size = len(state['population'])
    if not 2 <= size <= 32 or not 16 <= state['nodes'] <= 1_000_000 or not 4 <= state['max_plies'] <= 600:
        raise ValueError('Invalid league limits')
    for data in state['population']:
        Genome.load(data)
    if len({data['id'] for data in state['population']}) != size:
        raise ValueError('Duplicate genome IDs')
    if not 0 <= state['cursor'] <= len(schedule(size)) or state['cursor'] != len(state['matches']):
        raise ValueError('Invalid fixture cursor')
    # Derive rather than trust scores from disk.
    scores = [0.0] * size
    for fixture, record in zip(schedule(size), state['matches']):
        white, black, _ = fixture
        if record['result'] not in ('1-0', '0-1', '1/2-1/2'):
            raise ValueError('Invalid recorded result')
        points = {'1-0': 1, '0-1': 0, '1/2-1/2': 0.5}[record['result']]
        scores[white] += points
        scores[black] += 1 - points
    if scores != state['scores']:
        raise ValueError('Checkpoint scores do not match recorded games')
    return state


def _rng_state(value):
    return tuple(_rng_state(item) for item in value) if isinstance(value, list) else value


def breed(population: list[Genome], scores: list[float], generation: int, rng: random.Random,
          mutation_rate: float = 0.1, sigma: float = 0.08) -> list[Genome]:
    ranking = sorted(range(len(population)), key=lambda index: (-scores[index], population[index].id))
    elite_count = max(1, len(population) // 4)
    children = [Genome(f'g{generation}-{index}', population[parent].weights.copy(), (population[parent].id,))
                for index, parent in enumerate(ranking[:elite_count])]
    def parent():
        candidates = rng.sample(range(len(population)), min(3, len(population)))
        return population[min(candidates, key=lambda index: (-scores[index], population[index].id))]
    while len(children) < len(population):
        a, b = parent(), parent()
        weights = []
        for index in range(GENES):
            value = (a if rng.random() < 0.5 else b).weights[index]
            if rng.random() < mutation_rate:
                value += rng.gauss(0, sigma)
            weights.append(max(-3.0, min(3.0, value)))
        children.append(Genome(f'g{generation}-{len(children)}', weights, (a.id, b.id)))
    return children


def self_play(white: Genome, black: Genome, opening: int, nodes: int, max_plies: int, deadline: float):
    board = chess.Board()
    moves = []
    for uci in OPENINGS[opening]:
        board.push_uci(uci)
        moves.append(uci)
    engines = {color: Engine(SearchConfig(max_depth=3, max_nodes=nodes, noise_cp=0, quiescence_depth=3),
                             evaluator=genome.evaluate) for color, genome in ((True, white), (False, black))}
    for _ in range(max_plies):
        outcome = board.outcome(claim_draw=True)
        if outcome:
            break
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return None  # An interrupted game awards no points and is retried on resume.
        result = engines[board.turn].search(board, min(5.0, remaining))
        if time.monotonic() >= deadline:
            return None
        if result.move is None:
            raise ValueError('Search unexpectedly returned no move')
        moves.append(result.move.uci())
        board.push(result.move)
    outcome = board.outcome(claim_draw=True)
    return {'white': white.id, 'black': black.id, 'moves': moves,
            'result': outcome.result() if outcome else '1/2-1/2',
            'termination': outcome.termination.name if outcome else 'TRAINING_PLY_LIMIT'}


def train(path: Path, *, games: int = 32, generations: int = 1, max_seconds: float = 60):
    if not 1 <= games <= 100_000 or not 1 <= generations <= 1000 or not 0 < max_seconds <= 86400:
        raise ValueError('Use bounded games 1..100000, generations 1..1000, seconds (0,86400]')
    state = load_state(path)
    deadline = time.monotonic() + max_seconds
    target = state['completed_generations'] + generations
    played = 0
    while played < games and state['completed_generations'] < target and time.monotonic() < deadline:
        population = [Genome.load(data) for data in state['population']]
        fixtures = schedule(len(population))
        if state['cursor'] < len(fixtures):
            white, black, opening = fixtures[state['cursor']]
            record = self_play(population[white], population[black], opening, state['nodes'], state['max_plies'], deadline)
            if record is None:
                break
            points = {'1-0': 1, '0-1': 0, '1/2-1/2': 0.5}[record['result']]
            state['scores'][white] += points
            state['scores'][black] += 1 - points
            state['matches'].append(record)
            state['cursor'] += 1
            played += 1
        if state['cursor'] == len(fixtures):
            best = min(range(len(population)), key=lambda index: (-state['scores'][index], population[index].id))
            state['champion'] = {'type': 'deepneuro', 'version': 1, 'feature_version': FEATURE_VERSION,
                                 'generation': state['generation'], 'points': state['scores'][best],
                                 'games_per_bot': 4 * (len(population) - 1), 'genome': population[best].dump(),
                                 'trained': True, 'note': 'League winner; playing strength has not been measured'}
            # Keep the completed league in the same atomic checkpoint for PGN export.
            state['last_league'] = {'generation': state['generation'], 'scores': state['scores'], 'matches': state['matches']}
            rng = random.Random()
            rng.setstate(_rng_state(state['rng']))
            state['generation'] += 1
            state['completed_generations'] += 1
            state['population'] = [genome.dump() for genome in breed(population, state['scores'], state['generation'], rng)]
            state['rng'] = rng.getstate()
            state['scores'], state['cursor'], state['matches'] = [0.0] * len(population), 0, []
        atomic_json(path, state)
    return {'played_this_run': played, 'generation': state['generation'], 'fixture': state['cursor'],
            'fixtures_per_generation': len(schedule(len(state['population']))), 'scores': state['scores'],
            'champion_available': state['champion'] is not None}


def export_pgn(state: dict) -> str:
    league = state.get('last_league') or state
    games = []
    for record in league['matches']:
        game = chess.pgn.Game()
        game.headers.update({'Event': 'DeepNeuro training league', 'White': record['white'], 'Black': record['black'],
                             'Result': record['result'], 'Termination': record['termination']})
        node = game
        for uci in record['moves']:
            node = node.add_variation(chess.Move.from_uci(uci))
        games.append(str(game))
    return '\n\n'.join(games) + '\n'
