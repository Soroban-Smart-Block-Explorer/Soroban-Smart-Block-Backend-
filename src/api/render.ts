import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { renderTemplate, renderBuiltIn, BUILT_IN_TEMPLATES } from '../indexer/template-engine';

/**
 * @swagger
 * tags:
 *   name: Render
 *   description: Human-readable transaction rendering via template engine
 */

export const renderRouter = Router();

const renderSchema = z.object({
  template: z.string().optional(), // custom template string
  fnName: z.string().optional(), // use a built-in template by function name
  args: z.record(z.unknown()),
  tokenSymbol: z.string().optional(),
  decimals: z.coerce.number().int().min(0).max(18).optional(),
  contractName: z.string().optional(),
});

/**
 * @swagger
 * /api/v1/render:
 *   post:
 *     summary: Render a human-readable string from a template
 *     description: Apply a custom Mustache-style template or a named built-in template to a set of args.
 *     tags: [Render]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               template:
 *                 type: string
 *                 description: Custom template string (mutually exclusive with fnName)
 *                 example: "{from} swapped {amount} {tokenSymbol}"
 *               fnName:
 *                 type: string
 *                 description: Built-in template function name (mutually exclusive with template)
 *                 example: swap
 *               args:
 *                 type: object
 *                 description: Template variable bindings
 *                 example: { from: "GABC...", amount: "100", tokenSymbol: "USDC" }
 *               tokenSymbol:
 *                 type: string
 *               decimals:
 *                 type: integer
 *               contractName:
 *                 type: string
 *     responses:
 *       200:
 *         description: Rendered string
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 result: { type: string, example: "GABC... swapped 100 USDC" }
 *       400:
 *         description: Missing or invalid request body
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
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

/**
 * @swagger
 * /api/v1/render/templates:
 *   get:
 *     summary: List available built-in render templates
 *     description: Returns all function names that have a built-in human-readable template.
 *     tags: [Render]
 *     responses:
 *       200:
 *         description: Map of function name → template string
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               additionalProperties:
 *                 type: string
 *               example:
 *                 swap: "{from} swapped {amount_in} → {amount_out} on {contractName}"
 *                 transfer: "{from} transferred {amount} {tokenSymbol} to {to}"
 */
// GET /api/v1/render/templates — list available built-in templates
renderRouter.get('/templates', (_req: Request, res: Response) => {
  res.json(BUILT_IN_TEMPLATES);
});
