import { prismaWrite as prisma } from '../db';
import { logger } from '../logger';
import { eventBus, EventNames } from '../events/eventBus';

export interface FeedMessage {
  channelName: string;
  data: any;
  ledgerSequence: number;
  timestamp: Date;
}

class FeedPublisher {
  private sequenceCounter = 0;

  async publish(message: FeedMessage) {
    try {
      // Increment global sequence counter
      this.sequenceCounter++;

      // Store message in database for persistence
      const storedMessage = await prisma.feedMessage.create({
        data: {
          channelName: message.channelName,
          sequence: this.sequenceCounter,
          data: message.data,
          ledgerSequence: message.ledgerSequence,
          timestamp: message.timestamp,
          indexedAt: new Date(),
        },
      });

      // Publish to the event bus so subscribers across all instances receive it
      await eventBus.publish(EventNames.FeedMessage, {
        ...message,
        sequence: this.sequenceCounter,
        indexedAt: storedMessage.indexedAt,
      });

      return storedMessage;
    } catch (error) {
      logger.error('Failed to publish feed message:', error);
      throw error;
    }
  }

  async getLastSequence(): Promise<number> {
    const lastMessage = await prisma.feedMessage.findFirst({
      orderBy: { sequence: 'desc' },
      select: { sequence: true },
    });

    if (lastMessage) {
      this.sequenceCounter = lastMessage.sequence;
      return lastMessage.sequence;
    }

    return 0;
  }

  async initializeSequence() {
    await this.getLastSequence();
  }
}

export const feedPublisher = new FeedPublisher();
