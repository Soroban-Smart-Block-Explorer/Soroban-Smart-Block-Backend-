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
}

export interface EventListResult {
  data: any[];
  total: number;
  page: number;
  limit: number;
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
    const skip = (page - 1) * limit;
    const where = this.buildFilterWhere(query);

    const [events, total] = await Promise.all([
      this.repo.findManySummary({
        where,
        skip,
        take: limit,
      }),
      this.repo.count(where),
    ]);

    return { data: events, total, page, limit };
  }

  async getEventById(id: string): Promise<any | null> {
    return this.repo.findById(id);
  }
}

export const eventService = new EventService();
