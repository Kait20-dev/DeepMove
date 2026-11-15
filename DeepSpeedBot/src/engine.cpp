#include "deepspeed/engine.hpp"
#include <algorithm>
#include <cmath>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <stdexcept>

namespace ds {
std::string resultJson(const Result& r,const std::string& mode,double ponderMs,std::uint64_t ponderNodes) {
    std::ostringstream s; s<<std::fixed<<std::setprecision(3);
    s<<"{\"move\":\""<<r.move.uci()<<"\",\"score_cp\":"<<r.score<<",\"mode\":\""<<mode
     <<"\",\"depth\":"<<r.stats.depth<<",\"nodes\":"<<r.stats.nodes<<",\"qnodes\":"<<r.stats.qnodes
     <<",\"tt_hits\":"<<r.stats.ttHits<<",\"cutoffs\":"<<r.stats.cutoffs<<",\"reductions\":"<<r.stats.reductions
     <<",\"elapsed_ms\":"<<r.stats.elapsedMs<<",\"nps\":"<<static_cast<std::uint64_t>(r.stats.nodes*1000/std::max(.001,r.stats.elapsedMs))
     <<",\"ponder_hit\":"<<(r.ponderHit?"true":"false")<<",\"ponder_ms\":"<<ponderMs<<",\"ponder_nodes\":"<<ponderNodes<<"}";
    return s.str();
}
Engine::Engine(Config cfg,std::function<void(const std::string&)> out)
    :config(cfg),tt(cfg.hashMb),output(std::move(out)) {
    if(!output) output=[](const std::string& line) { std::cout<<line<<std::endl; };
}
Engine::~Engine() { stop(false); }
void Engine::emit(const std::string& line) { std::lock_guard lock(outputMutex); output(line); }
void Engine::stop(bool report) {
    suppressBest=!report; control.stop=true;
    if(worker.joinable()) worker.join();
}
void Engine::think(Limits limits,bool ponder,int remaining,int hard,int increment) {
    stop(false); control.stop=false; control.ponder=ponder; suppressBest=false;
    const auto board=position;
    Prepared hit{}; bool found=false;
    for(const auto& p:prepared) if(p.key==board.searchKey() && p.result.stats.depth>=2) {
        bool legal=false; auto copy=board;
        for(Move move:copy.legal()) if(move==p.result.move) legal=true;
        if(legal && (!found || p.result.stats.depth>hit.result.stats.depth)) { hit=p; found=true; }
    }
    bool opportunity=wasPondering; wasPondering=false;
    if (limits.timeMs<0) limits.timeMs=timeBudget(board,config,remaining,hard,increment,found,opponent);
    ponderBudgetMs=std::max(1,limits.timeMs);
    auto effectiveConfig=config; auto model=opponent;
    worker=std::thread([this,board,limits,ponder,hit,found,opportunity,effectiveConfig,model]() {
        auto started=Clock::now(); Result result;
        if(found && !ponder) {
            result=hit.result; result.ponderHit=true;
            result.stats.nodes=0; result.stats.qnodes=0; result.stats.ttHits=0; result.stats.cutoffs=0; result.stats.reductions=0;
            result.stats.elapsedMs=std::chrono::duration<double,std::milli>(Clock::now()-started).count();
        } else {
            Search search(tt,control,effectiveConfig,model);
            result=search.run(board,limits,[this](const Result& r) {
                std::ostringstream s;
                s<<"info depth "<<r.stats.depth<<" score ";
                if(std::abs(r.score)>MATE_BOUND) s<<"mate "<<(r.score>0?(MATE-r.score+1)/2:-(MATE+r.score+1)/2);
                else s<<"cp "<<r.score;
                s<<" nodes "<<r.stats.nodes<<" time "<<static_cast<int>(r.stats.elapsedMs)<<" pv "<<r.move.uci();
                emit(s.str());
            });
        }
        // UCI ponder/infinite must wait for stop or ponderhit even at mate/max depth.
        while(!control.stop && (control.ponder || limits.infinite)) std::this_thread::sleep_for(std::chrono::milliseconds(1));
        if(!suppressBest) {
            emit("info string dmresult "+resultJson(result,modeName(effectiveConfig.mode),found?hit.spentMs:0,found?hit.nodes:0));
            emit(std::string("info string dmopportunity ")+(opportunity?"1":"0"));
            emit("bestmove "+result.move.uci());
        }
    });
}
void Engine::prepare(const std::string& strategy) {
    if(strategy!="single" && strategy!="multi" && strategy!="adaptive") throw std::invalid_argument("Unknown ponder strategy");
    stop(false); control.stop=false; control.ponder=false; suppressBest=true; wasPondering=true;
    prepared.clear(); auto board=position; auto cfg=config; auto model=opponent;
    worker=std::thread([this,board,strategy,cfg,model]() mutable {
        auto started=Clock::now(); Search ranker(tt,control,cfg,model);
        auto candidates=ranker.rank(board,strategy=="single"?1:cfg.branches);
        struct Branch { Board board; double probability,complexity; int visits=0; };
        std::vector<Branch> branches;
        double maxScore=candidates.empty()?0:candidates.front().second;
        for(auto [move,score]:candidates) {
            auto child=board; child.make(move);
            if(child.drawn() || child.legal().size==0) continue;
            branches.push_back({child,std::exp(std::max(-8.0,(score-maxScore)/80.0)),features(child).complexity,0});
            prepared.push_back({child.searchKey(),{}});
        }
        std::uint64_t totalNodes=0; int round=0;
        while(!control.stop && !branches.empty()) {
            int selected=round++%static_cast<int>(branches.size());
            if(strategy=="adaptive") {
                double best=-1;
                for(int i=0;i<static_cast<int>(branches.size());++i) {
                    double priority=branches[i].probability*(1+branches[i].complexity)/(1+branches[i].visits);
                    if(priority>best) { best=priority; selected=i; }
                }
            }
            auto& branch=branches[selected]; ++branch.visits;
            Limits limits; limits.timeMs=cfg.ponderSliceMs; limits.depth=cfg.maxDepth;
            Search search(tt,control,cfg,model); auto result=search.run(branch.board,limits);
            auto& cache=prepared[selected]; cache.spentMs+=result.stats.elapsedMs; cache.nodes+=result.stats.nodes; totalNodes+=result.stats.nodes;
            if(result.stats.depth>=cache.result.stats.depth && result.move) cache.result=result;
            // A forced answer or a proven mate can finish before a whole slice.
            if(result.stats.elapsedMs<1) std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
        double ms=std::chrono::duration<double,std::milli>(Clock::now()-started).count();
        std::ostringstream s; s<<"info string dmponder {\"elapsed_ms\":"<<ms<<",\"nodes\":"<<totalNodes<<",\"branches\":"<<branches.size()<<",\"cycles\":"<<round<<"}";
        emit(s.str());
    });
}
bool Engine::command(const std::string& line) {
    std::istringstream in(line); std::string cmd; in>>cmd;
    if(cmd=="quit") { stop(false); return false; }
    if(cmd=="uci") {
        emit("id name DeepSpeedBot 0.1.0"); emit("id author DeepMove contributors (original engine)");
        emit("option name Hash type spin default 32 min 1 max 256");
        emit("option name Threads type spin default 1 min 1 max 1");
        emit("option name Ponder type check default true");
        emit("option name Mode type combo default adaptive var speed var survival var pressure var balanced var adaptive");
        emit("uciok");
    } else if(cmd=="isready") emit("readyok");
    else if(cmd=="stop") stop(true);
    else if(cmd=="ponderhit") { control.deadline=ticks()+static_cast<std::int64_t>(ponderBudgetMs)*1000000; control.ponder=false; }
    else if(cmd=="ucinewgame") { stop(false); tt.clear(); prepared.clear(); opponent={}; wasPondering=false; position=Board(); }
    else if(cmd=="setoption") {
        stop(false); std::string word,name,value;
        in>>word>>name>>word>>value;
        if(name=="Hash") { config.set("hash_mb",value); tt.resize(config.hashMb); }
        else if(name=="Mode") config.set("mode",value);
        else if(name=="Threads" && value!="1") throw std::invalid_argument("Only one search worker is supported");
    } else if(cmd=="dmconfig") {
        stop(false); std::string name,value; in>>name>>value;
        config.set(name,value); if(name=="hash_mb") tt.resize(config.hashMb); prepared.clear();
    } else if(cmd=="position") {
        stop(false); std::string token; in>>token;
        Board next;
        if(token=="fen") {
            std::string fen,field;
            for(int i=0;i<6;++i) { if(!(in>>field)) throw std::invalid_argument("Incomplete FEN"); if(i) fen+=' '; fen+=field; }
            next.setFen(fen); in>>token;
        } else if(token=="startpos") in>>token;
        else throw std::invalid_argument("Expected startpos or fen");
        if(token=="moves") while(in>>token) {
            if(next.historySize>1500) throw std::invalid_argument("Move history limit exceeded");
            if(!next.play(token)) throw std::invalid_argument("Illegal position move");
        }
        position=next;
    } else if(cmd=="dmponder") {
        std::string strategy="adaptive"; in>>strategy; prepare(strategy);
    } else if(cmd=="dmobserve") {
        stop(false); double ms,c,remaining; int check,capture,phase;
        if(!(in>>ms>>check>>capture>>c>>phase>>remaining) || !std::isfinite(remaining)) throw std::invalid_argument("Invalid observation");
        opponent.observe(ms,check!=0,capture!=0,c,phase,remaining);
    } else if(cmd=="dmfeatures") {
        auto f=features(position); std::ostringstream s;
        s<<"info string dmfeatures {\"complexity\":"<<f.complexity<<",\"longevity\":"<<f.longevity<<",\"phase\":"<<(f.nonPawn>10?0:f.nonPawn>4?1:2)<<",\"check\":"<<(position.inCheck()?"true":"false")<<"}"; emit(s.str());
    } else if(cmd=="dmmodel") {
        std::ostringstream s;
        s<<"info string dmmodel {\"observations\":"<<opponent.observations<<",\"mean_ms\":"<<opponent.meanMs<<",\"variance_ms2\":"<<opponent.variance()<<",\"complexity_correlation\":"<<opponent.correlation()<<",\"captures\":"<<opponent.captures<<",\"check_mean_ms\":"<<opponent.checkMean<<",\"capture_mean_ms\":"<<opponent.captureMean<<",\"quiet_mean_ms\":"<<opponent.quietMean<<",\"opening_mean_ms\":"<<opponent.openingMean<<",\"middle_mean_ms\":"<<opponent.middleMean<<",\"ending_mean_ms\":"<<opponent.endingMean<<"}"; emit(s.str());
    } else if(cmd=="go") {
        Limits limits; limits.timeMs=-1; int remaining=300000,hard=std::max(1,3000-config.reserveMs),increment=0;
        bool ponder=false, depthOrNodes=false, explicitTime=false, explicitHard=false; std::string word;
        while(in>>word) {
            if(word=="ponder") ponder=true;
            else if(word=="infinite") limits.infinite=true;
            else {
                std::string value; if(!(in>>value)) throw std::invalid_argument("Missing go value");
                auto n=std::stoll(value);
                if(n<0 || n>1000000000) throw std::invalid_argument("Invalid go value");
                if(word=="movetime") { limits.timeMs=std::max(1,static_cast<int>(n)); explicitTime=true; }
                else if(word=="depth") { limits.depth=std::clamp(static_cast<int>(n),1,64); depthOrNodes=true; }
                else if(word=="nodes") { limits.nodes=std::max<std::int64_t>(1,n); depthOrNodes=true; }
                else if(word=="hardtime") { hard=std::max(1,static_cast<int>(n)); explicitHard=true; }
                else if((word=="wtime" && position.turn==0) || (word=="btime" && position.turn==1)) remaining=n;
                else if((word=="winc" && position.turn==0) || (word=="binc" && position.turn==1)) increment=n;
            }
        }
        // Multiple finite limits mean stop at the earliest one. go infinite is separate.
        if(depthOrNodes && !explicitTime) limits.timeMs=explicitHard?hard:1000000000;
        if(explicitHard && limits.timeMs>hard) limits.timeMs=hard;
        think(limits,ponder,remaining,hard,increment);
    } else if(cmd=="perft") {
        stop(false); int depth=0; in>>depth;
        if(depth<0 || depth>7) throw std::invalid_argument("perft depth 0..7");
        auto board=position; emit("info string perft "+std::to_string(perft(board,depth)));
    } else if(cmd=="dmlegal") {
        auto b=position; std::string s="info string dmlegal";
        for(auto move:b.legal()) s+=' '+move.uci();
        emit(s);
    } else if(cmd=="d") emit("info string fen "+position.fen());
    else if(!cmd.empty()) emit("info string unknown command");
    return true;
}
}
