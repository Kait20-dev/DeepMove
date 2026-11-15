#include "deepspeed/engine.hpp"
#include <iostream>
#include <stdexcept>

int main(int argc,char** argv) {
    try {
        ds::Config config;
        for(int i=1;i<argc;++i) {
            std::string arg=argv[i];
            if(arg=="--help") { std::cout<<"DeepSpeedBot: UCI on stdin/stdout. --mode speed|survival|pressure|balanced|adaptive --config FILE\n"; return 0; }
            if(i+1>=argc) throw std::invalid_argument("Missing argument");
            if(arg=="--mode") config.mode=ds::parseMode(argv[++i]);
            else if(arg=="--config") config.load(argv[++i]);
            else throw std::invalid_argument("Unknown argument");
        }
        ds::Engine engine(config);
        std::string line;
        while(std::getline(std::cin,line)) {
            if(line.size()>65536) { std::cout<<"info string command too large"<<std::endl; continue; }
            try { if(!engine.command(line)) break; }
            catch(const std::exception& e) { std::cout<<"info string error "<<e.what()<<std::endl; }
        }
        return 0;
    } catch(const std::exception& e) { std::cerr<<"DeepSpeedBot: "<<e.what()<<'\n'; return 1; }
}
