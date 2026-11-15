#pragma once
#include <array>
#include <cstdint>
#include <string>
#include <string_view>
#include <stdexcept>

namespace ds {
using Bits = std::uint64_t;
constexpr std::string_view START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
enum Type { Pawn, Knight, Bishop, Rook, Queen, King, None };
constexpr int color(int piece) { return piece / 6; }
constexpr int type(int piece) { return piece % 6; }
constexpr Bits bit(int square) { return Bits{1} << square; }
int pop(Bits& bits);
struct Move {
    std::uint16_t value = 0;
    constexpr Move() = default;
    constexpr Move(int from, int to, int promotion = 0)
        : value(static_cast<std::uint16_t>(from | (to << 6) | (promotion << 12))) {}
    constexpr int from() const { return value & 63; }
    constexpr int to() const { return (value >> 6) & 63; }
    constexpr int promotion() const { return value >> 12; } // 1 N, 2 B, 3 R, 4 Q
    explicit constexpr operator bool() const { return value != 0; }
    constexpr bool operator==(const Move&) const = default;
    std::string uci() const;
    static Move parse(std::string_view uci);
};
struct MoveList {
    std::array<Move, 256> data{};
    int size = 0;
    void add(Move move) {
        if (size >= static_cast<int>(data.size())) throw std::runtime_error("Move list limit exceeded");
        data[size++] = move;
    }
    Move* begin() { return data.data(); }
    Move* end() { return data.data() + size; }
    const Move* begin() const { return data.data(); }
    const Move* end() const { return data.data() + size; }
};
struct Undo {
    std::uint64_t key, context;
    int captured, capturedSquare, rights, ep, halfmove, fullmove;
};
struct Board {
    std::array<std::int8_t, 64> squares{};
    std::array<Bits, 12> pieces{};
    std::array<Bits, 2> occupied{};
    std::array<int, 2> kings{};
    std::array<std::uint64_t, 2048> history{};
    int historySize = 0;
    int turn = 0, rights = 0, ep = -1, halfmove = 0, fullmove = 1;
    std::uint64_t key = 0;
    std::uint64_t context = 0; // Reversible history fingerprint for draw-safe search cache.
    std::uint64_t searchKey() const;
    Board();
    explicit Board(std::string_view fen);
    void setFen(std::string_view fen);
    std::string fen() const;
    Bits all() const { return occupied[0] | occupied[1]; }
    bool attacked(int square, int by) const;
    bool attacked(int square, int by, Bits occupancy, Bits excludedPawns) const;
    bool inCheck() const { return attacked(kings[turn], turn ^ 1); }
    Bits attacks(int pieceType, int square, int side) const;
    void pseudo(MoveList& moves, bool capturesOnly = false) const;
    MoveList legal(bool capturesOnly = false);
    Undo make(Move move);
    void unmake(Move move, const Undo& undo);
    bool play(std::string_view uci);
    bool isCapture(Move move) const;
    bool insufficient() const;
    bool repetition(int count = 3) const;
    bool drawn() const { return halfmove >= 100 || insufficient() || repetition(); }
    std::uint64_t recomputeKey() const;
private:
    void put(int square, int piece);
    void remove(int square);
    std::uint64_t epKey() const;
};
std::uint64_t perft(Board& board, int depth);
}
