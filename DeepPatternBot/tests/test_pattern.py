import json
import tempfile
import unittest
from pathlib import Path

import chess
from deepmove_botkit.learning import FEATURE_NAMES, read_json
from deeppattern_bot.engine import PatternEngine
from deeppattern_bot.index import BoundedReader, MAX_GAME_BYTES, candidates, connect, ingest, position_key, statistics
from deeppattern_bot.model import Model, train

FIXTURE = Path(__file__).resolve().parents[1] / 'examples/tiny.pgn'


class PatternTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.folder = Path(self.directory.name)
        self.db = self.folder / 'patterns.sqlite'

    def tearDown(self):
        self.directory.cleanup()

    def test_incremental_import_resume_and_duplicate_corpus(self):
        first = ingest(self.db, FIXTURE, max_games=2)
        self.assertEqual(first['imported'], 2)
        self.assertEqual(ingest(self.db, FIXTURE, max_games=2)['imported'], 2)
        self.assertEqual(ingest(self.db, FIXTURE)['imported'], 0)
        self.assertEqual(statistics(self.db)['games'], 4)
        duplicate = self.folder / 'copy.pgn'
        duplicate.write_bytes(FIXTURE.read_bytes())
        self.assertEqual(ingest(self.db, duplicate)['duplicates'], 4)
        self.assertEqual(statistics(self.db)['games'], 4)

    def test_invalid_unfinished_overlong_and_conflicting_games_do_not_pollute_index(self):
        source = self.folder / 'bad.pgn'
        source.write_text('[Result "*"]\n\n1. e4 e5 *\n\n'
                          '[Result "1-0"]\n\n1. e4 e5 2. Bh6 1-0\n\n'
                          '[Result "1-0"]\n\n1. f3 e5 2. g4 Qh4# 1-0\n', encoding='utf-8')
        report = ingest(self.db, source)
        self.assertEqual(report['rejected'], 3)
        self.assertEqual(statistics(self.db)['samples'], 0)
        self.assertEqual(ingest(self.db, FIXTURE, max_plies=1)['imported'], 0)
        self.assertEqual(statistics(self.db)['games'], 0)

    def test_result_perspective_and_game_level_holdout(self):
        ingest(self.db, FIXTURE)
        connection = connect(self.db, readonly=True)
        try:
            for row in connection.execute('SELECT * FROM moves'):
                board = chess.Board(row['position'] + ' 0 1')
                self.assertGreaterEqual(row['wins'] + row['draws'] + row['losses'], 1)
                self.assertIn(chess.Move.from_uci(row['uci']), board.legal_moves)
            # Aggregate sample and book counts must match train positions exactly.
            total = connection.execute('SELECT COALESCE(SUM(wins+draws+losses),0) FROM moves').fetchone()[0]
            samples = connection.execute("SELECT COUNT(*) FROM samples JOIN games ON games.id=game_id WHERE split='train'").fetchone()[0]
            self.assertEqual(total, samples)
            row = connection.execute('SELECT * FROM moves WHERE uci=?', ('d8h4',)).fetchone()
            if row:  # The deterministic game-level split can hold out this entire game.
                self.assertEqual((row['wins'], row['draws'], row['losses']), (1, 0, 0))
            labels = connection.execute('SELECT DISTINCT split FROM games').fetchall()
            self.assertTrue(labels)
        finally:
            connection.close()

    def test_keys_distinguish_castling_and_en_passant_but_ignore_counters(self):
        board = chess.Board()
        changed = chess.Board(board.fen())
        changed.fullmove_number = 30
        self.assertEqual(position_key(board), position_key(changed))
        changed.castling_rights = 0
        self.assertNotEqual(position_key(board), position_key(changed))
        board = chess.Board('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1')
        changed = board.copy()
        changed.ep_square = None
        self.assertNotEqual(position_key(board), position_key(changed))

    def test_duplicate_with_conflicting_nonterminal_result_is_rejected(self):
        a, b = self.folder / 'a.pgn', self.folder / 'b.pgn'
        a.write_text('[Result "1-0"]\n\n1. e4 c5 1-0\n', encoding='utf-8')
        b.write_text('[Result "0-1"]\n\n1. e4 c5 0-1\n', encoding='utf-8')
        self.assertEqual(ingest(self.db, a)['imported'], 1)
        self.assertEqual(ingest(self.db, b)['rejected'], 1)
        self.assertEqual(statistics(self.db)['games'], 1)

    def test_pattern_selects_supported_near_best_move_but_cannot_skip_winning_queen(self):
        board = chess.Board()
        tactical = chess.Board('4k3/8/8/3q4/4P3/8/8/4K3 w - - 0 1')
        connection = connect(self.db)
        with connection:
            connection.execute('INSERT INTO moves VALUES (?,?,?,?,?)', (position_key(board), 'e2e4', 20, 0, 0))
            connection.execute('INSERT INTO moves VALUES (?,?,?,?,?)', (position_key(tactical), 'e1d1', 999, 0, 0))
        connection.close()
        engine = PatternEngine(self.db, depth=1)
        self.assertEqual(engine.search(board, 1).move.uci(), 'e2e4')
        self.assertEqual(engine.source, 'pattern+search')
        self.assertEqual(engine.search(tactical, 1).move.uci(), 'e4d5')
        self.assertEqual(engine.source, 'search')
        engine.close()

    def test_pattern_confidence_legality_and_history_fallback(self):
        connection = connect(self.db)
        board = chess.Board()
        key = position_key(board)
        with connection:
            connection.execute('INSERT INTO moves VALUES (?,?,?,?,?)', (key, 'e2e4', 10, 2, 0))
            connection.execute('INSERT INTO moves VALUES (?,?,?,?,?)', (key, 'd2d4', 0, 0, 10))
            connection.execute('INSERT INTO moves VALUES (?,?,?,?,?)', (key, 'e1e8', 999, 0, 0))
            connection.execute('INSERT INTO moves VALUES (?,?,?,?,?)', (key, 'g1f3', 1, 0, 0))
        self.assertEqual([item['move'] for item in candidates(connection, board)], ['e2e4', 'd2d4'])
        board.halfmove_clock = 85
        self.assertEqual(candidates(connection, board), [])
        board = chess.Board()
        for uci in ('g1f3', 'g8f6', 'f3g1', 'f6g8'):
            board.push_uci(uci)
        self.assertEqual(candidates(connection, board), [])
        connection.close()

    def training_fixture(self):
        connection = connect(self.db)
        with connection:
            for identifier, split in (('a', 'train'), ('b', 'validation')):
                connection.execute('INSERT INTO games VALUES (?,?,?,?,?)', (identifier, '1-0', split, 'synthetic-test', 20))
                for index in range(20):
                    vector = [0.0] * len(FEATURE_NAMES)
                    vector[0] = 1 if index % 2 else -1
                    target = 1.0 if index % 2 else 0.0
                    connection.execute('INSERT INTO samples VALUES (?,?,?,?,?)',
                                       (identifier, index, json.dumps(vector), 0, target))
        connection.close()

    def test_supervised_training_learns_and_evaluates_holdout(self):
        self.training_fixture()
        model = self.folder / 'model.json'
        report = train(self.db, model, epochs=5, max_samples=100)
        self.assertEqual(report['updates'], 100)
        self.assertLess(report['validation']['cross_entropy'], report['validation']['baseline_cross_entropy'])
        self.assertGreater(Model.load(model).weights[0], 0.5)
        self.assertEqual(report['validation']['positions'], 20)

    def test_resumable_sgd_matches_uninterrupted_and_rejects_changed_corpus(self):
        self.training_fixture()
        a, b = self.folder / 'a.json', self.folder / 'b.json'
        train(self.db, a, max_samples=12)
        train(self.db, b, max_samples=5)
        train(self.db, b, max_samples=7)
        self.assertEqual(read_json(a), read_json(b))
        ingest(self.db, FIXTURE)
        with self.assertRaisesRegex(ValueError, 'Corpus changed'):
            train(self.db, a)

    def test_cold_start_mate_and_illegal_pattern_cannot_override_search(self):
        connection = connect(self.db)
        board = chess.Board('6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1')
        with connection:
            connection.execute('INSERT INTO moves VALUES (?,?,?,?,?)', (position_key(board), 'd1d2', 999, 0, 0))
        connection.close()
        for database in (None, self.db):
            engine = PatternEngine(database, depth=2)
            result = engine.search(board, 1)
            after = board.copy()
            after.push(result.move)
            self.assertTrue(after.is_checkmate())
            self.assertEqual(engine.source, 'search')
            engine.close()

    def test_bounded_pgn_parser(self):
        import io
        with self.assertRaisesRegex(ValueError, '2 MB'):
            BoundedReader(io.StringIO('{' + 'x' * MAX_GAME_BYTES + '}')).readline()

    def test_zero_time_preserves_board_and_provides_legal_fallback(self):
        engine = PatternEngine()
        board = chess.Board()
        self.assertIn(engine.search(board, 0).move, board.legal_moves)
        self.assertEqual(board.fen(), chess.STARTING_FEN)
        engine.close()


if __name__ == '__main__':
    unittest.main()
