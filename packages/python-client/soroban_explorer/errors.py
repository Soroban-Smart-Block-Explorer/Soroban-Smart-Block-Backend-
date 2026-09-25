"""Error taxonomy (mirrors the TypeScript SDK).

SorobanError
├── RequestValidationError    bad params; request not sent
├── NetworkError              transport failure
├── TimeoutError              no response within ``timeout``
└── ApiError                  non-2xx response
    ├── BadRequestError       400
    ├── AuthenticationError   401
    ├── PermissionDeniedError 403
    ├── NotFoundError         404
    ├── ConflictError         409
    ├── UnprocessableError    422
    ├── RateLimitError        429 (retry_after seconds)
    └── ServerError           5xx
"""

from dataclasses import dataclass, field
from typing import Dict, List, Optional


@dataclass(frozen=True)
class RateLimitInfo:
    limit: Optional[int] = None
    remaining: Optional[int] = None
    reset: Optional[int] = None
    tier: Optional[str] = None


class SorobanError(Exception):
    """Base class for every error raised by the client."""


class RequestValidationError(SorobanError):
    def __init__(self, operation_id: str, issues: List[str]) -> None:
        super().__init__(f"Invalid parameters for {operation_id}: {'; '.join(issues)}")
        self.operation_id = operation_id
        self.issues = issues


class NetworkError(SorobanError):
    pass


class TimeoutError(SorobanError):  # noqa: A001 - intentional, namespaced by the package
    pass


@dataclass
class _ApiErrorData:
    status: int
    message: str
    code: Optional[str] = None
    request_id: Optional[str] = None
    body: object = None
    rate_limit: RateLimitInfo = field(default_factory=RateLimitInfo)
    operation_id: Optional[str] = None


class ApiError(SorobanError):
    def __init__(self, data: _ApiErrorData) -> None:
        super().__init__(data.message)
        self.status = data.status
        self.code = data.code
        self.request_id = data.request_id
        self.body = data.body
        self.rate_limit = data.rate_limit
        self.operation_id = data.operation_id


class BadRequestError(ApiError):
    pass


class AuthenticationError(ApiError):
    pass


class PermissionDeniedError(ApiError):
    pass


class NotFoundError(ApiError):
    pass


class ConflictError(ApiError):
    pass


class UnprocessableError(ApiError):
    pass


class ServerError(ApiError):
    pass


class RateLimitError(ApiError):
    def __init__(self, data: _ApiErrorData, retry_after: Optional[float]) -> None:
        super().__init__(data)
        self.retry_after = retry_after


_BY_STATUS: Dict[int, type] = {
    400: BadRequestError,
    401: AuthenticationError,
    403: PermissionDeniedError,
    404: NotFoundError,
    409: ConflictError,
    422: UnprocessableError,
}


def _pick(body: object, key: str) -> Optional[str]:
    if isinstance(body, dict):
        value = body.get(key)
        if isinstance(value, str):
            return value
        if isinstance(value, dict) and isinstance(value.get("message"), str):
            return value["message"]
    return None


def error_from_response(
    status: int,
    body: object,
    rate_limit: RateLimitInfo,
    request_id: Optional[str],
    retry_after: Optional[float],
    operation_id: Optional[str] = None,
) -> ApiError:
    message = (
        _pick(body, "error")
        or _pick(body, "message")
        or (body[:200] if isinstance(body, str) and body else f"HTTP {status}")
    )
    data = _ApiErrorData(
        status=status,
        message=message,
        code=_pick(body, "code"),
        request_id=request_id,
        body=body,
        rate_limit=rate_limit,
        operation_id=operation_id,
    )
    if status == 429:
        return RateLimitError(data, retry_after)
    if status >= 500:
        return ServerError(data)
    cls = _BY_STATUS.get(status, ApiError)
    return cls(data)
