/**
 * Event Service — encapsulates business logic for contract event listing and retrieval.
 */

import { EventRepository, eventRepository } from '../repositories/event.repository';

export interface EventListFilter {
  contract?: string;
  type?: string;
  topic?: string;
  page?: number;
  limit?: number;
  /** #914 — keyset cursor (event id) for cursor-based pagination. */
  cursor?: string;
}

export interface EventListResult {
  data: any[];
  total: number;
  page: number;
  limit: number;
  /** #914 — pass back as `cursor` to fetch the next page without OFFSET. */
  nextCursor: string | null;
}

export class EventService {
  constructor(private readonly repo: EventRepository = eventRepository) {}

  buildFilterWhere(query: EventListFilter): Record<string, any> {
    return {
      ...(query.contract && { contractAddress: query.contract }),
      ...(query.type && { eventType: query.type }),
      ...(query.topic && { topicSymbol: query.topic }),
    };
  }

  async listEvents(query: EventListFilter): Promise<EventListResult> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where = this.buildFilterWhere(query);

    // #914 — cursor pagination (keyset on id, via composite index) avoids the
    // OFFSET rescan cost of deep pages. `page`/`limit` remains the compatibility
    // shim for existing callers that haven't migrated to `cursor` yet.
    if (query.cursor) {
      const [events, total] = await Promise.all([
        this.repo.findManySummary({ where, cursorId: query.cursor, take: limit }),
        this.repo.count(where),
      ]);
      const nextCursor = events.length === limit ? events[events.length - 1].id : null;
      return { data: events, total, page, limit, nextCursor };
    }

    const skip = (page - 1) * limit;
    const [events, total] = await Promise.all([
      this.repo.findManySummary({ where, skip, take: limit }),
      this.repo.count(where),
    ]);
    const nextCursor = events.length === limit ? events[events.length - 1].id : null;

    return { data: events, total, page, limit, nextCursor };
  }

  async getEventById(id: string): Promise<any | null> {
    return this.repo.findById(id);
  }
}

export const eventService = new EventService();
