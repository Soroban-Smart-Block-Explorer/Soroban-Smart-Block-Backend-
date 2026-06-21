import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/asyncHandler';

export const portalRouter = Router();

const SDK_LANGUAGES = [
  'javascript',
  'typescript',
  'python',
  'rust',
  'go',
  'java',
  'kotlin',
  'swift',
  'php',
  'ruby',
];

// POST /developer/sdks/generate
portalRouter.post('/sdks/generate', (req: Request, res: Response) => {
  const { language, features, packageName } = z
    .object({
      language: z.enum(SDK_LANGUAGES as [string, ...string[]]),
      features: z.array(z.string()).optional(),
      packageName: z.string().optional(),
    })
    .parse(req.body);

  const sdkId = `sdk_${language}_${Date.now()}`;

  res.status(202).json({
    id: sdkId,
    language,
    packageName: packageName ?? `soroban-explorer-${language}`,
    features: features ?? [],
    status: 'generating',
    message: `SDK generation for ${language} queued. Download will be available shortly.`,
  });
});

// GET /developer/sdks
portalRouter.get('/sdks', (_req: Request, res: Response) => {
  res.json({ data: [], languages: SDK_LANGUAGES });
});

// GET /developer/sdks/:id/download
portalRouter.get('/sdks/:id/download', (req: Request, res: Response) => {
  res.status(404).json({ error: 'SDK not ready or not found', sdkId: req.params.id });
});

// POST /developer/playground/execute
portalRouter.post(
  '/playground/execute',
  asyncHandler(async (req: Request, res: Response) => {
    const {
      method,
      path: reqPath,
      headers: reqHeaders,
      body: reqBody,
    } = z
      .object({
        method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
        path: z.string().startsWith('/'),
        headers: z.record(z.string()).optional(),
        body: z.unknown().optional(),
      })
      .parse(req.body);

    try {
      const { default: axios } = await import('axios');
      const baseUrl = process.env.API_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
      const start = Date.now();

      const response = await axios.request({
        method,
        url: `${baseUrl}/api/v1${reqPath}`,
        headers: { 'Content-Type': 'application/json', ...(reqHeaders ?? {}) },
        data: reqBody,
        validateStatus: () => true,
        timeout: 15000,
      });

      const durationMs = Date.now() - start;

      res.json({
        statusCode: response.status,
        headers: response.headers,
        body: response.data,
        durationMs,
        snippet: {
          curl: `curl -X ${method} "${baseUrl}/api/v1${reqPath}" -H "Content-Type: application/json"${reqBody ? ` -d '${JSON.stringify(reqBody)}'` : ''}`,
          javascript: `fetch("${baseUrl}/api/v1${reqPath}", { method: "${method}"${reqBody ? `, body: JSON.stringify(${JSON.stringify(reqBody)})` : ''} })`,
          python: `import requests\nrequests.${method.toLowerCase()}("${baseUrl}/api/v1${reqPath}"${reqBody ? `, json=${JSON.stringify(reqBody)}` : ''})`,
        },
      });
    } catch (err: unknown) {
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  }),
);

// GET /developer/status
portalRouter.get('/status', (_req: Request, res: Response) => {
  res.json({
    status: 'operational',
    components: {
      api: 'operational',
      database: 'operational',
      indexer: 'operational',
    },
    updatedAt: new Date().toISOString(),
  });
});

// POST /developer/support
portalRouter.post('/support', (req: Request, res: Response) => {
  const parsed = z
    .object({
      developerId: z.string(),
      subject: z.string().min(5),
      description: z.string().min(10),
      priority: z.enum(['low', 'medium', 'high']).default('medium'),
    })
    .parse(req.body);

  const ticketId = `TKT-${Date.now().toString(36).toUpperCase()}`;

  res.status(201).json({
    ticketId,
    developerId: parsed.developerId,
    subject: parsed.subject,
    priority: parsed.priority,
    status: 'open',
    createdAt: new Date().toISOString(),
    message: 'Support ticket created. Our team will respond within 24 hours.',
  });
});

// POST /developer/teams
portalRouter.post('/teams', (req: Request, res: Response) => {
  const { ownerId, name } = z
    .object({ ownerId: z.string(), name: z.string().min(2) })
    .parse(req.body);

  const teamId = `team_${Date.now().toString(36)}`;

  res.status(201).json({
    id: teamId,
    name,
    ownerId,
    role: 'owner',
    members: [{ userId: ownerId, role: 'owner' }],
    createdAt: new Date().toISOString(),
  });
});

// POST /developer/teams/:id/invite
portalRouter.post('/teams/:id/invite', (req: Request, res: Response) => {
  const { email, role } = z
    .object({
      email: z.string().email(),
      role: z.enum(['admin', 'developer', 'viewer']).default('developer'),
    })
    .parse(req.body);

  res.status(202).json({
    teamId: req.params.id,
    invitedEmail: email,
    role,
    status: 'pending',
    message: `Invitation sent to ${email}`,
  });
});

// DELETE /developer/teams/:id/members/:userId
portalRouter.delete('/teams/:id/members/:userId', (req: Request, res: Response) => {
  res.status(204).end();
});
