/**
 * i18n Translation Matrix Engine — API routes
 *
 * Endpoints:
 *   GET  /i18n/languages              — list supported languages + coverage stats
 *   GET  /i18n/keys                   — list all translation keys (DB + static)
 *   POST /i18n/keys                   — register a new translation key
 *   GET  /i18n/translate              — translate a single key with interpolation
 *   POST /i18n/translate/batch        — translate multiple keys at once
 *   GET  /i18n/matrix                 — full translation matrix across all languages
 *   GET  /i18n/dictionary/:language   — full static dictionary for a language
 *   POST /i18n/translations           — add/update a DB translation for a key
 *   PATCH /i18n/translations/:id      — approve a translation
 *   POST /i18n/seed                   — bulk-seed static dictionary into DB
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prismaRead as prisma, prismaWrite } from '../db';
import {
  SUPPORTED_LANGUAGES,
  SupportedLanguage,
  DEFAULT_LANGUAGE,
  normaliseLocale,
  t,
  tAsync,
  buildStaticMatrix,
  getAllStaticKeys,
  getStaticDictionary,
} from '../i18n/engine';

export const i18nRouter = Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Resolve language from request: X-Language header > ?lang= > Accept-Language > default */
function resolveLanguage(req: Request): SupportedLanguage {
  // Middleware already resolved it if i18nMiddleware is applied globally
  if (req.locale) return req.locale;

  const xLang = req.headers['x-language'] as string | undefined;
  const qLang = req.query['lang'] as string | undefined;
  return normaliseLocale(xLang ?? qLang ?? DEFAULT_LANGUAGE);
}

// ── GET /i18n/languages ───────────────────────────────────────────────────────

/**
 * @swagger
 * /i18n/languages:
 *   get:
 *     summary: List supported languages with static coverage stats
 *     tags: [i18n]
 *     responses:
 *       200:
 *         description: Language list with coverage percentages
 */
