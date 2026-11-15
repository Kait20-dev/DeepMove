import random
import time
import unittest

import chess

from deepmove_bot.evaluation import TEMPO, evaluate, explain
from deepmove_bot.search import (
    Engine, MATE, MATE_THRESHOLD, RootScore, SearchConfig, position_key, select_candidate,
)


class EvaluationTests(unittest.TestCase):
    def test_color_mirror_symmetry(self):
        board = chess.Board()
        for uci in ['e2e4', 'c7c5', 'g1f3', 'd7d6', 'f1b5', 'b8c6']:
            board.push_uci(uci)
        self.assertEqual(explain(board).white_cp, -explain(board.mirror()).white_cp)
        self.assertEqual(evaluate(board), evaluate(board.mirror()))

    def test_initial_position_and_material_advantage(self):
        start = explain(chess.Board())
        self.assertEqual(start.phase, 24)
        self.assertEqual(start.white_cp, TEMPO)
        board = chess.Board('4k3/8/8/8/8/8/8/3QK3 w - - 0 1')
        self.assertGreater(explain(board).white_cp, 800)

    def test_phase_and_feature_breakdown(self):
        board = chess.Board('4k3/8/8/3P4/8/8/8/4K3 w - - 0 1')
        report = explain(board)
        self.assertEqual(report.phase, 0)
        self.assertGreater(report.white['pawns'][1], 0)
        self.assertEqual(report.white_cp, report.endgame_difference + TEMPO)


class SearchTests(unittest.TestCase):
    def engine(self, depth=2, **options):
        return Engine(SearchConfig(max_depth=depth, noise_cp=0, **options), seed=7)

    def test_finds_mate_in_one_and_does_not_randomize_it(self):
        board = chess.Board('6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1')
        result = Engine(SearchConfig(max_depth=3, noise_cp=100), seed=99).search(board, 1)
        self.assertGreaterEqual(result.score_cp, MATE_THRESHOLD)
        board.push(result.move)
        self.assertTrue(board.is_checkmate())

    def test_captures_hanging_queen(self):
        board = chess.Board('4k3/8/8/3q4/4P3/8/8/4K3 w - - 0 1')
        result = self.engine().search(board, 1)
        self.assertEqual(result.move.uci(), 'e4d5')

    def test_quiescence_avoids_poisoned_capture_at_depth_one(self):
        board = chess.Board('3r2k1/5ppp/8/8/8/8/3p1PPP/3Q2K1 w - - 0 1')
        result = self.engine(depth=1).search(board, 1)
        self.assertNotEqual(result.move.uci(), 'd1d2')
        self.assertIn(result.move, board.legal_moves)

    def test_check_evasion_and_promotions_are_legal(self):
        for fen in ['4r1k1/5ppp/8/8/8/8/5PPP/4K3 w - - 0 1',
                    '8/P6k/8/8/8/8/7p/4K3 w - - 0 1',
                    'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1']:
            board = chess.Board(fen)
            result = self.engine().search(board, .3)
            self.assertIn(result.move, board.legal_moves)
            if fen.startswith('8/P'):
                self.assertIsNotNone(result.move.promotion)

    def test_terminal_positions_return_no_move(self):
        for fen, expected in [('7k/6Q1/6K1/8/8/8/8/8 b - - 0 1', -MATE),
                              ('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1', 0),
                              ('4k3/8/8/8/8/8/8/4K3 w - - 0 1', 0)]:
            result = self.engine().search(chess.Board(fen), .1)
            self.assertIsNone(result.move)
            self.assertEqual(result.score_cp, expected)

    def test_repetition_requires_history_and_does_not_poison_next_search(self):
        board = chess.Board()
        for uci in ['g1f3', 'g8f6', 'f3g1', 'f6g8'] * 2:
            board.push_uci(uci)
        engine = self.engine(depth=1)
        self.assertIsNone(engine.search(board, .2).move)
        without_history = chess.Board(board.fen())
        self.assertIn(engine.search(without_history, .2).move, without_history.legal_moves)

    def test_fifty_moves_and_mate_precedence(self):
        board = chess.Board('4k3/8/8/8/8/8/8/R3K3 w - - 100 51')
        self.assertIsNone(self.engine().search(board, .1).move)
        mate = chess.Board('7k/6Q1/6K1/8/8/8/8/8 b - - 100 51')
        self.assertEqual(self.engine().search(mate, .1).score_cp, -MATE)

    def test_zero_budget_and_interrupted_search_preserve_board(self):
        board = chess.Board()
        engine = self.engine(depth=8, max_nodes=10)
        original = board.fen()
        for seconds in (0, 1):
            result = engine.search(board, seconds)
            self.assertIn(result.move, board.legal_moves)
            self.assertEqual(board.fen(), original)
            self.assertEqual(engine._board.fen(), original)
            self.assertEqual(engine._counts, engine._initial_counts(board))
        self.assertEqual(result.depth, 0)  # Incomplete root iteration must be discarded.

    def test_mate_scores_roundtrip_across_transposition_ply(self):
        for score in (MATE - 5, -MATE + 7, 42):
            self.assertEqual(Engine._from_tt(Engine._to_tt(score, 3), 3), score)

    def test_tt_and_no_tt_give_same_fixed_depth_scores(self):
        board = chess.Board('4k3/8/8/3q4/4P3/8/8/4K3 w - - 0 1')
        cached = self.engine().search(board, 3)
        uncached = self.engine(tt_capacity=0).search(board, 3)
        self.assertEqual(cached.depth, 2)
        self.assertEqual((cached.move, cached.score_cp), (uncached.move, uncached.score_cp))

    def test_key_uses_only_legal_en_passant_rights(self):
        pinned = chess.Board('k3r3/8/8/3pP3/8/8/8/4K3 w - d6 0 2')
        no_ep = chess.Board('k3r3/8/8/3pP3/8/8/8/4K3 w - - 0 2')
        self.assertEqual(position_key(pinned), position_key(no_ep))
        legal = chess.Board('k7/8/8/3pP3/8/8/8/4K3 w - d6 0 2')
        no_ep = chess.Board('k7/8/8/3pP3/8/8/8/4K3 w - - 0 2')
        self.assertNotEqual(position_key(legal), position_key(no_ep))

    def test_softmax_only_samples_near_best_and_seed_is_reproducible(self):
        scores = [RootScore(chess.Move.from_uci(move), score, ())
                  for move, score in [('e2e4', 50), ('d2d4', 40), ('g1f3', 34), ('a2a3', -500)]]
        config = SearchConfig(noise_cp=20)
        one, two = random.Random(17), random.Random(17)
        first = [select_candidate(scores, config, one).move for _ in range(100)]
        second = [select_candidate(scores, config, two).move for _ in range(100)]
        self.assertEqual(first, second)
        self.assertGreater(len(set(first)), 1)
        self.assertTrue(all(move.uci() != 'a2a3' for move in first))
        deterministic = SearchConfig(noise_cp=0)
        self.assertEqual(select_candidate(scores, deterministic, one).move.uci(), 'e2e4')

    def test_principal_variation_is_legal_and_soft_deadline_is_bounded(self):
        board = chess.Board()
        start = time.monotonic()
        result = self.engine(depth=20).search(board, .05)
        self.assertLess(time.monotonic() - start, .5)
        for move in result.pv:
            self.assertIn(move, board.legal_moves)
            board.push(move)


if __name__ == '__main__':
    unittest.main()
