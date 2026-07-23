/**
 * Enterprise Error Handling Types
 *
 * Error classification, recovery hints, and structured response types
 * for the global error handling system.
 */

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'AUTH_ERROR'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'EXTERNAL_SERVICE_ERROR'
  | 'INTERNAL_ERROR';

export interface ErrorClassification {
  statusCode: number;
  code: ErrorCode;
  severity: 'low' | 'medium' | 'high' | 'critical';
}

export interface RecoveryHint {
  message: string;
  retryAfter?: number;
  tryAgain?: boolean;
  suggestRefresh?: boolean;
}

export interface StructuredErrorResponse {
  error: string;
  code: ErrorCode;
  requestId: string;
  statusCode: number;
  stack?: string;
  recovery?: RecoveryHint;
}

export const ERROR_CLASSIFICATIONS: Record<string, ErrorClassification> = {
  ValidationError: { statusCode: 400, code: 'VALIDATION_ERROR', severity: 'low' },
  AppError: { statusCode: 400, code: 'VALIDATION_ERROR', severity: 'low' },
  AuthError: { statusCode: 401, code: 'AUTH_ERROR', severity: 'medium' },
  UnauthorizedError: { statusCode: 401, code: 'AUTH_ERROR', severity: 'medium' },
  ForbiddenError: { statusCode: 403, code: 'AUTH_ERROR', severity: 'medium' },
  NotFoundError: { statusCode: 404, code: 'NOT_FOUND', severity: 'low' },
  RateLimitError: { statusCode: 429, code: 'RATE_LIMITED', severity: 'medium' },
  ExternalError: { statusCode: 502, code: 'EXTERNAL_SERVICE_ERROR', severity: 'high' },
  TimeoutError: { statusCode: 504, code: 'EXTERNAL_SERVICE_ERROR', severity: 'high' },
  DatabaseError: { statusCode: 500, code: 'INTERNAL_ERROR', severity: 'critical' },
  RpcError: { statusCode: 500, code: 'EXTERNAL_SERVICE_ERROR', severity: 'high' },
  Error: { statusCode: 500, code: 'INTERNAL_ERROR', severity: 'high' },
};

export function classifyError(err: Error): ErrorClassification {
  const name = err.name;
  return ERROR_CLASSIFICATIONS[name] ?? ERROR_CLASSIFICATIONS['Error'];
}

export function buildRecoveryHint(
  err: Error,
  classification: ErrorClassification,
): RecoveryHint | undefined {
  if (classification.code === 'RATE_LIMITED') {
    return {
      message: 'Rate limit exceeded. Please retry after the specified time.',
      retryAfter: 60,
    };
  }

  const msg = err.message.toLowerCase();
  if (
    msg.includes('database') ||
    msg.includes('connection') ||
    msg.includes('prisma') ||
    (msg.includes('timeout') && msg.includes('db'))
  ) {
    return {
      message: 'Database connectivity issue detected. The system will retry automatically.',
      tryAgain: true,
    };
  }

  if (
    msg.includes('rpc') ||
    msg.includes('timeout') ||
    msg.includes('horizon') ||
    msg.includes('stellar')
  ) {
    return {
      message: 'External service timeout. Please refresh and try again.',
      suggestRefresh: true,
    };
  }

  return undefined;
}
