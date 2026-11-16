#pragma once
#include "search.hpp"
#include <mutex>
#include <thread>

namespace ds {
class Engine {
    struct Prepared { std::uint64_t key=0; Result result{}; double spentMs=0; std::uint64_t nodes=0; };
    Config config;
    OpponentModel opponent;
    Board position;
    TranspositionTable tt;
    Control control;
    std::thread worker;
    std::mutex outputMutex;
    std::vector<Prepared> prepared;
    bool wasPondering=false;
    int ponderBudgetMs=70;
    std::atomic<bool> suppressBest{false};
    std::function<void(const std::string&)> output;
    void emit(const std::string& line);
    void stop(bool report);
    void think(Limits limits,bool ponder,int remaining,int hard,int increment);
    void prepare(const std::string& strategy);
public:
    explicit Engine(Config cfg={},std::function<void(const std::string&)> out={});
    ~Engine();
    bool command(const std::string& line);
    void error(const std::string& message) { emit("info string error "+message); }
};
std::string resultJson(const Result& result,const std::string& mode,double ponderMs=0,std::uint64_t ponderNodes=0);
}
