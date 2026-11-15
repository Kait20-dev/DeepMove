"""Connection example, NOT a competition-strength engine.

Replace choose_move with your own algorithm. No third-party Python packages.
"""
import argparse
import getpass
import os
import random

from deepmove_client import ArenaError, DeepMoveClient


def choose_move(state: dict, budget_seconds: float) -> str:
    # state['fen'] is the authoritative position. Budget includes network reserve.
    # Implement your own search here; do not use a ready-made engine in the event.
    del budget_seconds
    return random.choice(state["legalMoves"])


def main():
    parser = argparse.ArgumentParser(description="DeepMove example bot")
    parser.add_argument("--url", default="http://127.0.0.1:3000")
    parser.add_argument("--game", required=True)
    parser.add_argument("--side", choices=("w", "b"), required=True)
    args = parser.parse_args()
    token = os.environ.get("DEEPMOVE_BOT_TOKEN") or getpass.getpass("Bot token (hidden): ")
    client = DeepMoveClient(args.url, args.game, token, args.side)
    try:
        result = client.play(choose_move, lambda state: print(
            f"{state['status']} | ply={len(state['moves'])} | turn={state['turn']}", flush=True))
        print("Result:", result["result"], result["reason"])
    except (ArenaError, ValueError) as error:
        parser.exit(1, f"Bot stopped: {error}\n")
    except KeyboardInterrupt:
        print("Disconnected. The server clock continues to run.")


if __name__ == "__main__":
    main()
