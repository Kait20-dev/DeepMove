"""Four-round cup connector example. Replace choose_move with your algorithm.

Python 3.10+, no dependencies. The sample uses random legal moves for teaching.
Never put the series key in a command line, URL, screenshot, or source control.
"""
import argparse
import getpass
import os

from deepmove_client import ArenaError, DeepMoveSeriesClient
from example_bot import choose_move


def main():
    parser = argparse.ArgumentParser(description="DeepMove four-game series connector")
    parser.add_argument("--url", default="http://127.0.0.1:3000")
    parser.add_argument("--series", required=True)
    args = parser.parse_args()
    token = os.environ.get("DEEPMOVE_SERIES_TOKEN") or getpass.getpass("Series key (hidden): ")
    client = DeepMoveSeriesClient(args.url, args.series, token)
    try:
        result = client.play(choose_move, lambda state: print(
            f"round={state['series']['round']}/4 | {state['status']} | "
            f"ply={len(state['moves'])}", flush=True))
        print("Series complete:", result["score"], "counted:", result["counted"])
    except (ArenaError, ValueError) as error:
        parser.exit(1, f"Connector stopped: {error}\n")
    except KeyboardInterrupt:
        print("Disconnected. Active game clocks keep running. Restart to resume.")


if __name__ == "__main__":
    main()
