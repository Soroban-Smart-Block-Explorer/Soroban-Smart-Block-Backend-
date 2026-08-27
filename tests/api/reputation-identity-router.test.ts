/**
 * Tests for Reputation and Identity routers mounting (Issue #833).
 *
 * Verifies:
 * - Reputation router initializes correctly
 * - Identity router initializes correctly
 * - Routers have endpoints defined
 * - Routers are mountable in the Express app
 */

import { describe, it, expect } from 'vitest';
import { Router } from 'express';
import { reputationRouter } from '../../src/api/reputation';
import { identityRouter } from '../../src/api/identity';

describe('Issue #833: Reputation and Identity routers', () => {
  describe('Reputation Router', () => {
    it('should export reputationRouter', () => {
      expect(reputationRouter).toBeDefined();
      expect(typeof reputationRouter === 'function').toBe(true);
    });

    it('should have multiple endpoints defined', () => {
      const stack = reputationRouter.stack || [];
      expect(stack.length).toBeGreaterThan(0);
    });

    it('should have a callable use method for middleware', () => {
      expect(typeof reputationRouter.use).toBe('function');
    });
  });

  describe('Identity Router', () => {
    it('should export identityRouter', () => {
      expect(identityRouter).toBeDefined();
      expect(typeof identityRouter === 'function').toBe(true);
    });

    it('should have identity endpoints defined', () => {
      const stack = identityRouter.stack || [];
      expect(stack.length).toBeGreaterThan(0);
    });

    it('should have a callable use method for middleware', () => {
      expect(typeof identityRouter.use).toBe('function');
    });
  });

  describe('Router mounting requirements', () => {
    it('reputation router should be mountable at /reputation path', () => {
      expect(() => {
        const app = Router();
        app.use('/reputation', reputationRouter);
      }).not.toThrow();
    });

    it('identity router should be mountable at /identity path', () => {
      expect(() => {
        const app = Router();
        app.use('/identity', identityRouter);
      }).not.toThrow();
    });

    it('both routers can be mounted simultaneously', () => {
      expect(() => {
        const app = Router();
        app.use('/reputation', reputationRouter);
        app.use('/identity', identityRouter);
      }).not.toThrow();
    });
  });
});
