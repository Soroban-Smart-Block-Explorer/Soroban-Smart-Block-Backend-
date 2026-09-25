"""Thin ergonomic client over the generated operation table.

Standard library only (``urllib``), so ``pip install`` pulls in nothing else.

    from soroban_explorer import Client
    client = Client(api_key=os.environ.get("SOROBAN_API_KEY"))
    txs = client.transactions.list(limit=5)
    any_op = client.call("getContractsByAddressStats", path={"address": "C..."})
"""

import email.utils
import json
import logging
import random
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Callable, Dict, Iterator, List, Mapping, Optional, Sequence, Tuple, Union

from ._operations import OPERATIONS
from .errors import (
    NetworkError,
    RateLimitInfo,
    RequestValidationError,
    SorobanError,
    TimeoutError,
    error_from_response,
)

__version__ = "1.0.0"
DEFAULT_BASE_URL = "https://api.soroban.network/api/v1"

logger = logging.getLogger("soroban_explorer")

_RETRYABLE_STATUS = {429, 502, 503, 504}
_IDEMPOTENT = {"GET", "HEAD", "PUT", "DELETE", "OPTIONS"}

JSONValue = Union[None, bool, int, float, str, List["JSONValue"], Dict[str, "JSONValue"]]
Scalar = Union[str, int, float, bool]


@dataclass(frozen=True)
class RequestEvent:
    """Emitted once per attempt to ``on_request`` (wire to OpenTelemetry, metrics, logs)."""

    operation_id: Optional[str]
    method: str
    path: str
    attempt: int
    status: Optional[int]
    duration_ms: float
    outcome: str  # success | http_error | network_error | timeout
    will_retry: bool
    request_id: Optional[str]
    rate_limit: RateLimitInfo


def _int(value: Optional[str]) -> Optional[int]:
    try:
        return int(value) if value not in (None, "") else None
    except ValueError:
        return None


def parse_rate_limit(headers: Mapping[str, str]) -> RateLimitInfo:
    lower = {k.lower(): v for k, v in headers.items()}
    return RateLimitInfo(
        limit=_int(lower.get("x-ratelimit-limit")),
        remaining=_int(lower.get("x-ratelimit-remaining")),
        reset=_int(lower.get("x-ratelimit-reset")),
        tier=lower.get("x-ratelimit-tier"),
    )


def parse_retry_after(value: Optional[str], now: Optional[float] = None) -> Optional[float]:
    """Retry-After (delta-seconds or HTTP-date) → seconds."""
    if not value:
        return None
    try:
        return max(0.0, float(value))
    except ValueError:
        pass
    try:
        parsed = email.utils.parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return None
    return max(0.0, parsed.timestamp() - (now if now is not None else time.time()))


def normalize_base_url(raw: str) -> str:
    parts = urllib.parse.urlsplit(raw)
    if parts.scheme not in ("http", "https") or not parts.netloc:
        raise ValueError(f"base_url must be an absolute http(s) URL, got {raw!r}")
    if parts.username or parts.password:
        raise ValueError("base_url must not embed credentials; use api_key")
    return urllib.parse.urlunsplit((parts.scheme, parts.netloc, parts.path.rstrip("/"), "", ""))


def _check_query(spec: Mapping[str, object], value: object) -> Optional[str]:
    name = spec["name"]
    ptype = spec["type"]
    values: Sequence[object] = value if isinstance(value, (list, tuple)) else [value]
    if ptype == "array" and not isinstance(value, (list, tuple)):
        return f"{name} must be a list"
    item_type = (spec.get("item_type") or "string") if ptype == "array" else ptype
    for v in values:
        if item_type == "integer" and (isinstance(v, bool) or not isinstance(v, int)):
            return f"{name} must be an integer"
        if item_type == "number" and (isinstance(v, bool) or not isinstance(v, (int, float))):
            return f"{name} must be a number"
        if item_type == "boolean" and not isinstance(v, bool):
            return f"{name} must be a boolean"
        if item_type == "string" and not isinstance(v, str):
            return f"{name} must be a string"
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            minimum, maximum = spec.get("minimum"), spec.get("maximum")
            if isinstance(minimum, (int, float)) and v < minimum:
                return f"{name} must be >= {minimum}"
            if isinstance(maximum, (int, float)) and v > maximum:
                return f"{name} must be <= {maximum}"
        enum = spec.get("enum")
        if isinstance(enum, tuple) and v not in enum:
            return f"{name} must be one of {', '.join(map(str, enum))}"
    return None


