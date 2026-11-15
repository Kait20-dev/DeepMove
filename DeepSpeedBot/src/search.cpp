#include "deepspeed/search.hpp"
#include <algorithm>
#include <bit>
#include <cmath>

namespace ds {
std::int64_t ticks() { return std::chrono::duration_cast<std::chrono::nanoseconds>(Clock::now().time_since_epoch()).count(); }
TranspositionTable::TranspositionTable(int mb) { resize(mb); }
void TranspositionTable::resize(int mb) {
    std::size_t size=std::bit_floor(static_cast<std::size_t>(std::clamp(mb,1,256))*1024*1024/sizeof(TTEntry));
    entries.assign(size,{});
}
void TranspositionTable::clear() { std::fill(entries.begin(),entries.end(),TTEntry{}); }
const TTEntry* TranspositionTable::probe(std::uint64_t key) const {
    const auto& e=entries[key&(entries.size()-1)];
    return e.bound && e.key==key ? &e : nullptr;
}
void TranspositionTable::store(std::uint64_t key,Move move,int score,int depth,int bound) {
    auto& e=entries[key&(entries.size()-1)];
    if (e.key==key || e.age!=generation || depth>=e.depth-2) {
        e.key=key; e.best=move; e.score=static_cast<std::int16_t>(score);
        e.depth=static_cast<std::int8_t>(depth); e.bound=static_cast<std::uint8_t>(bound); e.age=generation;
    }
}
Search::Search(TranspositionTable& table,Control& stop,const Config& cfg,const OpponentModel& model)
    :tt(table),control(stop),config(cfg),opponent(model) {}
bool Search::cancelled() {
    if (control.stop.load(std::memory_order_relaxed) || (limits.nodes && stats.nodes>=limits.nodes)) return aborted=true;
    if ((stats.nodes&127)==0 && !control.ponder.load(std::memory_order_relaxed)) {
        auto deadline=control.deadline.load(std::memory_order_relaxed);
        if (deadline && ticks()>=deadline) return aborted=true;
    }
    return false;
}
int Search::order(const Board& b,Move m,Move hash,int ply) const {
    if (m==hash) return 2000000;
    int score=0;
    if (m.promotion()) score+=100000+VALUES[m.promotion()];
    if (b.isCapture(m)) {
        int captured=b.squares[m.to()];
        score+=200000+(captured<0 ? 100 : VALUES[type(captured)])*16-VALUES[type(b.squares[m.from()])];
    } else {
        if (ply<128 && killers[ply][0]==m) score+=90000;
        else if (ply<128 && killers[ply][1]==m) score+=80000;
        score+=history[b.turn][m.from()][m.to()];
    }
    return score;
}
int Search::quiescence(Board& b,int alpha,int beta,int ply) {
    ++stats.nodes; ++stats.qnodes;
    if (cancelled()) return 0;
    bool check=b.inCheck();
    if (ply>=96) return evaluate(b);
    // Generate full evasions in check, including quiet blocks and king moves.
    auto moves=b.legal(!check);
    if (check && !moves.size) return -MATE+ply;
    if (b.drawn()) return 0;
    if (!check) {
        if (!moves.size && !b.legal().size) return 0; // Stalemate isn't stand-pat.
        int stand=evaluate(b);
        if (stand>=beta) return stand;
        alpha=std::max(alpha,stand);
    }
    int scores[256];
    for (int i=0;i<moves.size;++i) scores[i]=order(b,moves.data[i],{},ply);
    for (int i=0;i<moves.size;++i) {
        int best=i;
        for (int j=i+1;j<moves.size;++j) if (scores[j]>scores[best]) best=j;
        std::swap(scores[i],scores[best]); std::swap(moves.data[i],moves.data[best]);
        auto undo=b.make(moves.data[i]);
        int score=-quiescence(b,-beta,-alpha,ply+1);
        b.unmake(moves.data[i],undo);
        if (aborted) return 0;
        if (score>=beta) { ++stats.cutoffs; return score; }
        alpha=std::max(alpha,score);
    }
    return alpha;
}
int Search::negamax(Board& b,int depth,int alpha,int beta,int ply) {
    if (depth<=0) return quiescence(b,alpha,beta,ply);
    ++stats.nodes;
    if (cancelled()) return 0;
    if (ply>=96) return evaluate(b);
    auto moves=b.legal();
    bool check=b.inCheck();
    if (!moves.size) return check ? -MATE+ply : 0;
    if (b.drawn()) return 0;
    auto key=b.searchKey(); Move hash{};
    const auto* entry=config.useTT ? tt.probe(key) : nullptr;
    if (entry) {
        ++stats.ttHits; hash=entry->best;
        int score=entry->score;
        if (score>MATE_BOUND) score-=ply; else if (score<-MATE_BOUND) score+=ply;
        if (entry->depth>=depth && (entry->bound==1 || (entry->bound==2 && score>=beta) || (entry->bound==3 && score<=alpha))) return score;
    }
    int initialAlpha=alpha, bestScore=-INF; Move bestMove{};
    int scores[256]; for(int i=0;i<moves.size;++i) scores[i]=order(b,moves.data[i],hash,ply);
    for (int i=0;i<moves.size;++i) {
        int best=i; for (int j=i+1;j<moves.size;++j) if(scores[j]>scores[best]) best=j;
        std::swap(scores[i],scores[best]); std::swap(moves.data[i],moves.data[best]);
        Move move=moves.data[i]; bool quiet=!b.isCapture(move) && !move.promotion();
        auto undo=b.make(move);
        bool reduce=config.useLMR && i>=4 && depth>=3 && quiet && !check && !b.inCheck() && move!=hash;
        int score;
        if (i==0) score=-negamax(b,depth-1,-beta,-alpha,ply+1);
        else {
            if (reduce) ++stats.reductions;
            score=-negamax(b,depth-1-(reduce?1:0),-alpha-1,-alpha,ply+1);
            if (reduce && score>alpha) score=-negamax(b,depth-1,-alpha-1,-alpha,ply+1);
            if (score>alpha && score<beta) score=-negamax(b,depth-1,-beta,-alpha,ply+1);
        }
        b.unmake(move,undo);
        if (aborted) return 0;
        if (score>bestScore) { bestScore=score; bestMove=move; }
        alpha=std::max(alpha,score);
        if (alpha>=beta) {
            ++stats.cutoffs;
            if (quiet) {
                if (killers[ply][0]!=move) { killers[ply][1]=killers[ply][0]; killers[ply][0]=move; }
                int& h=history[b.turn][move.from()][move.to()]; h=std::min(60000,h+depth*depth);
            }
            break;
        }
    }
    if (config.useTT) {
        int stored=bestScore;
        if (stored>MATE_BOUND) stored+=ply; else if (stored<-MATE_BOUND) stored-=ply;
        tt.store(key,bestMove,stored,depth,bestScore<=initialAlpha?3:bestScore>=beta?2:1);
    }
    return bestScore;
}
Result Search::run(Board board,Limits requested,const std::function<void(const Result&)>& onDepth) {
    auto started=Clock::now(); limits=requested; stats={}; aborted=false; tt.newSearch();
    if (!limits.infinite) control.deadline=ticks()+static_cast<std::int64_t>(std::max(1,limits.timeMs))*1000000;
    auto moves=board.legal(); Result result;
    if (!moves.size || board.drawn()) { result.score=!moves.size && board.inCheck() ? -MATE : 0; return result; }
    result.move=moves.data[0]; result.score=evaluate(board);
    auto before=features(board);
    std::array<int,256> previous{}, scores{};
    std::array<double,256> bonuses{};
    for(int i=0;i<moves.size;++i) {
        bool capture=board.isCapture(moves.data[i]); auto u=board.make(moves.data[i]);
        previous[i]=-evaluate(board); bonuses[i]=utility(before,features(board),capture,board.drawn(),config,opponent);
        board.unmake(moves.data[i],u);
    }
    // Always keep a legal fallback; a single forced move needs no expensive search.
    if (moves.size==1) { result.stats.elapsedMs=std::chrono::duration<double,std::milli>(Clock::now()-started).count(); return result; }
    for(int depth=1;depth<=std::min(limits.depth,config.maxDepth);++depth) {
        for(int i=0;i<moves.size;++i) {
            int best=i; for(int j=i+1;j<moves.size;++j) if(previous[j]>previous[best]) best=j;
            std::swap(previous[i],previous[best]); std::swap(bonuses[i],bonuses[best]); std::swap(moves.data[i],moves.data[best]);
        }
        int bestScore=-INF, bestIndex=0;
        for(int i=0;i<moves.size;++i) {
            auto undo=board.make(moves.data[i]);
            // Exact root scores are needed before a bounded style preference is safe.
            scores[i]=-negamax(board,depth-1,-INF,INF,1);
            board.unmake(moves.data[i],undo);
            if (aborted) break;
            if(scores[i]>bestScore) { bestScore=scores[i]; bestIndex=i; }
        }
        if(aborted) break;
        int selected=bestIndex;
        if(std::abs(bestScore)<MATE_BOUND) for(int i=0;i<moves.size;++i) {
            if(std::abs(scores[i])>=MATE_BOUND || bestScore-scores[i]>config.safeLossCp) continue;
            if (scores[i]+bonuses[i]>scores[selected]+bonuses[selected]) selected=i;
        }
        result.move=moves.data[selected]; result.score=scores[selected]; stats.depth=depth;
        stats.elapsedMs=std::chrono::duration<double,std::milli>(Clock::now()-started).count(); result.stats=stats;
        if(onDepth) onDepth(result);
        previous=scores;
        if (std::abs(result.score)>MATE_BOUND || control.stop || (!control.ponder && !limits.infinite && ticks()>=control.deadline)) break;
    }
    stats.elapsedMs=std::chrono::duration<double,std::milli>(Clock::now()-started).count(); result.stats=stats;
    return result;
}
std::vector<std::pair<Move,int>> Search::rank(Board b,int count) {
    std::vector<std::pair<Move,int>> ranked;
    auto moves=b.legal();
    for(Move move:moves) {
        auto undo=b.make(move); int score=-evaluate(b);
        auto replies=b.legal();
        if(!replies.size) score=b.inCheck()?MATE:0;
        b.unmake(move,undo); ranked.emplace_back(move,score);
    }
    std::stable_sort(ranked.begin(),ranked.end(),[](const auto& a,const auto& b) { return a.second>b.second; });
    if(static_cast<int>(ranked.size())>count) ranked.resize(count);
    return ranked;
}
}
