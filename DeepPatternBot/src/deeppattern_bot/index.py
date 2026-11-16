"""One-game-at-a-time PGN ingestion, deduplicated transactions, indexed lookup.

Corpora are local files. Import never downloads data or starts training.
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
from pathlib import Path

import chess
import chess.pgn
from deepmove_botkit.learning import features

SCHEMA = 1
MAX_GAME_BYTES = 2_000_000


def position_key(board: chess.Board) -> str:
    # Exclude move numbers but retain castling and legally relevant en-passant.
    return ' '.join(board.fen(en_passant='legal').split()[:4])


def connect(path: Path, *, readonly: bool = False) -> sqlite3.Connection:
    if readonly:
        connection = sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True, timeout=5)
    else:
        path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(path, timeout=5)
    connection.row_factory = sqlite3.Row
    version = connection.execute('PRAGMA user_version').fetchone()[0]
    if version not in (0, SCHEMA) or readonly and version != SCHEMA:
        connection.close()
        raise ValueError('Unsupported or uninitialized pattern database')
    if not readonly:
        connection.execute('PRAGMA foreign_keys=ON')
        connection.execute('PRAGMA journal_mode=WAL')
        connection.executescript('''
            CREATE TABLE IF NOT EXISTS games (
                id TEXT PRIMARY KEY, result TEXT NOT NULL, split TEXT NOT NULL,
                source TEXT NOT NULL, plies INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS samples (
                game_id TEXT NOT NULL REFERENCES games(id), ply INTEGER NOT NULL,
                features TEXT NOT NULL, baseline REAL NOT NULL, target REAL NOT NULL,
                PRIMARY KEY (game_id, ply)
            );
            CREATE TABLE IF NOT EXISTS moves (
                position TEXT NOT NULL, uci TEXT NOT NULL,
                wins INTEGER NOT NULL, draws INTEGER NOT NULL, losses INTEGER NOT NULL,
                PRIMARY KEY (position, uci)
            );
            CREATE TABLE IF NOT EXISTS imports (
                source TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, offset INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS games_split ON games(split, id);
            PRAGMA user_version=1;
        ''')
    return connection


class BoundedReader:
    """Enforce a per-game byte budget even when the parser reads huge comments."""
    def __init__(self, stream):
        self.stream, self.bytes = stream, 0

    def readline(self):
        line = self.stream.readline(MAX_GAME_BYTES + 1)
        self.bytes += len(line.encode('utf-8'))
        if self.bytes > MAX_GAME_BYTES:
            raise ValueError('PGN game exceeds 2 MB; split/clean the source file')
        return line


class StrictGame(chess.pgn.GameBuilder):
    def handle_error(self, error):
        # python-chess otherwise logs untrusted PGN text to stderr.
        self.game.errors.append(error)


def _fingerprint(path: Path) -> str:
    stat = path.stat()
    # Resume uses a fast local identity, not a cryptographic full-file guarantee.
    with path.open('rb') as stream:
        prefix = stream.read(65536)
    return f'{stat.st_size}:{stat.st_mtime_ns}:' + hashlib.sha256(prefix).hexdigest()


def ingest(database: Path, source: Path, *, max_games: int = 1000, max_plies: int = 600,
           max_db_mb: int = 256) -> dict:
    if not 1 <= max_games <= 1_000_000 or not 1 <= max_plies <= 2000 or not 8 <= max_db_mb <= 1_000_000:
        raise ValueError('Games 1..1000000, plies 1..2000, database cap 8..1000000 MB required')
    from deepmove_botkit.learning import baseline_white
    imported = duplicates = rejected = scanned = 0
    fingerprint = _fingerprint(source)
    source_name = str(source.resolve())
    connection = connect(database)
    try:
        cap = max_db_mb * 1024 * 1024 // connection.execute('PRAGMA page_size').fetchone()[0]
        if connection.execute('PRAGMA page_count').fetchone()[0] > cap:
            raise ValueError('Existing database already exceeds --max-db-mb')
        connection.execute(f'PRAGMA max_page_count={cap}')
        checkpoint = connection.execute('SELECT * FROM imports WHERE source=?', (source_name,)).fetchone()
        offset = checkpoint['offset'] if checkpoint and checkpoint['fingerprint'] == fingerprint else 0
        with source.open(encoding='utf-8-sig', newline='') as stream:
            stream.seek(offset)
            while scanned < max_games:
                # TextIO cookies (rather than byte offsets) preserve UTF-8 decoder state.
                game = chess.pgn.read_game(BoundedReader(stream), Visitor=StrictGame)
                if game is None:
                    break
                scanned += 1
                rows = []
                try:
                    board = game.board()
                    if game.errors or game.headers.get('Variant', 'Standard') not in ('Standard', 'Chess') or not board.is_valid() or board.chess960:
                        raise ValueError('Invalid/nonstandard PGN')
                    result = game.headers.get('Result')
                    if result not in ('1-0', '0-1', '1/2-1/2'):
                        raise ValueError('Unfinished/unknown result')
                    target = {'1-0': 1.0, '0-1': 0.0, '1/2-1/2': 0.5}[result]
                    start = board.fen()
                    ucis = []
                    for ply, move in enumerate(game.mainline_moves()):
                        if ply >= max_plies or move not in board.legal_moves:
                            raise ValueError('Too long/illegal game')
                        rows.append((position_key(board), move.uci(), json.dumps(features(board)), baseline_white(board), board.turn))
                        ucis.append(move.uci())
                        board.push(move)
                    if not rows:
                        raise ValueError('Empty game')
                    outcome = board.outcome(claim_draw=False)
                    if outcome and outcome.result() != result:
                        raise ValueError('Result contradicts final position')
                    # Identity excludes result and headers: contradictory labels cannot double-count a game.
                    identity = hashlib.sha256((start + '|' + ' '.join(ucis)).encode()).hexdigest()
                    existing = connection.execute('SELECT result FROM games WHERE id=?', (identity,)).fetchone()
                    if existing:
                        if existing['result'] != result:
                            rejected += 1
                        else:
                            duplicates += 1
                    else:
                        # Stable game-level holdout, never split adjacent positions across train/validation.
                        split = 'validation' if int(identity[:8], 16) % 5 == 0 else 'train'
                        with connection:
                            connection.execute('INSERT INTO games VALUES (?,?,?,?,?)', (identity, result, split, source.name, len(rows)))
                            for ply, (position, uci, vector, baseline, turn) in enumerate(rows):
                                connection.execute('INSERT INTO samples VALUES (?,?,?,?,?)', (identity, ply, vector, baseline, target))
                                # Only TRAIN games enter the book: validation remains genuinely held out.
                                if split == 'train':
                                    points = target if turn else 1 - target
                                    wdl = (int(points == 1), int(points == 0.5), int(points == 0))
                                    connection.execute('''INSERT INTO moves VALUES (?,?,?,?,?) ON CONFLICT(position,uci)
                                        DO UPDATE SET wins=wins+excluded.wins, draws=draws+excluded.draws,
                                        losses=losses+excluded.losses''', (position, uci, *wdl))
                            connection.execute('INSERT OR REPLACE INTO imports VALUES (?,?,?)', (source_name, fingerprint, stream.tell()))
                        imported += 1
                except (ValueError, TypeError, IndexError):
                    rejected += 1
                # Also advance over rejected and duplicate games. Crash before this only causes a safe re-read.
                with connection:
                    connection.execute('INSERT OR REPLACE INTO imports VALUES (?,?,?)', (source_name, fingerprint, stream.tell()))
            final_offset = stream.tell()
        return {'scanned': scanned, 'imported': imported, 'duplicates': duplicates, 'rejected': rejected,
                'offset': final_offset}
    finally:
        connection.close()


def statistics(database: Path) -> dict:
    connection = connect(database, readonly=True)
    try:
        return {**{table: connection.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0]
                   for table in ('games', 'samples', 'moves')},
                'splits': {row['split']: row['n'] for row in connection.execute('SELECT split,COUNT(*) n FROM games GROUP BY split')}}
    finally:
        connection.close()


def candidates(connection: sqlite3.Connection, board: chess.Board, minimum: int = 3) -> list[dict]:
    if board.halfmove_clock >= 80 or board.is_repetition(2):
        return []  # History-sensitive positions use search, not a history-free book key.
    legal = {move.uci() for move in board.legal_moves}
    result = []
    for row in connection.execute('SELECT * FROM moves WHERE position=? LIMIT 256', (position_key(board),)):
        n = row['wins'] + row['draws'] + row['losses']
        if row['uci'] in legal and n >= minimum:
            mean = (row['wins'] + 0.5 * row['draws'] + 1) / (n + 2)
            # Conservative lower confidence score; this is not a claimed calibrated probability.
            score = mean - 0.5 / (n + 2) ** 0.5
            result.append({'move': row['uci'], 'samples': n, 'smoothed_score': mean, 'selection_score': score})
    return sorted(result, key=lambda item: (-item['selection_score'], -item['samples'], item['move']))