def _fmt(v: object) -> str:
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (list, tuple)):
        return ",".join(_fmt(x) for x in v)
    return str(v)


def build_request(
    operation_id: str,
    path: Optional[Mapping[str, Scalar]] = None,
    query: Optional[Mapping[str, object]] = None,
    body: object = None,
) -> Tuple[str, str, Optional[bytes], Optional[str]]:
    """Validate params against the generated table → (method, path+query, body, content type)."""
    spec = OPERATIONS.get(operation_id)
    if spec is None:
        raise SorobanError(f"Unknown operation: {operation_id}")
    issues: List[str] = []
    url_path = str(spec["path"])
    for name in spec["path_params"]:  # type: ignore[union-attr]
        raw = (path or {}).get(name)
        if raw is None or str(raw) == "":
            issues.append(f"path parameter {name} is required")
            continue
        value = str(raw)
        if value in (".", ".."):
            issues.append(f"path parameter {name} must not be a dot segment")
            continue
        url_path = url_path.replace("{" + name + "}", urllib.parse.quote(value, safe=""))
    query = dict(query or {})
    specs = {q["name"]: q for q in spec["query"]}  # type: ignore[union-attr,index]
    for key in query:
        if key not in specs:
            issues.append(f"unknown query parameter {key}")
    pairs: List[Tuple[str, str]] = []
    for name, qspec in specs.items():
        value = query.get(name)
        if value is None:
            if qspec["required"]:
                issues.append(f"query parameter {name} is required")
            continue
        problem = _check_query(qspec, value)
        if problem:
            issues.append(problem)
        else:
            pairs.append((name, _fmt(value)))
    data: Optional[bytes] = None
    content_type = spec.get("content_type")
    if body is not None:
        if spec["body"] == "none":
            issues.append("this operation does not accept a body")
        elif content_type == "application/json":
            data = json.dumps(body).encode("utf-8")
        else:
            data = str(body).encode("utf-8")
    elif spec["body"] == "required":
        issues.append("request body is required")
    if issues:
        raise RequestValidationError(operation_id, issues)
    qs = urllib.parse.urlencode(pairs)
    return str(spec["method"]), url_path + (f"?{qs}" if qs else ""), data, content_type  # type: ignore[return-value]


