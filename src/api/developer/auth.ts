import { Router, Request, Response } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { prismaWrite, prismaRead } from '../../db';
import { asyncHandler } from '../../middleware/asyncHandler';

export const authRouter = Router();

const registerSchema = z.object({
  email: z.string().email(),
  name: z.string().optional(),
  password: z.string().min(8),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

const mfaVerifySchema = z.object({
  developerId: z.string(),
  token: z.string().length(6),
});

function hashPassword(password: string): string {
  return crypto.createHash('sha256').update(password).digest('hex');
}

function generateToken(developerId: string): string {
  return crypto
    .createHmac('sha256', process.env.JWT_SECRET ?? 'dev-secret')
    .update(developerId + Date.now())
    .digest('hex');
}

// POST /developer/auth/register
authRouter.post(
  '/register',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { email, name, password } = parsed.data;
    const existing = await prismaRead.developer.findUnique({ where: { email } });
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const developer = await prismaWrite.developer.create({
      data: { email, name, passwordHash: hashPassword(password) },
      select: { id: true, email: true, name: true, role: true, createdAt: true },
    });

    res.status(201).json({ developer, token: generateToken(developer.id) });
  }),
);

// POST /developer/auth/login
authRouter.post(
  '/login',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { email, password } = parsed.data;
    const developer = await prismaRead.developer.findUnique({ where: { email } });
    if (!developer || developer.passwordHash !== hashPassword(password)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (developer.mfaEnabled) {
      return res.json({ requiresMfa: true, developerId: developer.id });
    }

    res.json({
      developer: {
        id: developer.id,
        email: developer.email,
        name: developer.name,
        role: developer.role,
      },
      token: generateToken(developer.id),
    });
  }),
);

// POST /developer/auth/mfa/setup
authRouter.post(
  '/mfa/setup',
  asyncHandler(async (req: Request, res: Response) => {
    const { developerId } = z.object({ developerId: z.string() }).parse(req.body);
    const secret = crypto.randomBytes(20).toString('base64');

    await prismaWrite.developer.update({
      where: { id: developerId },
      data: { mfaSecret: secret, mfaEnabled: false },
    });

    res.json({ secret, message: 'Store this secret and use it to verify MFA setup' });
  }),
);

// POST /developer/auth/mfa/verify
authRouter.post(
  '/mfa/verify',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = mfaVerifySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { developerId, token } = parsed.data;
    const developer = await prismaRead.developer.findUnique({ where: { id: developerId } });
    if (!developer) return res.status(404).json({ error: 'Developer not found' });

    // Simplified MFA token check (production should use TOTP/speakeasy)
    if (!developer.mfaSecret || token.length !== 6) {
      return res.status(400).json({ error: 'Invalid MFA token' });
    }

    await prismaWrite.developer.update({ where: { id: developerId }, data: { mfaEnabled: true } });

    res.json({
      developer: {
        id: developer.id,
        email: developer.email,
        name: developer.name,
        role: developer.role,
      },
      token: generateToken(developer.id),
    });
  }),
);
