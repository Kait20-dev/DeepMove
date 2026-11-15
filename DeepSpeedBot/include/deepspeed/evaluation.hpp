#pragma once
#include "board.hpp"
#include <string>

namespace ds {
constexpr int MATE = 30000, MATE_BOUND = 29000, INF = 32000;
constexpr int VALUES[6] = {100, 320, 335, 500, 950, 0};
enum class Mode { Speed, Survival, Pressure, Balanced, Adaptive };
struct Config {
    Mode mode = Mode::Adaptive;
    int hashMb = 32, maxDepth = 32, branches = 3, ponderSliceMs = 35;
    int safeLossCp = 18, complexityCp = 9, longevityCp = 6, exchangeCp = 7, riskCp = 12;
    int reserveMs = 220, normalMs = 70, criticalMs = 450;
    bool useTT = true, useLMR = true, complexity = true, avoidExchanges = true;
    void set(const std::string& name, const std::string& value);
    void load(const std::string& path);
};
struct Features {
    double complexity = 0, longevity = 0, tension = 0, mobility = 0, kingRisk = 0;
    int nonPawn = 0, materialBalance = 0;
};
struct OpponentModel {
    int observations = 0, captures = 0;
    double meanMs = 0, m2 = 0, checkMean = 0, captureMean = 0, quietMean = 0;
    double openingMean = 0, middleMean = 0, endingMean = 0, complexityMean = 0;
    double latencyCovariance = 0, complexityM2 = 0, remainingMs = 300000;
    int checkCount = 0, captureCount = 0, quietCount = 0, phaseCount[3]{};
    void observe(double ms, bool check, bool capture, double complexity, int phase, double remaining);
    double variance() const;
    double correlation() const;
    double pressure() const;
};
int evaluate(const Board& board);
Features features(const Board& board);
double utility(const Features& before, const Features& after, bool capture, bool draw,
               const Config& config, const OpponentModel& opponent);
int timeBudget(const Board& board, const Config& config, int remainingMs, int hardMs,
               int incrementMs, bool prepared, const OpponentModel& opponent);
Mode parseMode(const std::string& name);
std::string modeName(Mode mode);
}