i18nRouter.get('/languages', async (_req: Request, res: Response) => {
  try {
    const masterKeys = getAllStaticKeys();
    const total = masterKeys.length;

    const coverage: Record<string, { static: number; staticPct: number; hasStaticDictionary: boolean }> = {};

    for (const lang of SUPPORTED_LANGUAGES) {
      const dict = getStaticDictionary(lang as SupportedLanguage);
      const covered = masterKeys.filter((k) => dict[k] && dict[k] !== k).length;
      coverage[lang] = {
        static: covered,
        staticPct: total > 0 ? Math.round((covered / total) * 100) : 0,
        hasStaticDictionary: ['en', 'es', 'ko'].includes(lang),
      };
    }

    // DB-stored distinct languages
    const dbLanguages = await prisma.translation.findMany({
      distinct: ['language'],
      select: { language: true },
    });

    res.json({
      supported: SUPPORTED_LANGUAGES,
      default: DEFAULT_LANGUAGE,
      staticDictionaries: ['en', 'es', 'ko'],
      dbLanguages: dbLanguages.map((l) => l.language),
      totalStaticKeys: total,
      coverage,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /i18n/keys ────────────────────────────────────────────────────────────

/**
 * @swagger
 * /i18n/keys:
 *   get:
 *     summary: List translation keys (static + DB)
 *     tags: [i18n]
 *     parameters:
 *       - in: query
 *         name: source
 *         schema:
 *           type: string
 *           enum: [static, db, all]
 *         description: Filter by key source (default all)
 */
i18nRouter.get('/keys', async (req: Request, res: Response) => {
  try {
    const source = (req.query['source'] as string) ?? 'all';

    const staticKeys = getAllStaticKeys().map((key) => ({
      key,
      defaultText: getStaticDictionary('en')[key],
      source: 'static' as const,
    }));

    if (source === 'static') {
      return res.json({ data: staticKeys, total: staticKeys.length });
    }

    const dbKeys = await prisma.translationKey.findMany({
      include: { translations: true },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    if (source === 'db') {
      return res.json({ data: dbKeys, total: dbKeys.length });
    }

    // Merge: DB keys take precedence over static for the same key name
    const dbKeyNames = new Set(dbKeys.map((k) => k.key));
    const staticOnly = staticKeys.filter((k) => !dbKeyNames.has(k.key));

    res.json({
      data: [...dbKeys, ...staticOnly],
      total: dbKeys.length + staticOnly.length,
      dbCount: dbKeys.length,
      staticCount: staticOnly.length,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── POST /i18n/keys ───────────────────────────────────────────────────────────

/**
 * @swagger
 * /i18n/keys:
 *   post:
 *     summary: Register a new translation key
 *     tags: [i18n]
 */
i18nRouter.post('/keys', async (req: Request, res: Response) => {
  try {
    const { key, defaultText, context } = z
      .object({
        key: z.string().min(1).max(255),
        defaultText: z.string().min(1),
        context: z.string().optional(),
      })
      .parse(req.body);

    const translationKey = await prismaWrite.translationKey.create({
      data: { key, defaultText, context },
    });

    const lang = resolveLanguage(req);
    res.status(201).json({
      ...translationKey,
      message: t('i18n.key_created', lang, { key }),
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('Unique constraint')) {
      return res.status(409).json({ error: `Key already exists` });
    }
    res.status(400).json({ error: msg });
  }
});

// ── GET /i18n/translate ───────────────────────────────────────────────────────

/**
 * @swagger
 * /i18n/translate:
 *   get:
 *     summary: Translate a single key with optional interpolation values
 *     tags: [i18n]
 *     parameters:
 *       - in: query
 *         name: key
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: language
 *         schema:
 *           type: string
 *       - in: query
 *         name: values
 *         schema:
 *           type: string
 *         description: JSON-encoded interpolation values
 */
i18nRouter.get('/translate', async (req: Request, res: Response) => {
  try {
    const schema = z.object({
      key: z.string().min(1),
      language: z.string().min(2).max(10).optional(),
      values: z.string().optional(), // JSON string
    });

    const { key, language, values: valuesRaw } = schema.parse(req.query);

    const lang = normaliseLocale(language ?? resolveLanguage(req));
    const values = valuesRaw ? (JSON.parse(valuesRaw) as Record<string, unknown>) : {};

    const result = await tAsync(key, lang, values);

    res.json({ key, language: lang, result });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// ── POST /i18n/translate/batch ────────────────────────────────────────────────

/**
 * @swagger
 * /i18n/translate/batch:
 *   post:
 *     summary: Translate multiple keys at once
 *     tags: [i18n]
 */
i18nRouter.post('/translate/batch', async (req: Request, res: Response) => {
  try {
    const schema = z.object({
      language: z.string().min(2).max(10).optional(),
      keys: z
        .array(
          z.object({
            key: z.string().min(1),
            values: z.record(z.unknown()).optional(),
          }),
        )
        .min(1)
        .max(100),
    });

    const { language, keys } = schema.parse(req.body);
    const lang = normaliseLocale(language ?? resolveLanguage(req));

    const results = await Promise.all(
      keys.map(async ({ key, values }) => ({
        key,
        result: await tAsync(key, lang, values ?? {}),
      })),
    );

    res.json({ language: lang, results });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// ── GET /i18n/matrix ──────────────────────────────────────────────────────────

/**
 * @swagger
 * /i18n/matrix:
 *   get:
 *     summary: Full translation matrix — all keys × all languages
 *     tags: [i18n]
 *     parameters:
 *       - in: query
 *         name: keys
 *         schema:
 *           type: string
 *         description: Comma-separated list of keys to include (default all static keys)
 *       - in: query
 *         name: domain
 *         schema:
 *           type: string
 *         description: Filter keys by domain prefix, e.g. "transaction"
 */
i18nRouter.get('/matrix', async (req: Request, res: Response) => {
  try {
    const keysParam = req.query['keys'] as string | undefined;
    const domain = req.query['domain'] as string | undefined;

    let keys: string[];

    if (keysParam) {
      keys = keysParam.split(',').map((k) => k.trim()).filter(Boolean);
    } else {
      keys = getAllStaticKeys();
    }

    if (domain) {
      keys = keys.filter((k) => k.startsWith(`${domain}.`));
    }

    if (keys.length === 0) {
      return res.status(400).json({ error: 'No keys matched the filter' });
    }

    if (keys.length > 500) {
      return res.status(400).json({ error: 'Too many keys requested (max 500)' });
    }

    // Build static matrix
    const matrix = buildStaticMatrix(keys);

    // Overlay DB translations on top of static ones
    try {
      const dbTranslations = await prisma.translation.findMany({
        where: {
          key: { key: { in: keys } },
        },
        include: { key: { select: { key: true } } },
      });

      for (const row of dbTranslations) {
        const keyName = row.key.key;
        if (matrix[keyName]) {
          matrix[keyName][row.language] = row.translatedText;
        }
      }
    } catch {
      // DB unavailable — static matrix is still valid
    }

    res.json({
      languages: SUPPORTED_LANGUAGES,
      keyCount: keys.length,
      matrix,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /i18n/dictionary/:language ───────────────────────────────────────────

/**
 * @swagger
 * /i18n/dictionary/{language}:
 *   get:
 *     summary: Return the full static dictionary for a language
 *     tags: [i18n]
 */
i18nRouter.get('/dictionary/:language', (req: Request, res: Response) => {
  const lang = normaliseLocale(req.params['language']);
  const dict = getStaticDictionary(lang);

  res.json({
    language: lang,
    keyCount: Object.keys(dict).length,
    dictionary: dict,
  });
});

// ── POST /i18n/translations ───────────────────────────────────────────────────

/**
 * @swagger
 * /i18n/translations:
 *   post:
 *     summary: Add or update a DB translation for a key
 *     tags: [i18n]
 */
i18nRouter.post('/translations', async (req: Request, res: Response) => {
  try {
    const { keyId, language, translatedText, approvedBy } = z
      .object({
        keyId: z.string().min(1),
        language: z.string().min(2).max(10),
        translatedText: z.string().min(1),
        approvedBy: z.string().optional(),
      })
      .parse(req.body);

    const lang = normaliseLocale(language);

    const translation = await prismaWrite.translation.upsert({
      where: { keyId_language: { keyId, language: lang } },
      create: {
        keyId,
        language: lang,
        translatedText,
        approvedBy,
        approvedAt: approvedBy ? new Date() : null,
      },
      update: {
        translatedText,
        ...(approvedBy && { approvedBy, approvedAt: new Date() }),
      },
    });

    const reqLang = resolveLanguage(req);
    res.status(201).json({
      ...translation,
      message: t('i18n.translation_added', reqLang, { key: keyId, language: lang }),
    });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// ── PATCH /i18n/translations/:id ──────────────────────────────────────────────

/**
 * @swagger
 * /i18n/translations/{id}:
 *   patch:
 *     summary: Approve a translation
 *     tags: [i18n]
 */
i18nRouter.patch('/translations/:id', async (req: Request, res: Response) => {
  try {
    const { approvedBy } = z
      .object({ approvedBy: z.string().min(1) })
      .parse(req.body);

    const translation = await prismaWrite.translation.update({
      where: { id: req.params['id'] },
      data: { approvedBy, approvedAt: new Date() },
    });

    const lang = resolveLanguage(req);
    res.json({
      ...translation,
      message: t('i18n.translation_approved', lang, { approver: approvedBy }),
    });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// ── POST /i18n/seed ───────────────────────────────────────────────────────────

/**
 * @swagger
 * /i18n/seed:
 *   post:
 *     summary: Bulk-seed static dictionaries into the DB
 *     description: >
 *       Upserts all keys from the static English dictionary and their
 *       translations for all bundled languages (en, es, ko) into the DB.
 *       Safe to run multiple times (idempotent).
 *     tags: [i18n]
 */
i18nRouter.post('/seed', async (req: Request, res: Response) => {
  try {
    const enDict = getStaticDictionary('en');
    const esDict = getStaticDictionary('es');
    const koDict = getStaticDictionary('ko');

    let seeded = 0;

    for (const [key, defaultText] of Object.entries(enDict)) {
      // Upsert the key
      const tkRecord = await prismaWrite.translationKey.upsert({
        where: { key },
        create: { key, defaultText },
        update: { defaultText },
      });

      // Upsert translations for es and ko
      const pairs: Array<{ language: string; text: string }> = [
        { language: 'es', text: esDict[key] ?? defaultText },
        { language: 'ko', text: koDict[key] ?? defaultText },
      ];

      for (const { language, text } of pairs) {
        await prismaWrite.translation.upsert({
          where: { keyId_language: { keyId: tkRecord.id, language } },
          create: { keyId: tkRecord.id, language, translatedText: text },
          update: { translatedText: text },
        });
      }

      seeded++;
    }

    const lang = resolveLanguage(req);
    res.json({
      message: t('i18n.bulk_seeded', lang, { count: seeded }),
      seeded,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});
