"""DX02 — Python client tests against a real local HTTP server (stdlib only).

Run: python -m unittest discover -s packages/python-client/tests
"""

import json
import os
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from soroban_explorer import (  # noqa: E402
    OPERATION_COUNT,
    OPERATIONS,
    AuthenticationError,
    Client,
    NetworkError,
    NotFoundError,
    RateLimitError,
    RequestValidationError,
    ServerError,
    TimeoutError,
)
from soroban_explorer.client import build_request, normalize_base_url, parse_retry_after  # noqa: E402
from soroban_explorer import models  # noqa: E402,F401  (generated models must import)

ROOT = os.path.join(os.path.dirname(__file__), "..", "..", "..")


class _State:
    handler = None
    requests = []


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # silence
        pass

    def _serve(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length).decode() if length else ""
        _State.requests.append((self.command, self.path, dict(self.headers), body))
        status, payload, headers = _State.handler(self.command, self.path, body)
        if status is None:
            return  # simulate a hang/drop
        data = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        self.send_response(status)
        for k, v in {"Content-Type": "application/json", **headers}.items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = _serve


class ClientTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}/api/v1"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        _State.requests = []
        self.sleeps = []

    def client(self, **kw):
        kw.setdefault("sleep", self.sleeps.append)
        return Client(base_url=self.base, **kw)

    # ── parity ──────────────────────────────────────────────────────────────

    def test_covers_every_operation_in_the_surface_manifest(self):
        with open(os.path.join(ROOT, "packages/client/api-surface.json")) as f:
            surface = json.load(f)
        self.assertEqual(OPERATION_COUNT, surface["operationCount"])
        for op_id, op in surface["operations"].items():
            self.assertIn(op_id, OPERATIONS)
            self.assertEqual(OPERATIONS[op_id]["method"], op["method"])
            self.assertEqual(OPERATIONS[op_id]["path"], op["path"])

    def test_every_operation_builds_a_request(self):
        for op_id, spec in OPERATIONS.items():
            path = {p: "x y/z" for p in spec["path_params"]}
            query = {}
            for q in spec["query"]:
                if not q["required"]:
                    continue
                if q.get("enum"):
                    query[q["name"]] = q["enum"][0]
                elif q["type"] in ("integer", "number"):
                    query[q["name"]] = q.get("minimum") or 1
                elif q["type"] == "boolean":
                    query[q["name"]] = True
                elif q["type"] == "array":
                    query[q["name"]] = ["a"]
                else:
                    query[q["name"]] = "a"
            body = {} if spec["body"] == "required" else None
            method, url, _, _ = build_request(op_id, path, query, body)
            self.assertEqual(method, spec["method"])
            self.assertNotIn("{", url, op_id)

    # ── validation ──────────────────────────────────────────────────────────

    def test_validation(self):
        with self.assertRaises(RequestValidationError):
            build_request("getTransactions", query={"limit": "ten"})
        with self.assertRaises(RequestValidationError):
            build_request("getTransactions", query={"limit": 0})
        with self.assertRaises(RequestValidationError):
            build_request("getTransactions", query={"nope": 1})
        with self.assertRaises(RequestValidationError):
            build_request("getTransactionsByHash", path={"hash": ".."})
        _, url, _, _ = build_request("getTransactionsByHash", path={"hash": "../admin"})
        self.assertEqual(url, "/transactions/..%2Fadmin")

    def test_base_url_safety(self):
        for bad in ("file:///etc/passwd", "https://u:p@h.example", "nope"):
            with self.assertRaises(ValueError):
                normalize_base_url(bad)
        self.assertEqual(normalize_base_url("https://h.example/api/v1/?x#y"), "https://h.example/api/v1")
        self.assertNotIn("secret", repr(Client(api_key="secret")))

    def test_retry_after(self):
        self.assertEqual(parse_retry_after("3"), 3.0)
        self.assertEqual(parse_retry_after("Thu, 01 Jan 1970 00:00:10 GMT", now=4.0), 6.0)
        self.assertIsNone(parse_retry_after("garbage"))

    # ── transport ───────────────────────────────────────────────────────────

    def test_success_sends_key_and_emits_event(self):
        _State.handler = lambda m, p, b: (200, {"hash": "h"}, {"X-RateLimit-Remaining": "9"})
        events = []
        out = self.client(api_key="dev_k", on_request=events.append).transactions.get("h")
        self.assertEqual(out, {"hash": "h"})
        headers = _State.requests[0][2]
        self.assertEqual(headers.get("X-Api-Key"), "dev_k")
        self.assertTrue(headers.get("User-Agent").startswith("soroban-explorer-client-py/"))
        self.assertEqual(events[0].rate_limit.remaining, 9)
        self.assertEqual(events[0].operation_id, "getTransactionsByHash")

    def test_error_taxonomy(self):
        for status, cls in ((401, AuthenticationError), (404, NotFoundError), (500, ServerError)):
            _State.handler = lambda m, p, b, s=status: (s, {"error": "nope", "code": "X"}, {"X-Request-Id": "rid"})
            with self.assertRaises(cls) as ctx:
                self.client(max_retries=0).transactions.get("h")
            self.assertEqual((ctx.exception.status, ctx.exception.code, ctx.exception.request_id), (status, "X", "rid"))

    def test_fault_injection_retries_then_succeeds(self):
        calls = {"n": 0}

        def handler(m, p, b):
            calls["n"] += 1
            if calls["n"] == 1:
                return 503, {"error": "down"}, {}
            if calls["n"] == 2:
                return 429, {"error": "slow"}, {"Retry-After": "2"}
            return 200, {"data": []}, {}

        _State.handler = handler
        self.assertEqual(self.client(max_retries=3).transactions.list(), {"data": []})
        self.assertEqual(calls["n"], 3)
        self.assertEqual(self.sleeps[1], 2.0)

    def test_rate_limit_error_after_retries(self):
        _State.handler = lambda m, p, b: (429, {"error": "limited"}, {"Retry-After": "1", "X-RateLimit-Tier": "public"})
        with self.assertRaises(RateLimitError) as ctx:
            self.client(max_retries=1).transactions.list()
        self.assertEqual(ctx.exception.retry_after, 1.0)
        self.assertEqual(ctx.exception.rate_limit.tier, "public")

    def test_no_retry_for_post_5xx(self):
        _State.handler = lambda m, p, b: (503, {"error": "down"}, {})
        with self.assertRaises(ServerError):
            self.client(max_retries=3).call("postWebhooks", body={"url": "https://h.example/x"})
        self.assertEqual(len(_State.requests), 1)

    def test_timeout_and_network_errors(self):
        import time as _t

        def slow(m, p, b):
            _t.sleep(0.5)
            return 200, {}, {}

        _State.handler = slow
        with self.assertRaises(TimeoutError):
            self.client(timeout=0.1, max_retries=0).transactions.list()
        with self.assertRaises(NetworkError):
            Client(base_url="http://127.0.0.1:1/api/v1", max_retries=0).transactions.list()

    def test_paginate_cursor(self):
        def handler(m, p, b):
            cursor = parse_qs(urlsplit(p).query).get("cursor")
            if not cursor:
                return 200, {"data": [1, 2], "hasNext": True, "nextCursor": 10}, {}
            return 200, {"data": [3], "hasNext": False, "nextCursor": None}, {}

        _State.handler = handler
        self.assertEqual(list(self.client().paginate("getTransactions", query={"limit": 2})), [1, 2, 3])

    def test_stream_feed_sse(self):
        payload = b'event: connected\ndata: {"connectionId":"c"}\n\nevent: message\ndata: {"hash":"h"}\n\n'
        _State.handler = lambda m, p, b: (200, payload, {"Content-Type": "text/event-stream"})
        got = list(self.client().stream_feed(["transactions"]))
        self.assertEqual(got, [("connected", {"connectionId": "c"}), ("message", {"hash": "h"})])
        self.assertIn("channels=transactions", _State.requests[0][1])


if __name__ == "__main__":
    unittest.main()
