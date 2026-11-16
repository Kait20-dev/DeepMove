import io
import math
import random
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import chess
import chess.pgn
from deepmove_botkit.learning import atomic_json, read_json
from deepmove_botkit.search import Engine, SearchConfig
from deepneuro_bot.evolution import breed, export_pgn, initialize, load_state, schedule, train
from deepneuro_bot.model import GENES, Genome, load_model


class NeuroTests(unittest.TestCase):
    def test_initialization_is_seeded_and_does_not_play(self):
        with tempfile.TemporaryDirectory() as folder:
            a, b = Path(folder) / 'a.json', Path(folder) / 'b.json'
            state = initialize(a, 4, 7)
            initialize(b, 4, 7)
            self.assertEqual(read_json(a), read_json(b))
            self.assertEqual(state['cursor'], 0)
            self.assertEqual(state['completed_generations'], 0)
            self.assertIsNone(state['champion'])
            with self.assertRaises(ValueError):
                initialize(a)

    def test_every_pair_has_four_balanced_games(self):
        fixtures = schedule(5)
        self.assertEqual(len(fixtures), 40)
        for a in range(5):
            for b in range(a + 1, 5):
                self.assertEqual([(w, k, o) for w, k, o in fixtures if {w, k} == {a, b}],
                                 [(a, b, 0), (b, a, 0), (a, b, 1), (b, a, 1)])

    def test_best_genome_survives_exactly_and_children_mutate(self):
        rng = random.Random(5)
        population = [Genome.random(str(index), rng) for index in range(4)]
        children = breed(population, [0, 1, 5, 2], 1, rng, mutation_rate=1)
        self.assertEqual(children[0].weights, population[2].weights)
        self.assertEqual(children[0].parents, ('2',))
        self.assertTrue(all(len(g.weights) == GENES and all(math.isfinite(x) for x in g.weights) for g in children))
        self.assertNotEqual(children[1].weights, population[2].weights)

    def test_real_short_league_resume_matches_uninterrupted(self):
        # Eight tiny games, not a strength-training run. Fixed node budget.
        with tempfile.TemporaryDirectory() as folder:
            a, b = Path(folder) / 'a.json', Path(folder) / 'b.json'
            for path in (a, b):
                initialize(path, 2, nodes=32, max_plies=4)
            train(a, games=4, max_seconds=15)
            train(b, games=2, max_seconds=15)
            self.assertIsNone(load_state(b)['champion'])
            train(b, games=2, max_seconds=15)
            self.assertEqual(read_json(a), read_json(b))
            state = load_state(a)
            self.assertEqual(state['generation'], 1)
            self.assertEqual(sum(state['last_league']['scores']), 4)
            self.assertTrue(state['champion']['trained'])
            model = Path(folder) / 'champion.json'
            atomic_json(model, state['champion'])
            self.assertEqual(load_model(model).weights, state['champion']['genome']['weights'])
            stream = io.StringIO(export_pgn(state))
            for _ in range(4):
                game = chess.pgn.read_game(stream)
                self.assertFalse(game.errors)
                self.assertEqual(game.headers['Termination'], 'TRAINING_PLY_LIMIT')
                self.assertEqual(game.headers['Result'], '1/2-1/2')

    def test_points_and_champion_follow_actual_results(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'state.json'
            initialize(path, 2, nodes=32, max_plies=4)
            def win(white, black, *args):
                return {'white': white.id, 'black': black.id, 'moves': [],
                        'result': '1-0' if white.id == 'g0-1' else '0-1', 'termination': 'TEST'}
            with patch('deepneuro_bot.evolution.self_play', side_effect=win):
                train(path, games=4)
            state = load_state(path)
            self.assertEqual(state['champion']['genome']['id'], 'g0-1')
            self.assertEqual(state['champion']['points'], 4)
            self.assertEqual(state['population'][0]['weights'], state['champion']['genome']['weights'])

    def test_interrupted_game_awards_no_points(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'state.json'
            initialize(path, 2, nodes=32, max_plies=4)
            with patch('deepneuro_bot.evolution.self_play', return_value=None):
                report = train(path, games=1)
            self.assertEqual(report['played_this_run'], 0)
            self.assertEqual(load_state(path)['scores'], [0, 0])

    def test_cold_start_finds_mate_and_hanging_queen(self):
        genome = Genome.random('cold', random.Random(42))
        engine = Engine(SearchConfig(max_depth=2, noise_cp=0), evaluator=genome.evaluate)
        board = chess.Board('6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1')
        board.push(engine.search(board, 1).move)
        self.assertTrue(board.is_checkmate())
        board = chess.Board('4k3/8/8/3q4/4P3/8/8/4K3 w - - 0 1')
        self.assertEqual(engine.search(board, 1).move.uci(), 'e4d5')

    def test_tampered_scores_and_invalid_genome_are_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'state.json'
            state = initialize(path, 2)
            state['scores'][0] = 99
            atomic_json(path, state)
            with self.assertRaises(ValueError):
                load_state(path)
        with self.assertRaises(ValueError):
            Genome.load({'id': 'bad', 'weights': [0]})


if __name__ == '__main__':
    unittest.main()
