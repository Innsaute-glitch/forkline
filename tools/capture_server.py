#!/usr/bin/env python3
"""Mock OpenAI endpoint that records each request verbatim and returns a canned reply.
Binds to localhost only. Authorization values are redacted before anything is saved.
Usage: python3 tools/capture_server.py [port]   (default 8787)"""
import json, os, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8787
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "captures")
os.makedirs(OUT, exist_ok=True)
REPLY = "Mock reply from the capture server."
SECRET_HEADERS = {"authorization", "x-api-key", "api-key", "cookie"}
count = len([f for f in os.listdir(OUT) if f.endswith(".json")])


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def send_json(self, obj, code=200):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.cors()
        self.end_headers()
        self.wfile.write(b)

    def record(self, body):
        global count
        count += 1
        headers = {k: ("<redacted>" if k.lower() in SECRET_HEADERS else v) for k, v in self.headers.items()}
        try:
            parsed = json.loads(body) if body else None
        except ValueError:
            parsed = None
        rec = dict(n=count, time=time.time(), method=self.command, path=self.path, headers=headers,
                   json=parsed, raw=None if parsed is not None else body.decode("utf-8", "replace"))
        with open(os.path.join(OUT, f"{count:03d}.json"), "w") as f:
            json.dump(rec, f, indent=2, ensure_ascii=False)
        print(f"#{count} {self.command} {self.path}", flush=True)
        return parsed

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.end_headers()

    def do_GET(self):
        self.record(b"")
        if self.path.rstrip("/").endswith("/models"):
            self.send_json({"object": "list", "data": [{"id": "mock-model", "object": "model", "created": 0, "owned_by": "capture"}]})
        else:
            self.send_json({"status": "capture server running"})

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        req = self.record(body) or {}
        now, model = int(time.time()), req.get("model", "mock-model")
        if req.get("stream"):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.cors()
            self.end_headers()
            base = dict(id="chatcmpl-mock", object="chat.completion.chunk", created=now, model=model)
            for delta, finish in (({"role": "assistant", "content": ""}, None), ({"content": REPLY}, None), ({}, "stop")):
                chunk = dict(base, choices=[dict(index=0, delta=delta, finish_reason=finish)])
                self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
            self.wfile.write(b"data: [DONE]\n\n")
            return
        self.send_json(dict(id="chatcmpl-mock", object="chat.completion", created=now, model=model,
                            choices=[dict(index=0, message=dict(role="assistant", content=REPLY), finish_reason="stop")],
                            usage=dict(prompt_tokens=0, completion_tokens=0, total_tokens=0)))


print(f"capture server on http://127.0.0.1:{PORT}/v1, saving to {OUT}", flush=True)
ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
