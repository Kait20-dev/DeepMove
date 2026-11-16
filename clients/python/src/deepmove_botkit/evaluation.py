"""Handcrafted, phase-interpolated evaluation. All scores are centipawns.

The exact feature definitions and coefficients are in docs/FORMULAS.md.
This module does not load weights, opening books, tablebases or other engines.
"""
from __future__ import annotations

from dataclasses import dataclass

import chess

MG_VALUE = (0, 100, 320, 335, 500, 950, 0)
EG_VALUE = (0, 120, 310, 330, 520, 930, 0)
PHASE_VALUE = (0, 0, 1, 1, 2, 4, 0)
MG_MOBILITY = (0, 0, 4, 4, 2, 1, 0)
EG_MOBILITY = (0, 0, 2, 3, 4, 2, 0)
TEMPO = 12
FEATURES = ("material", "placement", "mobility", "pawns", "bishop_pair", "rook_files", "king_safety")


def square_bonus(piece_type: int, square: int, endgame: bool = False) -> int:
    """Square is oriented as white: relative rank r=0 is the home rank."""
    file, rank = chess.square_file(square), chess.square_rank(square)
    center = 14 - abs(2 * file - 7) - abs(2 * rank - 7)
    if piece_type == chess.PAWN:
        return (12 if endgame else 9) * rank + 2 * center
    if piece_type == chess.KNIGHT:
        return (6 if endgame else 7) * center - (12 if rank == 0 else 0) - (8 if file in (0, 7) else 0)
    if piece_type == chess.BISHOP:
        return 5 * center if endgame else 4 * center + 3 * rank
    if piece_type == chess.ROOK:
        return 3 * center if endgame else 2 * rank + (18 if rank == 6 else 0)
    if piece_type == chess.QUEEN:
        return 4 * center if endgame else center - 6 * max(0, rank - 2)
    if piece_type == chess.KING:
        return 8 * center if endgame else -4 * center - 8 * rank + (32 if rank == 0 and file in (2, 6) else 0)
    return 0


MG_PST = tuple(tuple(square_bonus(piece, square) for square in chess.SQUARES) for piece in range(7))
EG_PST = tuple(tuple(square_bonus(piece, square, True) for square in chess.SQUARES) for piece in range(7))


def _passed_mask(color: bool, square: int) -> int:
    file, rank = chess.square_file(square), chess.square_rank(square)
    ranks = range(rank + 1, 8) if color else range(rank)
    return sum(chess.BB_SQUARES[chess.square(f, r)] for r in ranks for f in range(max(0, file - 1), min(8, file + 2)))


PASSED_MASK = {
    color: tuple(_passed_mask(color, square) for square in chess.SQUARES)
    for color in chess.COLORS
}


@dataclass(frozen=True)
class Evaluation:
    white_cp: int
    phase: int
    midgame_difference: int
    endgame_difference: int
    white: dict[str, tuple[int, int]]
    black: dict[str, tuple[int, int]]


def explain(board: chess.Board) -> Evaluation:
    scores: dict[bool, dict[str, list[int]]] = {
        color: {feature: [0, 0] for feature in FEATURES} for color in chess.COLORS
    }
    pawn_attacks = {color: 0 for color in chess.COLORS}
    all_attacks = {color: 0 for color in chess.COLORS}
    phase = 0
    for color in chess.COLORS:
        for square in chess.scan_forward(board.pieces_mask(chess.PAWN, color)):
            pawn_attacks[color] |= chess.BB_PAWN_ATTACKS[color][square]
    for color in chess.COLORS:
        own = board.occupied_co[color]
        enemy_pawns = board.pieces_mask(chess.PAWN, not color)
        own_pawns = board.pieces_mask(chess.PAWN, color)
        features = scores[color]
        for piece_type in chess.PIECE_TYPES:
            pieces = board.pieces_mask(piece_type, color)
            count = pieces.bit_count()
            phase += count * PHASE_VALUE[piece_type]
            features["material"][0] += count * MG_VALUE[piece_type]
            features["material"][1] += count * EG_VALUE[piece_type]
            if piece_type == chess.BISHOP and count >= 2:
                features["bishop_pair"] = [28, 40]
            for square in chess.scan_forward(pieces):
                relative = square if color else chess.square_mirror(square)
                features["placement"][0] += MG_PST[piece_type][relative]
                features["placement"][1] += EG_PST[piece_type][relative]
                attacks = board.attacks_mask(square)
                all_attacks[color] |= attacks
                if piece_type in (chess.KNIGHT, chess.BISHOP, chess.ROOK, chess.QUEEN):
                    mobility = (attacks & ~own & ~pawn_attacks[not color]).bit_count()
                    features["mobility"][0] += mobility * MG_MOBILITY[piece_type]
                    features["mobility"][1] += mobility * EG_MOBILITY[piece_type]
                if piece_type == chess.PAWN:
                    file = chess.square_file(square)
                    rank = chess.square_rank(relative)
                    adjacent = (chess.BB_FILES[file - 1] if file else 0) | (chess.BB_FILES[file + 1] if file < 7 else 0)
                    if not own_pawns & adjacent:
                        features["pawns"][0] -= 14
                        features["pawns"][1] -= 18
                    if not enemy_pawns & PASSED_MASK[color][square]:
                        features["pawns"][0] += 4 * rank * rank
                        features["pawns"][1] += 8 * rank * rank
                    if pawn_attacks[color] & chess.BB_SQUARES[square]:
                        features["pawns"][0] += 8
                        features["pawns"][1] += 12
                if piece_type == chess.ROOK:
                    file_mask = chess.BB_FILES[chess.square_file(square)]
                    if not own_pawns & file_mask:
                        bonus = (12, 10) if enemy_pawns & file_mask else (22, 18)
                        features["rook_files"][0] += bonus[0]
                        features["rook_files"][1] += bonus[1]
        doubled = sum(max(0, (own_pawns & mask).bit_count() - 1) for mask in chess.BB_FILES)
        features["pawns"][0] -= 18 * doubled
        features["pawns"][1] -= 12 * doubled
    for color in chess.COLORS:
        king = board.king(color)
        if king is None:
            continue
        danger = (chess.BB_KING_ATTACKS[king] & all_attacks[not color]).bit_count()
        scores[color]["king_safety"][0] -= 10 * danger
        scores[color]["king_safety"][1] -= 2 * danger
        rank = chess.square_rank(king) + (1 if color else -1)
        if 0 <= rank <= 7:
            file = chess.square_file(king)
            shield = sum(bool(board.pieces_mask(chess.PAWN, color) & chess.BB_SQUARES[chess.square(f, rank)])
                         for f in range(max(0, file - 1), min(8, file + 2)))
            scores[color]["king_safety"][0] += 10 * shield
    mg = sum(score[0] for score in scores[chess.WHITE].values()) - sum(score[0] for score in scores[chess.BLACK].values())
    eg = sum(score[1] for score in scores[chess.WHITE].values()) - sum(score[1] for score in scores[chess.BLACK].values())
    phase = min(24, phase)
    # int(... / ...) truncates symmetrically under color mirroring.
    white_cp = int((mg * phase + eg * (24 - phase)) / 24) + (TEMPO if board.turn else -TEMPO)
    return Evaluation(white_cp, phase, mg, eg,
                      {key: tuple(value) for key, value in scores[chess.WHITE].items()},
                      {key: tuple(value) for key, value in scores[chess.BLACK].items()})


def evaluate(board: chess.Board) -> int:
    """Static score from the side-to-move perspective, not a game result."""
    score = explain(board).white_cp
    return score if board.turn else -score
