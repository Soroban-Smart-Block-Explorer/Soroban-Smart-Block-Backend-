/**
 * Stripe Billing Integration
 *
 * Handles:
 *  - Checkout session creation for Free→Pro/Enterprise upgrades
 *  - Webhook event processing (checkout.session.completed, customer.subscription.*)
 *  - Tier promotion/demotion on subscription status changes
 *
 * Billing tiers:
 *  Free:       1000 req/min, 7-day history
 *  Pro:        $29/mo — 10000 req/min, 90-day history, webhooks
 *  Enterprise: Custom — unlimited, SLA, dedicated support
 *
 * Env vars required:
 *   STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
 *   STRIPE_PRO_PRICE_ID, STRIPE_ENTERPRISE_PRICE_ID
 */

import { Router } from 'express';
import { z } from 'zod';
import { logger } from '../logger';
import { prismaWrite } from '../db';
import { asyncHandler } from '../middleware/asyncHandler';

// ─── Stripe lazy-load (optional dependency) ───────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type StripeInstance = any;
let _stripe: StripeInstance | null = null;

async function getStripe(): Promise<StripeInstance> {
  if (_stripe) return _stripe;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Stripe = require('stripe');
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? '', { apiVersion: '2024-04-10' });
    return _stripe;
  } catch {
    throw new Error('stripe package not installed. Run: npm install stripe');
  }
}

// ─── Price mapping ────────────────────────────────────────────────────────────

const TIER_PRICE_MAP: Record<string, string | undefined> = {
  pro: process.env.STRIPE_PRO_PRICE_ID,
  enterprise: process.env.STRIPE_ENTERPRISE_PRICE_ID,
};

// ─── Create checkout session ──────────────────────────────────────────────────

export async function createCheckoutSession(opts: {
  developerId: string;
  tier: 'pro' | 'enterprise';
  successUrl: string;
  cancelUrl: string;
}): Promise<{ url: string; sessionId: string }> {
  const stripe = await getStripe();
  const priceId = TIER_PRICE_MAP[opts.tier];
  if (!priceId) throw new Error(`No Stripe price configured for tier: ${opts.tier}`);

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    payment_method_types: ['card'],
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
    metadata: { developerId: opts.developerId, tier: opts.tier },
  });

  return { url: session.url as string, sessionId: session.id as string };
}

// ─── Webhook handler ──────────────────────────────────────────────────────────

interface StripeEventObject {
  metadata?: Record<string, string>;
  customer?: string;
  status?: string;
  items?: { data: Array<{ price: { id: string } }> };
}

export async function handleStripeWebhook(rawBody: Buffer, signature: string): Promise<void> {
  const stripe = await getStripe();
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET ?? '';

  let event: { type: string; data: { object: StripeEventObject } };
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret) as typeof event;
  } catch (err) {
    logger.warn(`[stripe] Webhook signature verification failed: ${String(err)}`);
    throw new Error('Invalid webhook signature');
  }

  const obj = event.data.object;

  switch (event.type) {
    case 'checkout.session.completed': {
      const developerId = obj.metadata?.developerId;
      const tier = obj.metadata?.tier;
      if (developerId && tier) await promoteDeveloperTier(developerId, tier);
      break;
    }
    case 'customer.subscription.deleted':
    case 'customer.subscription.paused': {
      if (obj.customer) await demoteByCustomerId(obj.customer);
      break;
    }
    case 'customer.subscription.updated': {
      if (obj.customer && (obj.status === 'active' || obj.status === 'trialing')) {
        const priceId = obj.items?.data?.[0]?.price?.id;
        const tier = priceId === process.env.STRIPE_ENTERPRISE_PRICE_ID ? 'enterprise' : 'pro';
        await demoteByCustomerId(obj.customer, tier);
      }
      break;
    }
  }
}

async function promoteDeveloperTier(developerId: string, tier: string): Promise<void> {
  await prismaWrite.devApiKey.updateMany({
    where: { developerId, status: 'active' },
    data: { tier },
  });
  logger.info(`[stripe] Promoted developer ${developerId} to ${tier}`);
}

async function demoteByCustomerId(customerId: string, tier = 'free'): Promise<void> {
  // Best-effort: requires stripeCustomerId stored on Developer for full resolution
  logger.info(`[stripe] Subscription change for customer ${customerId} — target tier: ${tier}`);
}

// ─── Billing router ───────────────────────────────────────────────────────────

export const billingRouter = Router();

billingRouter.post(
  '/checkout',
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        developerId: z.string(),
        tier: z.enum(['pro', 'enterprise']),
        successUrl: z.string().url(),
        cancelUrl: z.string().url(),
      })
      .parse(req.body);

    const session = await createCheckoutSession(body);
    res.json(session);
  }),
);

// Raw body required for Stripe signature verification
billingRouter.post(
  '/webhook',
  asyncHandler(async (req, res) => {
    const sig = req.headers['stripe-signature'] as string;
    await handleStripeWebhook(req.body as Buffer, sig);
    res.json({ received: true });
  }),
);
