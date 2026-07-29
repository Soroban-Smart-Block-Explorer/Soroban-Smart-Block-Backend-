/**
 * Standardized pagination utilities (Issue #655)
 *
 * Provides consistent pagination response format across all list endpoints:
 * {
 *   "data": [...],
 *   "pagination": {
 *     "cursor": "next-cursor-value",
 *     "hasMore": true,
 *     "total": 1000,
 *     "pageSize": 50
 *   }
 * }
 */

export interface PaginationMetadata {
  /** Cursor for fetching the next page (opaque string) */
  cursor?: string | null;
  /** Whether more results are available */
  hasMore: boolean;
  /** Total count of items (if available) */
  total?: number;
  /** Number of items in this page */
  pageSize: number;
  /** Current page number (for offset-based pagination) */
  page?: number;
  /** Total pages (for offset-based pagination) */
  totalPages?: number;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: PaginationMetadata;
}

/**
 * Build a standardized paginated response
 *
 * @param data - Array of items
 * @param pageSize - Number of items in current page
 * @param hasMore - Whether more results exist
 * @param options - Additional pagination metadata
 */
export function createPaginatedResponse<T>(
  data: T[],
  pageSize: number,
  hasMore: boolean,
  options?: {
    cursor?: string | null;
    total?: number;
    page?: number;
    totalPages?: number;
  },
): PaginatedResponse<T> {
  return {
    data,
    pagination: {
      cursor: options?.cursor,
      hasMore,
      total: options?.total,
      pageSize,
      page: options?.page,
      totalPages: options?.totalPages,
    },
  };
}

/**
 * Calculate pagination metadata for offset-based pagination
 */
export function offsetPagination(
  limit: number,
  offset: number,
  total: number,
): PaginationMetadata {
  const page = Math.floor(offset / limit) + 1;
  const totalPages = Math.ceil(total / limit);
  const hasMore = offset + limit < total;

  return {
    hasMore,
    total,
    pageSize: limit,
    page,
    totalPages,
  };
}

/**
 * Calculate pagination metadata for cursor-based pagination
 */
export function cursorPagination(
  limit: number,
  nextCursor: string | null,
  total?: number,
): PaginationMetadata {
  return {
    cursor: nextCursor,
    hasMore: !!nextCursor,
    total,
    pageSize: limit,
  };
}