class Client:
    """Soroban Smart Block Explorer API client.

    Retries 429/502/503/504 and network errors for idempotent methods (429 for
    all methods) with exponential backoff + jitter, honouring Retry-After.
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = 10.0,
        max_retries: int = 2,
        max_retry_delay: float = 30.0,
        on_request: Optional[Callable[[RequestEvent], None]] = None,
        opener: Optional[urllib.request.OpenerDirector] = None,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.base_url = normalize_base_url(base_url)
        self._api_key = api_key
        self.timeout = timeout
        self.max_retries = max_retries
        self.max_retry_delay = max_retry_delay
        self._on_request = on_request
        self._opener = opener or urllib.request.build_opener()
        self._sleep = sleep
        self.transactions = _Transactions(self)
        self.events = _Events(self)
        self.contracts = _Contracts(self)
        self.tokens = _Tokens(self)
        self.wallets = _Wallets(self)
        self.network = _Network(self)

    def __repr__(self) -> str:  # never print the key
        return f"Client(base_url={self.base_url!r}, api_key={'***' if self._api_key else None})"

    # ── core ─────────────────────────────────────────────────────────────────

    def call(
        self,
        operation_id: str,
        path: Optional[Mapping[str, Scalar]] = None,
        query: Optional[Mapping[str, object]] = None,
        body: object = None,
        headers: Optional[Mapping[str, str]] = None,
    ) -> JSONValue:
        """Call any operation in the OpenAPI spec by operation id."""
        method, url_path, data, content_type = build_request(operation_id, path, query, body)
        return self._request(method, url_path, data, content_type, headers, operation_id)

    def paginate(
        self,
        operation_id: str,
        path: Optional[Mapping[str, Scalar]] = None,
        query: Optional[Mapping[str, object]] = None,
        max_pages: int = 1000,
    ) -> Iterator[JSONValue]:
        """Yield every item across cursor (``nextCursor``) or page (``page``) pagination."""
        spec = OPERATIONS.get(operation_id) or {}
        has_page = any(q["name"] == "page" for q in spec.get("query", ()))  # type: ignore[union-attr,index]
        cursor: object = None
        for page in range(1, max_pages + 1):
            q = dict(query or {})
            if cursor is not None:
                q["cursor"] = cursor
            elif has_page and page > 1:
                q["page"] = page
            res = self.call(operation_id, path=path, query=q)
            items = res if isinstance(res, list) else (res or {}).get("data") if isinstance(res, dict) else None
            if not isinstance(items, list) or not items:
                return
            yield from items
            if isinstance(res, list):
                return
            next_cursor = res.get("nextCursor") if isinstance(res, dict) else None
            if next_cursor is not None:
                cursor = next_cursor
                continue
            if isinstance(res, dict) and res.get("hasNext") is True and has_page and cursor is None:
                continue
            return

    def stream_feed(self, channels: Sequence[str], timeout: Optional[float] = None) -> Iterator[Tuple[str, JSONValue]]:
        """Stream the realtime feed over SSE (``/feed/sse``); yields ``(event, data)``."""
        qs = urllib.parse.urlencode({"channels": ",".join(channels)})
        req = urllib.request.Request(
            f"{self.base_url}/feed/sse?{qs}", headers=self._headers({"Accept": "text/event-stream"})
        )
        try:
            resp = self._opener.open(req, timeout=timeout or self.timeout)
        except urllib.error.HTTPError as err:
            raise self._http_error(err, None) from None
        except (urllib.error.URLError, OSError) as err:
            raise NetworkError(str(err)) from err
        event, data_lines = "message", []
        with resp:
            for raw in resp:
                line = raw.decode("utf-8").rstrip("\r\n")
                if line == "":
                    if data_lines:
                        text = "\n".join(data_lines)
                        try:
                            yield event, json.loads(text)
                        except ValueError:
                            yield event, text
                    event, data_lines = "message", []
                elif line.startswith("event:"):
                    event = line[6:].strip()
                elif line.startswith("data:"):
                    data_lines.append(line[5:].lstrip())

    # ── transport ────────────────────────────────────────────────────────────

    def _headers(self, extra: Optional[Mapping[str, str]] = None) -> Dict[str, str]:
        headers = {"Accept": "application/json", "User-Agent": f"soroban-explorer-client-py/{__version__}"}
        if self._api_key:
            headers["X-Api-Key"] = self._api_key
        headers.update(extra or {})
        return headers

    def _backoff(self, attempt: int, retry_after: Optional[float]) -> float:
        if retry_after is not None:
            return min(retry_after, self.max_retry_delay)
        exp = min(self.max_retry_delay, 0.25 * 2 ** (attempt - 1))
        return exp / 2 + random.random() * exp / 2

    def _http_error(self, err: urllib.error.HTTPError, operation_id: Optional[str]) -> SorobanError:
        text = err.read().decode("utf-8", "replace") if err.fp else ""
        try:
            body: object = json.loads(text) if text else None
        except ValueError:
            body = text
        headers = dict(err.headers.items()) if err.headers else {}
        return error_from_response(
            err.code,
            body,
            parse_rate_limit(headers),
            headers.get("X-Request-Id") or headers.get("x-request-id"),
            parse_retry_after(headers.get("Retry-After") or headers.get("retry-after")),
            operation_id,
        )

    def _emit(self, **kwargs: object) -> None:
        event = RequestEvent(**kwargs)  # type: ignore[arg-type]
        logger.debug("soroban-explorer request", extra={"soroban_event": event})
        if self._on_request:
            try:
                self._on_request(event)
            except Exception:  # noqa: BLE001 - telemetry must never break requests
                logger.warning("on_request hook raised; ignoring", exc_info=True)

    def _request(
        self,
        method: str,
        url_path: str,
        data: Optional[bytes],
        content_type: Optional[str],
        headers: Optional[Mapping[str, str]],
        operation_id: Optional[str],
    ) -> JSONValue:
        extra = dict(headers or {})
        if data is not None:
            extra["Content-Type"] = content_type or "application/json"
        attempt = 0
        while True:
            attempt += 1
            started = time.monotonic()
            req = urllib.request.Request(
                self.base_url + url_path, data=data, method=method, headers=self._headers(extra)
            )
            can_retry = attempt <= self.max_retries
            base = dict(operation_id=operation_id, method=method, path=url_path.split("?")[0], attempt=attempt)
            try:
                with self._opener.open(req, timeout=self.timeout) as resp:
                    text = resp.read().decode("utf-8")
                    hdrs = dict(resp.headers.items())
                    self._emit(
                        **base, status=resp.status, duration_ms=(time.monotonic() - started) * 1000,
                        outcome="success", will_retry=False,
                        request_id=hdrs.get("X-Request-Id") or hdrs.get("x-request-id"),
                        rate_limit=parse_rate_limit(hdrs),
                    )
                    if not text:
                        return None
                    try:
                        return json.loads(text)
                    except ValueError:
                        return text
            except urllib.error.HTTPError as err:
                api_err = self._http_error(err, operation_id)
                retry = can_retry and err.code in _RETRYABLE_STATUS and (method in _IDEMPOTENT or err.code == 429)
                self._emit(
                    **base, status=err.code, duration_ms=(time.monotonic() - started) * 1000,
                    outcome="http_error", will_retry=retry,
                    request_id=getattr(api_err, "request_id", None),
                    rate_limit=getattr(api_err, "rate_limit", RateLimitInfo()),
                )
                if retry:
                    logger.warning("retrying %s %s after HTTP %s (attempt %s)", method, base["path"], err.code, attempt)
                    self._sleep(self._backoff(attempt, getattr(api_err, "retry_after", None)))
                    continue
                raise api_err from None
            except (socket.timeout, TimeoutError) as err:
                retry = can_retry and method in _IDEMPOTENT
                self._emit(**base, status=None, duration_ms=(time.monotonic() - started) * 1000,
                           outcome="timeout", will_retry=retry, request_id=None, rate_limit=RateLimitInfo())
                if retry:
                    self._sleep(self._backoff(attempt, None))
                    continue
                raise TimeoutError(f"Request timed out after {self.timeout} s") from err
            except (urllib.error.URLError, OSError) as err:
                reason = getattr(err, "reason", err)
                is_timeout = isinstance(reason, socket.timeout)
                retry = can_retry and method in _IDEMPOTENT
                self._emit(**base, status=None, duration_ms=(time.monotonic() - started) * 1000,
                           outcome="timeout" if is_timeout else "network_error", will_retry=retry,
                           request_id=None, rate_limit=RateLimitInfo())
                if retry:
                    self._sleep(self._backoff(attempt, None))
                    continue
                if is_timeout:
                    raise TimeoutError(f"Request timed out after {self.timeout} s") from err
                raise NetworkError(str(reason)) from err


# ── curated resources ────────────────────────────────────────────────────────


class _Resource:
    def __init__(self, client: Client) -> None:
        self._c = client


class _Transactions(_Resource):
    def list(self, **query: object) -> JSONValue:
        return self._c.call("getTransactions", query=query)

    def get(self, hash: str) -> JSONValue:  # noqa: A002 - API field name
        return self._c.call("getTransactionsByHash", path={"hash": hash})


class _Events(_Resource):
    def list(self, **query: object) -> JSONValue:
        return self._c.call("getEvents", query=query)

    def get(self, id: str) -> JSONValue:  # noqa: A002 - API field name
        return self._c.call("getEventsById", path={"id": id})


class _Contracts(_Resource):
    def list(self, **query: object) -> JSONValue:
        return self._c.call("getContracts", query=query)

    def get(self, address: str) -> JSONValue:
        return self._c.call("getContractsByAddress", path={"address": address})


class _Tokens(_Resource):
    def list(self, **query: object) -> JSONValue:
        return self._c.call("getTokens", query=query)

    def get(self, address: str) -> JSONValue:
        return self._c.call("getTokensByAddress", path={"address": address})


class _Wallets(_Resource):
    def transactions(self, address: str, **query: object) -> JSONValue:
        return self._c.call("getWalletsByAddressTransactions", path={"address": address}, query=query)

    def events(self, address: str, **query: object) -> JSONValue:
        return self._c.call("getWalletsByAddressEvents", path={"address": address}, query=query)


class _Network(_Resource):
    def status(self) -> JSONValue:
        return self._c.call("getNetwork")
