#pragma once
#include "evaluation.hpp"
#include <atomic>
#include <chrono>
#include <functional>
#include <vector>

namespace ds {
using Clock = std::chrono::steady_clock;
std::int64_t ticks();
struct Control {
    std::atomic<bool> stop{false}, ponder{false};
    std::atomic<std::int64_t> deadline{0};
};
struct Statistics {
    std::uint64_t nodes=0, qnodes=0, ttHits=0, cutoffs=0, reductions=0;
    int depth=0;
    double elapsedMs=0;
};
struct Result {
    Move move{};
    int score=0;
    Statistics stats{};
    bool ponderHit=false;
};
struct Limits {
    int timeMs=70, depth=32;
    std::uint64_t nodes=0;
    bool infinite=false;
};
struct TTEntry {
    std::uint64_t key=0;
    Move best{};
    std::int16_t score=0;
    std::int8_t depth=-1;
    std::uint8_t bound=0, age=0;
};
class TranspositionTable {
    std::vector<TTEntry> entries;
    std::uint8_t generation=0;
public:
    explicit TranspositionTable(int mb=32);
    void resize(int mb);
    void clear();
    void newSearch() { ++generation; }
    const TTEntry* probe(std::uint64_t key) const;
    void store(std::uint64_t key,Move move,int score,int depth,int bound);
    std::size_t bytes() const { return entries.size()*sizeof(TTEntry); }
};
class Search {
    TranspositionTable& tt;
    Control& control;
    const Config& config;
    OpponentModel opponent;
    Statistics stats;
    Limits limits;
    std::array<std::array<Move,2>,128> killers{};
    int history[2][64][64]{};
    bool aborted=false;
    int negamax(Board& board,int depth,int alpha,int beta,int ply);
    int quiescence(Board& board,int alpha,int beta,int ply);
    bool cancelled();
    int order(const Board& board,Move move,Move hash,int ply) const;
public:
    Search(TranspositionTable& table,Control& stop,const Config& cfg,const OpponentModel& model={});
    Result run(Board board,Limits requested,const std::function<void(const Result&)>& onDepth={});
    std::vector<std::pair<Move,int>> rank(Board board,int count);
};
}
