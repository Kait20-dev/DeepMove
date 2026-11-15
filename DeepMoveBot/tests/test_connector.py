import copy
import unittest
from unittest.mock import patch
from urllib.error import URLError

import chess

from deepmove_bot.bot import DeepMoveBot, TimePolicy
from deepmove_bot.connector import ArenaClient, ArenaError, NoRedirects, ProtocolError, Turn, board_from_state
from deepmove_bot.search import Engine, SearchConfig

GAME = '01234567-0123-4123-8123-0123456789ab'


def state(moves=(), status='playing'):
    board = chess.Board()
    records = []
    for move in moves:
        board.push_uci(move)
        records.append({'uci': move})
    return {'status': status, 'moves': records, 'fen': board.fen(),
            'turn': 'w' if board.turn else 'b', 'version': len(records),
            'legalMoves': [move.uci() for move in board.legal_moves],
            'seats': {side: {'kind': 'bot', 'userId': side, 'ready': status != 'waiting'} for side in ('w', 'b')},
            'deadline': 4000, 'serverNow': 1000, 'turnStartedAt': 1000,
            'clocks': {'w': 600000, 'b': 600000}, 'format': {'incrementMs': 0}}


class ConnectorTests(unittest.TestCase):
    def client(self, **kwargs):
        return ArenaClient('http://127.0.0.1:3000', GAME, 'test-secret', 'w', **kwargs)

    def test_validates_remote_https_origin_and_hides_token_from_repr(self):
        for origin in ('http://remote.example', 'https://user:pass@example.com', 'https://example.com/path',
                       'https://example.com?secret=x', 'file:///tmp/foo'):
            with self.assertRaises(ValueError):
                ArenaClient(origin, GAME, 'token', 'w')
        self.assertNotIn('test-secret', repr(self.client()))
        with self.assertRaises(ProtocolError):
            NoRedirects().redirect_request(None, None, 302, '', {}, 'https://evil.example')

    def test_rebuilds_history_and_rejects_forged_fen_or_move_list(self):
        valid = state(['e2e4', 'c7c5', 'g1f3'])
        board = board_from_state(valid)
        self.assertEqual(len(board.move_stack), 3)
        for field, replacement in [('fen', chess.STARTING_FEN), ('turn', 'w'), ('legalMoves', ['a1a8'])]:
            invalid = copy.deepcopy(valid)
            invalid[field] = replacement
            with self.assertRaises(ProtocolError):
                board_from_state(invalid)

    def test_accepts_equivalent_fen_with_pseudo_en_passant_field(self):
        snapshot = state(['e2e4'])
        snapshot['fen'] = snapshot['fen'].replace(' - 0 1', ' e3 0 1')
        self.assertEqual(board_from_state(snapshot).peek().uci(), 'e2e4')

    def test_time_policy_never_spends_the_transport_budget(self):
        now = [100.0]
        snapshot = state()
        turn = Turn(snapshot, chess.Board(), 101.0, lambda: now[0])
        self.assertAlmostEqual(TimePolicy().allocate(turn), .9)
        now[0] = 100.95
        self.assertLessEqual(TimePolicy().allocate(turn), .046)
        now[0] = 101.1
        self.assertEqual(TimePolicy().allocate(turn), 0)

    @patch('deepmove_bot.connector.time.sleep')
    def test_after_lost_move_response_gets_state_instead_of_resending(self, sleep):
        client = self.client()
        requests, choices = [], []
        snapshots = iter([state(), {**state(['e2e4']), 'status': 'finished'}])
        def request(action='', payload=None):
            requests.append((action, payload))
            if action == 'move':
                raise URLError('response lost after move accepted')
            return next(snapshots)
        client.request = request
        client.play(lambda turn: choices.append(turn) or 'e2e4')
        self.assertEqual([action for action, _ in requests], ['', 'move', ''])
        self.assertEqual(requests[1][1], {'move': 'e2e4', 'expectedPly': 0})
        self.assertEqual(len(choices), 1)

    @patch('deepmove_bot.connector.time.sleep')
    def test_fatal_auth_error_is_not_retried(self, sleep):
        client = self.client()
        client.request = lambda *args: (_ for _ in ()).throw(ArenaError(403, 'revoked'))
        with self.assertRaises(ArenaError):
            client.play(lambda turn: 'e2e4')
        sleep.assert_not_called()

    def test_wrong_side_token_is_detected_before_game(self):
        client = self.client()
        def request(action='', payload=None):
            snapshot = state(status='waiting')
            if action:
                snapshot['seats']['b']['ready'] = True
            return snapshot
        client.request = request
        with self.assertRaisesRegex(ProtocolError, 'other side'):
            client.play(lambda turn: 'e2e4')

    def test_malicious_callback_cannot_send_illegal_move(self):
        client = self.client()
        client.request = lambda *args: state()
        with self.assertRaisesRegex(ProtocolError, 'illegal UCI'):
            client.play(lambda turn: 'e2e5')

    def test_connector_budget_deducts_rtt_and_extra_reserve(self):
        times = iter([100.0, 100.2, 100.2])
        client = self.client(clock=lambda: next(times))
        snapshots = iter([state(), {**state(['e2e4']), 'status': 'finished'}])
        turns = []
        def request(action='', payload=None):
            return {} if action == 'move' else next(snapshots)
        client.request = request
        # Stop immediately after checking the first turn rather than polling again.
        def choose(turn):
            turns.append(turn)
            raise RuntimeError('checked')
        with self.assertRaises(RuntimeError):
            client.play(choose)
        self.assertAlmostEqual(turns[0].deadline, 102.7)

    def test_adapter_returns_legal_uci_without_touching_input_board(self):
        snapshot = state()
        turn = Turn(snapshot, chess.Board(), 101, lambda: 100)
        bot = DeepMoveBot(Engine(SearchConfig(max_depth=1, noise_cp=0)), TimePolicy(.1))
        self.assertIn(bot.choose_move(turn), snapshot['legalMoves'])
        self.assertEqual(turn.board.fen(), chess.STARTING_FEN)


if __name__ == '__main__':
    unittest.main()
