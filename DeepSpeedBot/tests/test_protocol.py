"""Functional integration tests for the compiled, persistent process and HTTP adapter."""
from __future__ import annotations
import json
import os
import sys
import threading
import time
import unittest
from unittest.mock import patch
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from adapter.engine import Engine
from adapter.arena import ArenaError, Client, budget, validate, play

EXE=ROOT/"build"/("deepspeed.exe" if os.name=="nt" else "deepspeed")


class ProtocolTests(unittest.TestCase):
    def test_all_modes_prefer_mate(self):
        for mode in ("speed","survival","pressure","balanced","adaptive"):
            with self.subTest(mode=mode), Engine(EXE,mode) as engine:
                engine.position([],"7k/8/5KQ1/8/8/8/8/8 w - - 0 1")
                r=engine.think(300000,500,think_ms=100)
                self.assertGreater(r["score_cp"],29000)

    def test_real_multi_branch_hit_is_reused(self):
        with Engine(EXE) as engine:
            engine.position([])
            engine.ponder("multi")
            time.sleep(.25)
            engine.position(["g1f3"])
            r=engine.think(300000,100,side="b")
            self.assertTrue(r["ponder_hit"])
            self.assertTrue(r["ponder_opportunity"])
            self.assertEqual(r["nodes"],0)
            self.assertGreater(r["ponder_nodes"],0)
            self.assertLess(r["elapsed_ms"],20)

    def test_miss_and_fast_switches_do_not_wait_old_search(self):
        with Engine(EXE) as engine:
            for i in range(20):
                engine.position([])
                engine.ponder(("single","multi","adaptive")[i%3])
                started=time.monotonic()
                engine.position(["a2a3"])
                r=engine.think(300000,40,think_ms=5,side="b")
                self.assertFalse(r["ponder_hit"])
                self.assertLess(time.monotonic()-started,.15)
                self.assertTrue(r["move"])

    def test_uci_ponderhit_and_stop(self):
        with Engine(EXE) as engine:
            engine.send("go ponder movetime 50")
            time.sleep(.03)
            engine.send("ponderhit")
            engine.wait("bestmove ",1)
            engine.send("go infinite")
            time.sleep(.02)
            started=time.monotonic()
            engine.stop()
            self.assertLess(time.monotonic()-started,.1)

    def test_hard_deadlines_and_restart(self):
        for _ in range(2):
            with Engine(EXE,single_core=True) as engine:
                for ms in (1,10,30,100):
                    engine.position(["e2e4","e7e5"])
                    started=time.monotonic()
                    r=engine.think(300000,ms,think_ms=ms)
                    self.assertLess(time.monotonic()-started,ms/1000+.08)
                    self.assertTrue(r["move"])

    def test_combined_uci_limits_stop_at_earliest(self):
        with Engine(EXE) as engine:
            for command in ("go depth 64 movetime 10", "go movetime 200 hardtime 10", "go nodes 100000000 hardtime 10"):
                engine.position([])
                started=time.monotonic()
                engine.send(command)
                engine.wait("bestmove ",1)
                self.assertLess(time.monotonic()-started,.1)

    def test_draws_and_mate(self):
        with Engine(EXE) as engine:
            for fen,score in (("7k/6Q1/5K2/8/8/8/8/8 b - - 100 1",-30000),
                              ("7k/5K2/6Q1/8/8/8/8/8 b - - 0 1",0),
                              ("4k3/8/8/8/8/8/8/R3K3 w - - 100 55",0)):
                engine.position([],fen)
                r=engine.think(300000,50)
                self.assertEqual(r["move"],"0000")
                self.assertEqual(r["score_cp"],score)
            engine.position(["g1f3","g8f6","f3g1","f6g8"]*2)
            self.assertEqual(engine.think(300000,50)["move"],"0000")

    def test_invalid_commands_and_config(self):
        with Engine(EXE) as engine:
            engine.send("dmconfig safe_loss_cp 999")
            with self.assertRaises(RuntimeError):
                engine.sync()
            engine.wait("readyok")
            with self.assertRaises(ValueError):
                engine.send("go\nquit")

    def test_tt_preserves_full_width_fixed_depth_scores(self):
        with Engine(EXE) as engine:
            engine.send("dmconfig lmr 0")
            for fen in (None,"r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1"):
                scores=[]
                for enabled in (0,1):
                    engine.send("ucinewgame")
                    engine.send(f"dmconfig tt {enabled}")
                    engine.position([],fen)
                    result=engine.think(300000,5000,depth=3)
                    self.assertEqual(result["depth"],3)
                    scores.append(result["score_cp"])
                self.assertEqual(scores[0],scores[1])


