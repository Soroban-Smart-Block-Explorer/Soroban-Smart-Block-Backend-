import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { renderTemplate, renderBuiltIn, BUILT_IN_TEMPLATES } from '../indexer/template-engine';

export const renderRouter = Router();

const renderSchema = z.object({
  template: z.string().optional(), // custom template string
  fnName: z.string().optional(), // use a built-in template by function name
  args: z.record(z.unknown()),
  tokenSymbol: z.string().optional(),
  decimals: z.coerce.number().int().min(0).max(18).optional(),
  contractName: z.string().optional(),
});

// POST /api/v1/render
// Body: { template?, fnName?, args, tokenSymbol?, decimals?, contractName? }
// Provide either `template` (custom) or `fnName` (built-in).
renderRouter.post('/', (req: Request, res: Response) => {
  const parsed = renderSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { template, fnName, ...ctx } = parsed.data;

  if (!template && !fnName) {
    return res.status(400).json({ error: 'Provide either `template` or `fnName`' });
  }

  const result = template ? renderTemplate(template, ctx) : renderBuiltIn(fnName!, ctx);

  res.json({ result });
});

// GET /api/v1/render/templates — list available built-in templates
renderRouter.get('/templates', (_req: Request, res: Response) => {
  res.json(BUILT_IN_TEMPLATES);
});
