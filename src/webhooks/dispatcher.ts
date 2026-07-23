import { prismaWrite as prisma } from '../db';

export type DeliveryStatus = 'pending' | 'delivered' | 'failed' | 'deleted_event';

export interface Delivery {
  id: string;
  eventId: string | null;
  payload: unknown;
  status: DeliveryStatus;
  attempts: number;
  maxAttempts: number;
  createdAt: Date;
}

export async function deliverOnce(
  payload: unknown,
  deliveryId?: string,
): Promise<DeliveryStatus> {
  let event: unknown = payload;

  if (!event && deliveryId) {
    event = await prisma.event.findUnique({ where: { id: deliveryId } });
    if (!event) {
      console.warn(
        `[dispatcher] Delivery ${deliveryId}: retried event not found — marking as deleted_event`,
      );
      return 'deleted_event';
    }
  }

  if (!event) {
    console.warn(`[dispatcher] Delivery ${deliveryId ?? 'unknown'}: no event payload and no deliveryId`);
    return 'failed';
  }

  console.log(`[dispatcher] Delivering event ${deliveryId ?? 'unknown'}`);
  return 'delivered';
}

export async function handleRetry(delivery: Delivery): Promise<DeliveryStatus> {
  if (delivery.attempts >= delivery.maxAttempts) {
    console.warn(
      `[dispatcher] Delivery ${delivery.id}: max retries (${delivery.maxAttempts}) reached, giving up`,
    );
    return 'failed';
  }

  delivery.attempts++;
  return deliverOnce(null, delivery.id);
}