class HttpTests(unittest.TestCase):
    def test_url_and_secret_validation(self):
        game="00000000-0000-0000-0000-000000000000"
        for url in ("http://example.com","https://x:y@example.com","https://example.com/path","https://example.com?x=1"):
            with self.assertRaises(ValueError):
                Client(url,game,"secret")
        for token in ("", "token\r\nInjected: value"):
            with self.assertRaises(ValueError):
                Client("http://127.0.0.1",game,token)

    def test_persistent_http_redirect_error_and_scoped_auth(self):
        received=[]
        class Handler(BaseHTTPRequestHandler):
            protocol_version="HTTP/1.1"
            def do_GET(self):
                received.append((self.path,self.headers.get("Authorization")))
                self.send_response(302)
                self.send_header("Location","https://example.invalid/steal")
                self.send_header("Content-Length","0")
                self.end_headers()
            def do_POST(self):
                received.append((self.path,self.headers.get("Authorization")))
                self.rfile.read(int(self.headers["Content-Length"]))
                body=b'{"error":"secret should not be logged","code":"stale_position"}'
                self.send_response(409)
                self.send_header("Content-Length",str(len(body)))
                self.end_headers(); self.wfile.write(body)
            def log_message(self,*_): pass
        server=ThreadingHTTPServer(("127.0.0.1",0),Handler)
        thread=threading.Thread(target=server.serve_forever,daemon=True); thread.start()
        client=Client(f"http://127.0.0.1:{server.server_port}","00000000-0000-0000-0000-000000000000","secret")
        try:
            with self.assertRaises(ArenaError) as e: client.request()
            self.assertEqual(e.exception.status,302)
            with self.assertRaises(ArenaError) as e: client.request("move",{"move":"e2e4","expectedPly":0})
            self.assertEqual(e.exception.code,"stale_position")
            self.assertNotIn("secret",str(e.exception))
            self.assertEqual(received[0][1],None)
            self.assertEqual(received[1][1],"Bearer secret")
        finally:
            client.close(); server.shutdown(); server.server_close(); thread.join(2)

    def test_budget_uses_rtt_and_monotonic_elapsed(self):
        state={"deadline":5000,"serverNow":4000,"turn":"w","turnStartedAt":3900,"clocks":{"w":10000}}
        remaining,hard=budget(state,time.monotonic()-.1,80,220)
        self.assertEqual(remaining,9900)
        self.assertGreater(hard,590)
        self.assertLessEqual(hard,600)

    def test_protocol_history_validation(self):
        state={"status":"playing","turn":"w","seats":{"w":{"kind":"bot","userId":"owner"}},"moves":[{"uci":"e2e4\nquit"}],"legalMoves":[]}
        with self.assertRaises(ValueError): validate(state,"w")

    def test_lost_post_response_rereads_instead_of_repeating(self):
        events=[]; actions=[]
        active={"status":"playing","turn":"w","seats":{"w":{"kind":"bot","userId":"owner","ready":True}},
                "moves":[],"legalMoves":["e2e4"],"deadline":4000,"serverNow":1000,"turnStartedAt":1000,
                "clocks":{"w":300000,"b":300000},"format":{"initialMs":300000,"incrementMs":0}}
        finished={**active,"status":"finished","turn":"b","legalMoves":[],"moves":[{"uci":"e2e4","san":"e4"}],
                  "result":"1-0","reason":"resignation"}
        class Transport:
            rtt_ms=1
            closed=False
            def request(self,action="",data=None):
                actions.append(action or "get")
                if action=="move": raise ConnectionResetError("Response lost after acceptance")
                return active if len(actions)==1 else finished
            def close(self): self.closed=True
        class Native:
            diagnostics=[]
            def position(self,*_): return {}
            def think(self,*_): return {"move":"e2e4","elapsed_ms":1,"ponder_hit":False}
            def stop(self): pass
            def send(self,*_): pass
            def wait(self,*_): pass
        transport=Transport()
        with patch("adapter.arena.time.sleep"):
            result=play(transport,Native(),"w",events.append)
        self.assertEqual(actions,["get","move","get"])
        self.assertEqual(result["status"],"finished")
        self.assertTrue(transport.closed)
        self.assertEqual(events[-1]["own_moves"],1)

    def test_illegal_native_output_never_reaches_server(self):
        active={"status":"playing","turn":"w","seats":{"w":{"kind":"bot","userId":"owner","ready":True}},
                "moves":[],"legalMoves":["e2e4"],"deadline":4000,"serverNow":1000,"turnStartedAt":1000,
                "clocks":{"w":300000,"b":300000},"format":{"initialMs":300000,"incrementMs":0}}
        class Transport:
            rtt_ms=1
            def request(self,action="",data=None):
                if action: raise AssertionError("Illegal output reached server")
                return active
            def close(self): pass
        class Native:
            diagnostics=[]
            def position(self,*_): return {}
            def think(self,*_): return {"move":"e2e5","elapsed_ms":1}
            def stop(self): pass
        with self.assertRaisesRegex(ValueError,"outside official legalMoves"):
            play(Transport(),Native(),"w",lambda _:None)


if __name__=="__main__": unittest.main()
