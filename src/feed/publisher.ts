import { EventEmitter } from 'events';
import { prisma } from '../db';

export interface FeedMessage {
  channelName: string;
  data: any;
  ledgerSequence: number;
  timestamp: Date;
}

class FeedPublisher extends EventEmitter {
  private sequenceCounter = BigInt(0);

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

      // Emit to real-time subscribers
      this.emit('message', {
        ...message,
        sequence: this.sequenceCounter,
        indexedAt: storedMessage.indexedAt,
      });

      return storedMessage;
    } catch (error) {
      console.error('Failed to publish feed message:', error);
      throw error;
    }
  }

  async getLastSequence(): Promise<bigint> {
    const lastMessage = await prisma.feedMessage.findFirst({
      orderBy: { sequence: 'desc' },
      select: { sequence: true },
    });

    if (lastMessage) {
      this.sequenceCounter = lastMessage.sequence;
      return lastMessage.sequence;
    }

    return BigInt(0);
  }

  async initializeSequence() {
    await this.getLastSequence();
  }
}

export const feedPublisher = new FeedPublisher();
