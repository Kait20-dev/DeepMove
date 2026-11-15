import io
import tempfile
import unittest
from pathlib import Path

import chess.pgn

from deepmove_bot.benchmark import benchmark


class BenchmarkTests(unittest.TestCase):
    def test_ply_limit_is_unfinished_and_saved_pgn_replays(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'test.pgn'
            report = benchmark(1, .001, 2, 42, 'random', path)
            self.assertEqual(report['unfinished'], 1)
            self.assertEqual(report['draws'], 0)
            game = chess.pgn.read_game(io.StringIO(path.read_text(encoding='utf8')))
            self.assertFalse(game.errors)
            self.assertEqual(game.headers['Result'], '*')
            self.assertEqual(len(list(game.mainline_moves())), 2)


if __name__ == '__main__':
    unittest.main()
