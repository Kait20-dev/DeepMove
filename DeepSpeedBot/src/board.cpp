#include "deepspeed/board.hpp"
#include <algorithm>
#include <bit>
#include <cmath>
#include <sstream>
#include <stdexcept>

namespace ds {
namespace {
struct Tables {
    Bits knight[64]{}, king[64]{}, pawn[2][64]{};
    std::uint64_t piece[12][64]{}, castle[16]{}, ep[8]{}, side{};
    Tables() {
        std::uint64_t seed = 0xDEE950EED12345ULL;
        auto random = [&]() { // SplitMix64: deterministic independent Zobrist keys.
            auto z = (seed += 0x9e3779b97f4a7c15ULL);
            z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9ULL;
            z = (z ^ (z >> 27)) * 0x94d049bb133111ebULL;
            return z ^ (z >> 31);
        };
        for (int sq = 0; sq < 64; ++sq) {
            int x = sq % 8, y = sq / 8;
            for (int dx = -2; dx <= 2; ++dx) for (int dy = -2; dy <= 2; ++dy) {
                int nx = x + dx, ny = y + dy;
                if (nx < 0 || nx > 7 || ny < 0 || ny > 7) continue;
                if (std::abs(dx) + std::abs(dy) == 3 && dx && dy) knight[sq] |= bit(ny * 8 + nx);
                if (std::max(std::abs(dx), std::abs(dy)) == 1) king[sq] |= bit(ny * 8 + nx);
                if (std::abs(dx) == 1 && dy == 1) pawn[0][sq] |= bit(ny * 8 + nx);
                if (std::abs(dx) == 1 && dy == -1) pawn[1][sq] |= bit(ny * 8 + nx);
            }
        }
        for (auto& p : piece) for (auto& key : p) key = random();
        for (auto& key : castle) key = random();
        for (auto& key : ep) key = random();
        side = random();
    }
};
const Tables tables;
constexpr int directions[8][2] = {{1,0},{-1,0},{0,1},{0,-1},{1,1},{-1,1},{1,-1},{-1,-1}};
Bits sliders(int square, int t, Bits occupancy) {
    Bits result = 0;
    int start = t == Bishop ? 4 : 0, end = t == Rook ? 4 : 8;
    for (int dir = start; dir < end; ++dir) {
        int x = square % 8 + directions[dir][0], y = square / 8 + directions[dir][1];
        while (x >= 0 && x < 8 && y >= 0 && y < 8) {
            Bits target = bit(y * 8 + x); result |= target;
            if (occupancy & target) break;
            x += directions[dir][0]; y += directions[dir][1];
        }
    }
    return result;
}
constexpr std::string_view symbols = "PNBRQKpnbrqk";
std::string squareName(int sq) { return {char('a' + sq % 8), char('1' + sq / 8)}; }
}
int pop(Bits& bits) { int square = std::countr_zero(bits); bits &= bits - 1; return square; }
std::string Move::uci() const {
    if (!value) return "0000";
    auto result = squareName(from()) + squareName(to());
    if (promotion()) result += " nbrq"[promotion()];
    return result;
}
Move Move::parse(std::string_view s) {
    if (s.size() != 4 && s.size() != 5) return {};
    if (s[0] < 'a' || s[0] > 'h' || s[2] < 'a' || s[2] > 'h' ||
        s[1] < '1' || s[1] > '8' || s[3] < '1' || s[3] > '8') return {};
    int promotion = 0;
    if (s.size() == 5) {
        auto p = std::string_view("nbrq").find(s[4]);
        if (p == std::string_view::npos) return {};
        promotion = static_cast<int>(p) + 1;
    }
    return Move((s[1]-'1')*8+s[0]-'a', (s[3]-'1')*8+s[2]-'a', promotion);
}
Board::Board() { setFen(START_FEN); }
Board::Board(std::string_view fen) { setFen(fen); }
void Board::put(int sq, int piece) {
    squares[sq] = static_cast<std::int8_t>(piece);
    pieces[piece] |= bit(sq); occupied[color(piece)] |= bit(sq);
    key ^= tables.piece[piece][sq];
    if (type(piece) == King) kings[color(piece)] = sq;
}
void Board::remove(int sq) {
    int p = squares[sq];
    pieces[p] &= ~bit(sq); occupied[color(p)] &= ~bit(sq);
    key ^= tables.piece[p][sq]; squares[sq] = -1;
}
void Board::setFen(std::string_view fen) {
    squares.fill(-1); pieces.fill(0); occupied.fill(0); kings.fill(-1);
    key = 0; context = 0; historySize = 0; rights = 0; ep = -1;
    std::istringstream input{std::string(fen)};
    std::string layout, active, castle, target;
    if (!(input >> layout >> active >> castle >> target >> halfmove >> fullmove)) throw std::invalid_argument("Invalid FEN fields");
    int rank = 7, file = 0;
    for (char c : layout) {
        if (c == '/') { if (file != 8 || rank == 0) throw std::invalid_argument("Invalid FEN row"); --rank; file = 0; }
        else if (c >= '1' && c <= '8') file += c - '0';
        else {
            auto p = symbols.find(c);
            if (p == std::string_view::npos || file >= 8) throw std::invalid_argument("Invalid FEN piece");
            put(rank * 8 + file++, static_cast<int>(p));
        }
        if (file > 8) throw std::invalid_argument("Invalid FEN row");
    }
    if (rank != 0 || file != 8 || kings[0] < 0 || kings[1] < 0 || std::popcount(pieces[King]) != 1 || std::popcount(pieces[6+King]) != 1 || halfmove < 0 || fullmove < 1)
        throw std::invalid_argument("Invalid FEN board");
    if (active != "w" && active != "b") throw std::invalid_argument("Invalid FEN side");
    turn = active == "b";
    for (char c : castle) {
        if (c == 'K') rights |= 1; else if (c == 'Q') rights |= 2;
        else if (c == 'k') rights |= 4; else if (c == 'q') rights |= 8;
        else if (c != '-') throw std::invalid_argument("Invalid FEN castling");
    }
    if (target != "-") {
        if (target.size() != 2 || target[0] < 'a' || target[0] > 'h' || target[1] != (turn == 0 ? '6' : '3')) throw std::invalid_argument("Invalid FEN en passant");
        ep = (target[1]-'1')*8+target[0]-'a';
    }
    if ((pieces[Pawn] | pieces[6+Pawn]) & 0xff000000000000ffULL) throw std::invalid_argument("Unpromoted pawn on last rank");
    key = recomputeKey(); history[historySize++] = key;
}
std::string Board::fen() const {
    std::ostringstream s;
    for (int rank = 7; rank >= 0; --rank) {
        int empty = 0;
        for (int file = 0; file < 8; ++file) {
            int p = squares[rank * 8 + file];
            if (p < 0) ++empty;
            else { if (empty) s << empty; empty = 0; s << symbols[p]; }
        }
        if (empty) s << empty;
        if (rank) s << '/';
    }
    s << (turn ? " b " : " w ");
    if (!rights) s << '-';
    for (int i = 0; i < 4; ++i) if (rights & (1 << i)) s << "KQkq"[i];
    s << ' ' << (ep < 0 ? "-" : squareName(ep)) << ' ' << halfmove << ' ' << fullmove;
    return s.str();
}
Bits Board::attacks(int t, int sq, int side) const {
    if (t == Pawn) return tables.pawn[side][sq];
    if (t == Knight) return tables.knight[sq];
    if (t == King) return tables.king[sq];
    return sliders(sq, t, all());
}
bool Board::attacked(int sq, int by) const { return attacked(sq, by, all(), 0); }
bool Board::attacked(int sq, int by, Bits occupancy, Bits excludedPawns) const {
    return (tables.pawn[by ^ 1][sq] & pieces[by*6+Pawn] & ~excludedPawns) ||
        (tables.knight[sq] & pieces[by*6+Knight]) || (tables.king[sq] & pieces[by*6+King]) ||
        (sliders(sq, Bishop, occupancy) & (pieces[by*6+Bishop] | pieces[by*6+Queen])) ||
        (sliders(sq, Rook, occupancy) & (pieces[by*6+Rook] | pieces[by*6+Queen]));
}
std::uint64_t Board::epKey() const {
    if (ep < 0) return 0;
    int captured = ep + (turn ? 8 : -8);
    if (squares[ep] != -1 || squares[captured] != (turn ^ 1)*6+Pawn) return 0;
    Bits pawns = tables.pawn[turn ^ 1][ep] & pieces[turn*6+Pawn];
    while (pawns) {
        int from = pop(pawns);
        if (!attacked(kings[turn], turn ^ 1, (all() ^ bit(from) ^ bit(captured)) | bit(ep), bit(captured))) return tables.ep[ep%8];
    }
    return 0;
}
std::uint64_t Board::recomputeKey() const {
    auto result = tables.castle[rights] ^ (turn ? tables.side : 0) ^ epKey();
    for (int sq = 0; sq < 64; ++sq) if (squares[sq] >= 0) result ^= tables.piece[squares[sq]][sq];
    return result;
}
void Board::pseudo(MoveList& moves, bool capturesOnly) const {
    auto addPawn = [&](int from, int to) {
        if (to/8 == 0 || to/8 == 7) for (int p = 1; p <= 4; ++p) moves.add(Move(from,to,p));
        else moves.add(Move(from,to));
    };
    Bits ours = occupied[turn], enemy = occupied[turn^1] & ~pieces[(turn^1)*6+King], occupancy = all();
    for (int t = Pawn; t <= King; ++t) {
        Bits remaining = pieces[turn*6+t];
        while (remaining) {
            int from = pop(remaining);
            if (t == Pawn) {
                int forward = from + (turn ? -8 : 8);
                if (!(occupancy & bit(forward))) {
                    if (!capturesOnly || forward/8 == 0 || forward/8 == 7) addPawn(from,forward);
                    if (!capturesOnly && from/8 == (turn ? 6 : 1) && !(occupancy & bit(forward + (turn ? -8 : 8)))) moves.add(Move(from,forward+(turn?-8:8)));
                }
                Bits captures = tables.pawn[turn][from] & enemy;
                while (captures) addPawn(from,pop(captures));
                if (ep >= 0 && (tables.pawn[turn][from] & bit(ep)) && squares[ep + (turn ? 8 : -8)] == (turn^1)*6+Pawn && squares[ep] == -1) addPawn(from,ep);
            } else {
                Bits targets = attacks(t,from,turn) & ~ours & ~pieces[(turn^1)*6+King];
                if (capturesOnly) targets &= enemy;
                while (targets) moves.add(Move(from,pop(targets)));
                int base = turn ? 56 : 0, rightsShift = turn*2;
                if (t == King && !capturesOnly && from == base+4 && !attacked(from,turn^1)) {
                    if ((rights & (1<<rightsShift)) && squares[base+7] == turn*6+Rook && !(occupancy & (bit(base+5)|bit(base+6))) && !attacked(base+5,turn^1) && !attacked(base+6,turn^1)) moves.add(Move(from,base+6));
                    if ((rights & (2<<rightsShift)) && squares[base] == turn*6+Rook && !(occupancy & (bit(base+1)|bit(base+2)|bit(base+3))) && !attacked(base+3,turn^1) && !attacked(base+2,turn^1)) moves.add(Move(from,base+2));
                }
            }
        }
    }
}
MoveList Board::legal(bool capturesOnly) {
    MoveList pseudoMoves, result; pseudo(pseudoMoves,capturesOnly);
    for (Move move : pseudoMoves) {
        auto undo = make(move);
        bool valid = !attacked(kings[turn^1],turn);
        unmake(move,undo);
        if (valid) result.add(move);
    }
    return result;
}
bool Board::isCapture(Move move) const {
    return squares[move.to()] >= 0 || (type(squares[move.from()]) == Pawn && move.to() == ep);
}
Undo Board::make(Move move) {
    int from = move.from(), to = move.to(), p = squares[from];
    int capturedSquare = to;
    if (type(p) == Pawn && to == ep && squares[to] == -1) capturedSquare = to + (turn ? 8 : -8);
    Undo undo{key,context,squares[capturedSquare],capturedSquare,rights,ep,halfmove,fullmove};
    key ^= tables.castle[rights] ^ epKey();
    if (undo.captured >= 0) remove(capturedSquare);
    remove(from); put(to,move.promotion() ? turn*6+move.promotion() : p);
    if (type(p) == King) {
        rights &= ~(3 << (turn*2));
        if (std::abs(to-from) == 2) {
            int rookFrom = to > from ? from+3 : from-4, rookTo = to > from ? from+1 : from-1;
            remove(rookFrom); put(rookTo,turn*6+Rook);
        }
    }
    if (from == 0 || to == 0) rights &= ~2;
    if (from == 7 || to == 7) rights &= ~1;
    if (from == 56 || to == 56) rights &= ~8;
    if (from == 63 || to == 63) rights &= ~4;
    ep = type(p) == Pawn && std::abs(to-from) == 16 ? (to+from)/2 : -1;
    halfmove = type(p) == Pawn || undo.captured >= 0 ? 0 : halfmove+1;
    context = halfmove == 0 ? 0 : std::rotl(context,11) ^ undo.key;
    fullmove += turn; turn ^= 1;
    key ^= tables.side ^ tables.castle[rights] ^ epKey();
    if (historySize >= static_cast<int>(history.size())) throw std::runtime_error("History limit exceeded");
    history[historySize++] = key;
    return undo;
}
void Board::unmake(Move move, const Undo& undo) {
    --historySize; turn ^= 1;
    int p = squares[move.to()];
    remove(move.to()); put(move.from(),move.promotion() ? turn*6+Pawn : p);
    if (type(p) == King && std::abs(move.to()-move.from()) == 2) {
        int from = move.from(), rookFrom = move.to() > from ? from+3 : from-4, rookTo = move.to() > from ? from+1 : from-1;
        remove(rookTo); put(rookFrom,turn*6+Rook);
    }
    if (undo.captured >= 0) put(undo.capturedSquare,undo.captured);
    rights = undo.rights; ep = undo.ep; halfmove = undo.halfmove; fullmove = undo.fullmove; key = undo.key; context = undo.context;
}
std::uint64_t Board::searchKey() const { return key ^ std::rotl(context,23) ^ (static_cast<std::uint64_t>(halfmove)*0x9e3779b97f4a7c15ULL); }
bool Board::play(std::string_view uci) {
    Move move = Move::parse(uci);
    if (!move) return false;
    for (Move legalMove : legal()) if (legalMove == move) { make(move); return true; }
    return false;
}
bool Board::repetition(int count) const {
    int seen = 0;
    for (int i = historySize-1; i >= 0 && i >= historySize-1-halfmove; i -= 2) if (history[i] == key && ++seen >= count) return true;
    return false;
}
bool Board::insufficient() const {
    if (pieces[Pawn] | pieces[6+Pawn] | pieces[Rook] | pieces[6+Rook] | pieces[Queen] | pieces[6+Queen]) return false;
    Bits knights = pieces[Knight] | pieces[6+Knight], bishops = pieces[Bishop] | pieces[6+Bishop];
    if (std::popcount(knights|bishops) <= 1) return true;
    constexpr Bits dark = 0xAA55AA55AA55AA55ULL;
    return !knights && (!(bishops & dark) || !(bishops & ~dark));
}
std::uint64_t perft(Board& board, int depth) {
    if (depth == 0) return 1;
    auto moves = board.legal();
    if (depth == 1) return moves.size;
    std::uint64_t nodes = 0;
    for (Move move : moves) { auto undo = board.make(move); nodes += perft(board,depth-1); board.unmake(move,undo); }
    return nodes;
}
}
