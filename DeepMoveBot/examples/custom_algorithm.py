"""Minimal connector example: replace choose_move with YOUR own algorithm.

Run after installing the package:
  python examples/custom_algorithm.py --game UUID --side w
The example chooses a random legal move; it is not the DeepMoveBot engine.
"""
import argparse
import getpass
import os
import random

from deepmove_bot.connector import ArenaClient, Turn


def choose_move(turn: Turn) -> str:
    # Complete game history is in turn.board; the same authoritative FEN is in
    # turn.state['fen']. Reserve and measured HTTP RTT have already been removed.
    # Stop your search before turn.seconds_left reaches zero.
    return random.choice(list(turn.board.legal_moves)).uci()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--url', default='http://127.0.0.1:3000')
    parser.add_argument('--game', required=True)
    parser.add_argument('--side', choices=('w', 'b'), required=True)
    args = parser.parse_args()
    token = os.environ.get('DEEPMOVE_BOT_TOKEN') or getpass.getpass('Bot token (hidden): ')
    client = ArenaClient(args.url, args.game, token, args.side)
    final = client.play(choose_move)
    print(final['result'], final['reason'])


if __name__ == '__main__':
    main()
