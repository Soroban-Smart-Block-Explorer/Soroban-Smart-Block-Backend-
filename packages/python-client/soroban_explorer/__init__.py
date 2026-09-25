"""Reference Python client for the Soroban Smart Block Explorer API.

Generated operation table + thin ergonomic wrapper; standard library only.
"""

from ._operations import OPERATION_COUNT, OPERATIONS, SPEC_FINGERPRINT, SPEC_VERSION
from .client import DEFAULT_BASE_URL, Client, RequestEvent, __version__
from .errors import (
    ApiError,
    AuthenticationError,
    BadRequestError,
    ConflictError,
    NetworkError,
    NotFoundError,
    PermissionDeniedError,
    RateLimitError,
    RateLimitInfo,
    RequestValidationError,
    ServerError,
    SorobanError,
    TimeoutError,
    UnprocessableError,
)

__all__ = [
    "ApiError",
    "AuthenticationError",
    "BadRequestError",
    "Client",
    "ConflictError",
    "DEFAULT_BASE_URL",
    "NetworkError",
    "NotFoundError",
    "OPERATIONS",
    "OPERATION_COUNT",
    "PermissionDeniedError",
    "RateLimitError",
    "RateLimitInfo",
    "RequestEvent",
    "RequestValidationError",
    "SPEC_FINGERPRINT",
    "SPEC_VERSION",
    "ServerError",
    "SorobanError",
    "TimeoutError",
    "UnprocessableError",
    "__version__",
]
