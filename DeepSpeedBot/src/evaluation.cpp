#include "deepspeed/evaluation.hpp"
#include <algorithm>
#include <bit>
#include <cmath>
#include <fstream>
#include <sstream>
#include <stdexcept>

namespace ds {
Mode parseMode(const std::string& s) {
    if (s == "speed") return Mode::Speed;
    if (s == "survival") return Mode::Survival;
    if (s == "pressure") return Mode::Pressure;
    if (s == "balanced") return Mode::Balanced;
    if (s == "adaptive") return Mode::Adaptive;
    throw std::invalid_argument("Unknown strategy mode");
}
std::string modeName(Mode m) {
    return std::array{"speed","survival","pressure","balanced","adaptive"}[static_cast<int>(m)];
}
void Config::set(const std::string& name, const std::string& value) {
    if (name == "mode") { mode = parseMode(value); return; }
    std::size_t used = 0;
    int n = std::stoi(value,&used);
    if (used != value.size()) throw std::invalid_argument("Invalid config number");
    auto assign = [&](int& field, int lo, int hi) { if (n < lo || n > hi) throw std::invalid_argument("Config outside bounds: " + name); field = n; };
    auto boolean = [&](bool& field) { if (n != 0 && n != 1) throw std::invalid_argument("Expected 0 or 1"); field = n != 0; };
    if (name == "hash_mb") assign(hashMb,1,256);
    else if (name == "max_depth") assign(maxDepth,1,64);
    else if (name == "branches") assign(branches,1,8);
    else if (name == "ponder_slice_ms") assign(ponderSliceMs,5,250);
    else if (name == "safe_loss_cp") assign(safeLossCp,0,40);
    else if (name == "complexity_cp") assign(complexityCp,0,40);
    else if (name == "longevity_cp") assign(longevityCp,0,40);
    else if (name == "exchange_cp") assign(exchangeCp,0,40);
    else if (name == "risk_cp") assign(riskCp,0,40);
    else if (name == "reserve_ms") assign(reserveMs,50,1000);
    else if (name == "normal_ms") assign(normalMs,1,1000);
    else if (name == "critical_ms") assign(criticalMs,1,2500);
    else if (name == "tt") boolean(useTT);
    else if (name == "lmr") boolean(useLMR);
    else if (name == "complexity") boolean(complexity);
    else if (name == "avoid_exchanges") boolean(avoidExchanges);
    else throw std::invalid_argument("Unknown config option: " + name);
}
void Config::load(const std::string& path) {
    std::ifstream file(path);
    if (!file) throw std::runtime_error("Cannot read configuration");
    std::string line;
    while (std::getline(file,line)) {
        line = line.substr(0,line.find('#'));
        std::replace(line.begin(),line.end(),'=',' ');
        std::istringstream in(line); std::string name,value,extra;
        if (!(in >> name)) continue;
        if (!(in >> value) || (in >> extra)) throw std::invalid_argument("Expected name=value");
        set(name,value);
    }
}
int evaluate(const Board& b) {
    int scores[2]{}, phase = 0;
    constexpr int phaseValue[] = {0,1,1,2,4,0};
    for (int p = 0; p < 12; ++p) phase += std::popcount(b.pieces[p])*phaseValue[type(p)];
    phase = std::min(24,phase);
    for (int side = 0; side < 2; ++side) {
        for (int t = Pawn; t <= King; ++t) {
            Bits pieces = b.pieces[side*6+t];
            while (pieces) {
                int sq = pop(pieces), x = sq%8, y = side ? 7-sq/8 : sq/8;
                int center = 7-(std::abs(2*x-7)+std::abs(2*y-7))/2;
                int mg = 0, eg = 0;
                switch (t) {
                case Pawn: mg = y*5 + center*3; eg = y*y*3 + center*2; break;
                case Knight: mg = center*11 - (y == 0 ? 12 : 0); eg = center*7; break;
                case Bishop: mg = center*5 + y*3; eg = center*5; break;
                case Rook: mg = y == 6 ? 23 : y*2; eg = center*3; break;
                case Queen: mg = center*2 - (y>2 && b.fullmove<8 ? 12 : 0); eg = center*5; break;
                case King: mg = -center*9 - y*9 + ((x == 6 || x == 2) && y == 0 ? 32 : 0); eg = center*12; break;
                }
                scores[side] += VALUES[t] + (mg*phase+eg*(24-phase))/24;
                if (t != Pawn && t != King) scores[side] += std::popcount(b.attacks(t,sq,side)&~b.occupied[side]) * (t == Knight ? 3 : 2);
                if (t == Rook && !(b.pieces[side*6+Pawn] & (0x0101010101010101ULL<<x))) scores[side] += 13;
                if (t == Pawn) {
                    Bits file = 0x0101010101010101ULL<<x;
                    if (std::popcount(b.pieces[side*6+Pawn]&file)>1) scores[side] -= 10;
                    Bits adjacent = (x ? file>>1 : 0) | (x<7 ? file<<1 : 0);
                    if (!(b.pieces[side*6+Pawn]&adjacent)) scores[side] -= 11;
                    Bits front = 0;
                    for (int r = sq/8+(side?-1:1); r>=0 && r<8; r += side?-1:1) front |= (file|adjacent)&(0xffULL<<(r*8));
                    if (!(front & b.pieces[(side^1)*6+Pawn])) scores[side] += y*y*(32-phase)/12;
                }
            }
        }
        if (std::popcount(b.pieces[side*6+Bishop]) >= 2) scores[side] += 28;
        Bits ring = b.attacks(King,b.kings[side],side);
        int shield = std::popcount(ring & b.pieces[side*6+Pawn]);
        scores[side] += shield*10*phase/24;
        Bits enemy = b.occupied[side^1];
        while (enemy) {
            int sq = pop(enemy), t = type(b.squares[sq]);
            int hits = std::popcount(b.attacks(t,sq,side^1)&ring);
            scores[side] -= hits * (t == Queen ? 9 : 4) * phase/24;
        }
    }
    return (scores[b.turn]-scores[b.turn^1])+8;
}
Features features(const Board& b) {
    Features f;
    Bits attack[2]{}, pawnAttacks[2]{};
    int mobility[2]{}, material[2]{}, tension = 0;
    for (int side=0; side<2; ++side) for (int t=Pawn; t<=King; ++t) {
        Bits p = b.pieces[side*6+t];
        material[side] += std::popcount(p)*VALUES[t];
        if (t != Pawn && t != King) f.nonPawn += std::popcount(p);
        while (p) {
            int sq=pop(p); Bits a=b.attacks(t,sq,side);
            attack[side] |= a;
            if (t==Pawn) pawnAttacks[side] |= a;
            if (t != King) mobility[side] += std::popcount(a&~b.occupied[side]);
        }
    }
    // Safe activity, mutual contact, pawn locks and both kings' exposure.
    int safe = std::popcount(attack[0]&~pawnAttacks[1]&~b.occupied[0]) + std::popcount(attack[1]&~pawnAttacks[0]&~b.occupied[1]);
    tension = std::popcount(attack[0]&b.occupied[1]) + std::popcount(attack[1]&b.occupied[0]);
    int locked=std::popcount((b.pieces[Pawn]<<8)&b.pieces[6+Pawn]);
    double exposure=0;
    for (int s=0;s<2;++s) exposure += std::popcount(b.attacks(King,b.kings[s],s)&attack[s^1])/8.0;
    f.mobility=std::clamp(safe/70.0,0.0,1.0);
    f.tension=std::clamp(tension/12.0,0.0,1.0);
    f.kingRisk=std::clamp(exposure/2.0,0.0,1.0);
    f.complexity=std::clamp(.30*f.mobility+.30*f.tension+.20*f.kingRisk+.20*std::min(1.0,locked/4.0),0.0,1.0);
    f.longevity=std::clamp(.65*f.nonPawn/14.0+.25*std::popcount(b.pieces[Pawn]|b.pieces[6+Pawn])/16.0+.10*locked/4.0,0.0,1.0);
    f.materialBalance=material[b.turn]-material[b.turn^1];
    return f;
}
void OpponentModel::observe(double ms,bool check,bool capture,double c,int phase,double remaining) {
    if (!std::isfinite(ms) || ms<0 || !std::isfinite(c)) return;
    ++observations;
    double delta=ms-meanMs, cd=c-complexityMean;
    meanMs += delta/observations; complexityMean += cd/observations;
    m2 += delta*(ms-meanMs); complexityM2 += cd*(c-complexityMean);
    latencyCovariance += delta*(c-complexityMean);
    if (capture) ++captures;
    auto update=[](double& mean,int& n,double v) { mean+=(v-mean)/++n; };
    if (check) update(checkMean,checkCount,ms);
    if (capture) update(captureMean,captureCount,ms);
    if (!capture && !check) update(quietMean,quietCount,ms);
    phase=std::clamp(phase,0,2);
    double* means[]={&openingMean,&middleMean,&endingMean};
    update(*means[phase],phaseCount[phase],ms); remainingMs=std::max(0.0,remaining);
}
double OpponentModel::variance() const { return observations>1 ? m2/(observations-1) : 0; }
double OpponentModel::correlation() const { return observations>2 && m2>0 && complexityM2>0 ? latencyCovariance/std::sqrt(m2*complexityM2) : 0; }
double OpponentModel::pressure() const {
    if (observations<3) return .25;
    double slow=std::clamp((meanMs-60)/700,0.0,1.0);
    double lowClock=std::clamp((45000-remainingMs)/45000,0.0,1.0);
    return std::clamp(.7*slow+.3*lowClock,0.0,1.0);
}
double utility(const Features& before,const Features& after,bool capture,bool draw,const Config& c,const OpponentModel& opponent) {
    if (c.mode==Mode::Speed) return 0;
    double pressure=c.mode==Mode::Adaptive ? opponent.pressure() : c.mode==Mode::Pressure ? 1 : c.mode==Mode::Survival ? .8 : .5;
    double complexity=c.complexity ? c.complexityCp*(after.complexity-before.complexity) : 0;
    double longevity=c.avoidExchanges ? c.longevityCp*(after.longevity-before.longevity)-c.exchangeCp*static_cast<int>(capture) : 0;
    double risk=c.riskCp*std::max(0.0,after.kingRisk-before.kingRisk);
    return pressure*(complexity+longevity)-risk-(draw && opponent.pressure()>.4 ? 20 : 0);
}
int timeBudget(const Board& b,const Config& c,int remaining,int hard,int increment,bool prepared,const OpponentModel&) {
    int safe=std::max(1,hard); // Transport reserve has already been removed by adapter.
    if (prepared) return std::min(5,safe);
    auto f=features(b);
    int desired=c.mode==Mode::Speed ? 18 : c.normalMs;
    desired=static_cast<int>(desired*(.65+f.complexity));
    if (b.inCheck() || f.kingRisk>.45 || std::abs(evaluate(b))>220) desired=c.criticalMs;
    int movesLeft=std::max(25,100-b.fullmove/2);
    int sustainable=std::max(1,remaining/movesLeft+increment/2);
    if (remaining<5000) sustainable=std::max(1,remaining/80);
    return std::clamp(std::min({desired,sustainable,safe}),1,safe);
}
}
