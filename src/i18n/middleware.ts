/**
 * i18n locale-detection middleware.
 *
 * Reads the user's preferred language from (in priority order):
 *   1. X-Language header          — explicit override, e.g. "ko"
 *   2. lang query parameter        — e.g. ?lang=es
 *   3. Accept-Language header      — standard browser/client negotiation
 *
 * Attaches to req:
 *   req.locale   — resolved SupportedLanguage code, e.g. "es"
 *   req.t        — bound sync translator: req.t('key', { values })
 *   req.tAsync   — bound async translator: await req.tAsync('key', { values })
 */

import { Request, Response, NextFunction } from 'express';
import {
  SupportedLanguage,
  DEFAULT_LANGUAGE,
  normaliseLocale,
  parseAcceptLanguage,
  t as translate,
  tAsync as translateAsync,
} from './engine';

// Extend Express Request type
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      locale: SupportedLanguage;
      t: (key: string, values?: Record<string, unknown>) => string;
      tAsync: (key: string, values?: Record<string, unknown>) => Promise<string>;
    }
  }
}

/**
 * Express middleware — resolves locale and attaches translation helpers.
 */
export function i18nMiddleware(req: Request, _res: Response, next: NextFunction): void {
  // 1. Explicit header override
  const xLang = req.headers['x-language'] as string | undefined;
  // 2. Query param
  const qLang = req.query['lang'] as string | undefined;
  // 3. Accept-Language
  const acceptLang = req.headers['accept-language'] as string | undefined;

  let locale: SupportedLanguage = DEFAULT_LANGUAGE;

  if (xLang) {
    locale = normaliseLocale(xLang);
  } else if (qLang) {
    locale = normaliseLocale(qLang);
  } else if (acceptLang) {
    locale = parseAcceptLanguage(acceptLang);
  }

  req.locale = locale;

  // Bind helpers so handlers can call req.t('key', { amount: 100 })
  req.t = (key: string, values?: Record<string, unknown>) => translate(key, locale, values ?? {});

  req.tAsync = (key: string, values?: Record<string, unknown>) =>
    translateAsync(key, locale, values ?? {});

  next();
}
