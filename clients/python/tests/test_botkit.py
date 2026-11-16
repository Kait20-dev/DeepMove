import math
import random
import tempfile
import unittest
from pathlib import Path

import chess
from deepmove_botkit.learning import FEATURE_NAMES, atomic_json, checked_vector, features, read_json
from deepmove_botkit.search import Engine, SearchConfig


# Run the mature search/transport conformance suite against the shared fork too.
ROOT = Path(__file__).resolve().parents[3]
for filename in ('test_engine.py', 'test_connector.py'):
    source = (ROOT / 'DeepMoveBot/tests' / filename).read_text(encoding='utf-8').replace('deepmove_bot.', 'deepmove_botkit.')
    # Original bot/time-policy behavior is checked as an interoperability consumer.
    source = source.replace('from deepmove_botkit.bot import', 'from deepmove_bot.bot import')
    namespace = {'__name__': f'botkit_{filename[:-3]}', '__file__': str(ROOT / 'DeepMoveBot/tests' / filename)}
    exec(compile(source, filename, 'exec'), namespace)
    globals().update({name: value for name, value in namespace.items()
                      if isinstance(value, type) and issubclass(value, unittest.TestCase)})


class BotKitTests(unittest.TestCase):
    def test_feature_abi_color_mirror_and_scaling(self):
        board = chess.Board()
        rng = random.Random(19)
        for _ in range(60):
            if board.is_game_over():
                break
            board.push(rng.choice(list(board.legal_moves)))
            vector = features(board)
            self.assertEqual(len(vector), len(FEATURE_NAMES))
            self.assertTrue(all(math.isfinite(x) and abs(x) <= 2 for x in vector))
            self.assertEqual(vector, [-x for x in features(board.mirror())])

    def test_custom_evaluator_changes_search_without_mutating_position(self):
        board = chess.Board()
        def evaluator(position):
            value = 1000 if position.piece_at(chess.E4) == chess.Piece(chess.PAWN, True) else 0
            return value if position.turn else -value
        result = Engine(SearchConfig(max_depth=1, noise_cp=0), evaluator=evaluator).search(board, 1)
        self.assertEqual(result.move.uci(), 'e2e4')
        self.assertEqual(board.fen(), chess.STARTING_FEN)

    def test_atomic_json_and_invalid_models(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'state.json'
            atomic_json(path, {'generation': 0})
            with self.assertRaises(ValueError):
                atomic_json(path, {'bad': float('nan')})
            self.assertEqual(read_json(path), {'generation': 0})
            self.assertEqual(list(path.parent.glob('*.tmp')), [])
        for vector in ([float('nan')], [True], [float('inf')], [11], []):
            with self.assertRaises(ValueError):
                checked_vector(vector, 1)


if __name__ == '__main__':
    unittest.main()
