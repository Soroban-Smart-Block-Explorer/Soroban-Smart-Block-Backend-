/**
 * Webhook Response Redaction Utility
 * Redacts sensitive data from webhook response bodies to prevent credential leakage
 */

/**
 * Common patterns for secrets that should be redacted
 */
const SECRET_PATTERNS = [
  // API Keys and tokens
  /(?:api[_-]?key|apikey|access[_-]?token|token|bearer)\s*[:=]\s*["']?([^\s"',;}\]]+)/gi,
  // Authorization headers
  /(?:authorization|x-api-key|x-auth-token)\s*[:=]\s*["']?([^\s"',;}\]]+)/gi,
  // Passwords
  /(?:password|passwd|pwd)\s*[:=]\s*["']?([^\s"',;}\]]+)/gi,
  // AWS credentials
  /(?:AKIA|aws_access_key_id|aws_secret_access_key)\s*[:=]\s*["']?([^\s"',;}\]]+)/gi,
  // Database connection strings
  /(?:mongodb|mysql|postgres|postgresql)[\w+:.]*:\/\/[^\s"']+/gi,
  // OAuth tokens
  /(?:oauth|refresh)[_-]?token\s*[:=]\s*["']?([^\s"',;}\]]+)/gi,
  // JWT tokens
  /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  // Private keys
  /-----BEGIN (?:RSA |OPENSSH |ENCRYPTED )?PRIVATE KEY/g,
  // Credit card numbers (basic pattern)
  /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g,
  // Email addresses
  /[\w.-]+@[\w.-]+\.\w+/g,
];

const REDACTED_PLACEHOLDER = '[REDACTED]';

/**
 * Redacts sensitive information from a response body string
 * @param responseBody The response body to redact
 * @returns Redacted response body
 */
export function redactSensitiveData(
  responseBody: string | null | undefined,
): string | null | undefined {
  if (!responseBody || typeof responseBody !== 'string') {
    return responseBody;
  }

  let redacted = responseBody;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, REDACTED_PLACEHOLDER);
  }
  return redacted;
}

/**
 * Determines if a response body contains sensitive data
 * @param responseBody The response body to check
 * @returns true if sensitive data is detected
 */
export function containsSensitiveData(responseBody: string | null | undefined): boolean {
  if (!responseBody || typeof responseBody !== 'string') {
    return false;
  }

  return SECRET_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0; // Reset regex state
    return pattern.test(responseBody);
  });
}

/**
 * Truncates response body to first N characters and optionally redacts it
 * @param responseBody The response body to process
 * @param maxLength Maximum length of the response body
 * @param redact Whether to redact sensitive data
 * @returns Processed response body
 */
export function processResponseBody(
  responseBody: string | null | undefined,
  maxLength: number = 500,
  redact: boolean = true,
): string | null | undefined {
  if (!responseBody) {
    return responseBody;
  }

  let processed = String(responseBody).slice(0, maxLength);
  if (redact) {
    processed = redactSensitiveData(processed) || processed;
  }
  return processed;
}
