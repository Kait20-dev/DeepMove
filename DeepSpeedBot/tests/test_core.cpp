#include "deepspeed/engine.hpp"
#include <algorithm>
#include <cmath>
#include <iostream>
#include <stdexcept>
#include <vector>

namespace {
int checks=0;
void check(bool value,const std::string& message) { ++checks; if(!value) throw std::runtime_error(message); }
void hashWalk(ds::Board& board,int depth) {
    auto original=board.fen(); auto key=board.key, context=board.context; int history=board.historySize;
    check(key==board.recomputeKey(),"incremental hash mismatch");
    if(depth) for(auto move:board.legal()) {
        auto undo=board.make(move); hashWalk(board,depth-1); board.unmake(move,undo);
        check(board.fen()==original && board.key==key && board.context==context && board.historySize==history,"unmake is not exact");
    }
}
void sliderTests() {
    constexpr int directions[8][2] = {{1,0},{-1,0},{0,1},{0,-1},{1,1},{-1,1},{1,-1},{-1,-1}};
    std::uint64_t random = 0x542ec81a7f3902d9ULL;
    ds::Board board;
    for (int sample = 0; sample < 256; ++sample) {
        random ^= random << 13; random ^= random >> 7; random ^= random << 17;
        auto occupancy = sample == 0 ? ds::Bits{0} : sample == 1 ? ~ds::Bits{0} : random;
        board.occupied = {occupancy, 0};
        for (int square = 0; square < 64; ++square) for (int t : {ds::Bishop, ds::Rook, ds::Queen}) {
            ds::Bits expected = 0;
            for (int dir = t == ds::Bishop ? 4 : 0; dir < (t == ds::Rook ? 4 : 8); ++dir) {
                int x = square % 8 + directions[dir][0], y = square / 8 + directions[dir][1];
                while (x >= 0 && x < 8 && y >= 0 && y < 8) {
                    auto target = ds::bit(y * 8 + x); expected |= target;
                    if (occupancy & target) break;
                    x += directions[dir][0]; y += directions[dir][1];
                }
            }
            check(board.attacks(t,square,0) == expected,"precomputed slider ray differs from square walk");
        }
    }
}
void moveTests() {
    ds::Board start;
    check(ds::perft(start,1)==20,"start perft 1");
    check(ds::perft(start,2)==400,"start perft 2");
    check(ds::perft(start,3)==8902,"start perft 3");
    check(ds::perft(start,4)==197281,"start perft 4");
    check(ds::perft(start,5)==4865609,"start perft 5");
    ds::Board kiwi("r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1");
    check(ds::perft(kiwi,1)==48,"kiwipete 1");
    check(ds::perft(kiwi,2)==2039,"kiwipete 2");
    check(ds::perft(kiwi,3)==97862,"kiwipete 3");
    check(ds::perft(kiwi,4)==4085603,"kiwipete 4");
    ds::Board tricky("8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1");
    check(ds::perft(tricky,4)==43238,"en passant perft");
    hashWalk(start,2); hashWalk(kiwi,2); hashWalk(tricky,2);
    ds::Board castle("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1");
    check(castle.play("e1g1"),"white castles"); check(castle.squares[5]==ds::Rook,"rook follows king");
    check(castle.play("e8c8"),"black castles"); check(castle.squares[59]==6+ds::Rook,"black rook");
    ds::Board pinnedEp("8/8/8/r4pPK/8/8/8/k7 w - f6 0 1");
    check(!pinnedEp.play("g5f6"),"en passant cannot expose king");
    ds::Board noEp("8/8/8/r4pPK/8/8/8/k7 w - - 0 1");
    check(pinnedEp.key==noEp.key,"illegal en passant does not change repetition identity");
    ds::Board ep("4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1");
    check(ep.play("e5d6") && ep.squares[35]==-1,"legal en passant capture");
    for(char p:std::string("nbrq")) {
        ds::Board promotion("4k3/P7/8/8/8/8/8/4K3 w - - 0 1");
        check(promotion.play(std::string("a7a8")+p),"all promotions");
        check(promotion.key==promotion.recomputeKey(),"promotion hash");
    }
    ds::Board rep;
    for(int i=0;i<2;++i) for(auto m:{"g1f3","g8f6","f3g1","f6g8"}) check(rep.play(m),"repetition move");
    check(rep.repetition(),"threefold repetition");
    ds::Board sameFen(rep.fen());
    check(rep.key==sameFen.key && rep.searchKey()!=sameFen.searchKey(),"TT separates different repetition histories");
    check(ds::Board("4k3/8/8/8/8/8/8/4K3 w - - 0 1").insufficient(),"bare kings draw");
    check(ds::Board("4k3/8/8/8/8/8/8/2B1K3 w - - 0 1").insufficient(),"single minor draw");
    check(!ds::Board("4k3/8/8/8/8/8/8/1NN1K3 w - - 0 1").insufficient(),"two knights not automatic draw");
    check(ds::Board("4k3/8/8/8/8/8/8/R3K3 w - - 100 55").drawn(),"fifty move rule");
    ds::Board mate("7k/6Q1/5K2/8/8/8/8/8 b - - 100 1");
    check(mate.inCheck() && !mate.legal().size,"checkmate before fifty move rule");
    ds::Board stale("7k/5K2/6Q1/8/8/8/8/8 b - - 0 1");
    check(!stale.inCheck() && !stale.legal().size,"stalemate");
}
void searchTests() {
    ds::Config c; ds::Control control; ds::TranspositionTable tt(1);
    ds::Search search(tt,control,c);
    ds::Board b("7k/8/5KQ1/8/8/8/8/8 w - - 0 1");
    auto result=search.run(b,{100,8});
    check(bool(result.move),"search returns move");
    check(b.play(result.move.uci()) && b.inCheck() && !b.legal().size,"chooses mate over style");
    ds::Board start;
    for(int ms:{1,5,20,60}) {
        ds::Search bounded(tt,control,c); auto r=bounded.run(start,{ms,32});
        check(start.play(r.move.uci()),"time-bounded legal move"); start=ds::Board();
        check(r.stats.elapsedMs<ms+50,"deadline overshoot under 50ms");
    }
    control.stop=true;
    ds::Search stopped(tt,control,c); auto fallback=stopped.run(start,{50,32});
    check(start.play(fallback.move.uci()),"cancelled search retains legal fallback");
    ds::OpponentModel model;
    for(int i=1;i<=20;++i) model.observe(i*30,false,i%3==0,i/20.0,1,300000-i*30);
    check(model.correlation()>.99,"measured complexity correlation");
    check(model.variance()>0 && model.observations==20,"opponent statistics");
    check(ds::timeBudget(ds::Board(),c,1000,20,0,false,model)<=20,"time manager hard cap");
    check(ds::timeBudget(ds::Board(),c,1000,200,0,true,model)<=5,"prepared response budget");
    auto f=ds::features(ds::Board()); check(f.complexity>=0 && f.complexity<=1 && f.longevity<=1,"normalized features");
    bool invalid=false; try { c.set("safe_loss_cp","500"); } catch(...) { invalid=true; }
    check(invalid,"unsafe config rejected");
}
}
int main() {
    try { sliderTests(); moveTests(); searchTests(); std::cout<<"PASS "<<checks<<" checks including slider attacks, perft, hashes, draws, mates, cancellation and time management\n"; return 0; }
    catch(const std::exception& e) { std::cerr<<"FAIL "<<e.what()<<'\n'; return 1; }
}
