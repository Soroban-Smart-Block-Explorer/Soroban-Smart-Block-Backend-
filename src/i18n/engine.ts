/**
 * i18n Translation Matrix Engine
 *
 * Resolution order for any (key, language) pair:
 *   1. In-memory static dictionary for the requested language
 *   2. In-memory static dictionary for the base language (e.g. "en" from "en-US")
 *   3. English (en) fallback dictionary
 *   4. DB-stored translation (async path only)
 *   5. Raw defaultText from DB TranslationKey
 *   6. The key itself (last resort)
 *
 * Sync path (t / tSync): uses only steps 1-3 (static dictionaries).
 * Async path (tAsync):   uses all 6 steps, hitting the DB when static misses.
 */

import { en, es, ko } from './locales';
import { prismaRead } from '../db';

// ── Supported languages ───────────────────────────────────────────────────────

export const SUPPORTED_LANGUAGES = ['en', 'es', 'ko', 'fr', 'de', 'ja', 'zh'] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export const DEFAULT_LANGUAGE: SupportedLanguage = 'en';

/** Static dictionaries — only languages with bundled locale files. */
const STATIC_DICTIONARIES: Partial<Record<SupportedLanguage, Record<string, string>>> = {
  en,
  es,
  ko,
};

// ── Locale normalisation ──────────────────────────────────────────────────────

/**
 * Normalise a raw locale tag to a supported language code.
 * "en-US" → "en", "es-419" → "es", "ko-KR" → "ko", "fr" → "fr"
 * Falls back to DEFAULT_LANGUAGE if the tag is unrecognised.
 */
export function normaliseLocale(raw: string | undefined | null): SupportedLanguage {
  if (!raw) return DEFAULT_LANGUAGE;

  const cleaned = raw.trim().toLowerCase();

  // Exact match first
  if (SUPPORTED_LANGUAGES.includes(cleaned as SupportedLanguage)) {
    return cleaned as SupportedLanguage;
  }

  // Base language from BCP-47 tag (e.g. "en-US" → "en")
  const base = cleaned.split(/[-_]/)[0];
  if (SUPPORTED_LANGUAGES.includes(base as SupportedLanguage)) {
    return base as SupportedLanguage;
  }

  return DEFAULT_LANGUAGE;
}

/**
 * Parse the value of an Accept-Language header and return the best
 * supported language, respecting q-values.
 * "es-419;q=0.9,en;q=0.8" → "es"
 */
export function parseAcceptLanguage(header: string | undefined | null): SupportedLanguage {
  if (!header) return DEFAULT_LANGUAGE;

  const candidates = header
    .split(',')
    .map((part) => {
      const [tag, q] = part.trim().split(';q=');
      return { tag: tag.trim(), q: q ? parseFloat(q) : 1.0 };
    })
    .sort((a, b) => b.q - a.q);

  for (const { tag } of candidates) {
    const lang = normaliseLocale(tag);
    if (lang !== DEFAULT_LANGUAGE || tag.toLowerCase().startsWith('en')) {
      return lang;
    }
  }

  return DEFAULT_LANGUAGE;
}

// ── Interpolation ─────────────────────────────────────────────────────────────

/**
 * Replace {placeholder} tokens in a template string with values from the map.
 * Unknown placeholders are left as-is.
 */
export function interpolate(
  template: string,
  values: Record<string, unknown> = {},
): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const val = values[key];
    return val !== undefined && val !== null ? String(val) : match;
  });
}

// ── Static (sync) translation ─────────────────────────────────────────────────

/**
 * Synchronous translation using only static dictionaries.
 * Safe to call anywhere — no DB access.
 *
 * @param key      Dot-notation key, e.g. "transaction.swap_description"
 * @param language Resolved language code
 * @param values   Interpolation values
 * @returns        Translated + interpolated string, or the key itself on miss
 */
export function t(
  key: string,
  language: SupportedLanguage = DEFAULT_LANGUAGE,
  values: Record<string, unknown> = {},
): string {
  const dict = STATIC_DICTIONARIES[language];
  const enDict = STATIC_DICTIONARIES['en']!;

  const template =
    dict?.[key] ??           // requested language
    enDict[key] ??           // English fallback
    key;                     // last resort: return the key

  return interpolate(template, values);
}

/** Alias for t() — explicit sync variant. */
export const tSync = t;

// ── Async translation (static + DB) ──────────────────────────────────────────

/**
 * Async translation: tries static dictionaries first, then falls back to the
 * database (TranslationKey / Translation models).
 *
 * @param key      Dot-notation key
 * @param language Resolved language code
 * @param values   Interpolation values
 * @returns        Translated + interpolated string
 */
export async function tAsync(
  key: string,
  language: SupportedLanguage = DEFAULT_LANGUAGE,
  values: Record<string, unknown> = {},
): Promise<string> {
  // 1-3: static dictionaries
  const dict = STATIC_DICTIONARIES[language];
  const enDict = STATIC_DICTIONARIES['en']!;

  if (dict?.[key]) return interpolate(dict[key], values);
  if (enDict[key]) return interpolate(enDict[key], values);

  // 4-5: DB lookup
  try {
    const translationKey = await prismaRead.translationKey.findUnique({
      where: { key },
      include: {
        translations: {
          where: { language },
          take: 1,
        },
      },
    });

    if (translationKey) {
      const template =
        translationKey.translations[0]?.translatedText ??
        translationKey.defaultText;
      return interpolate(template, values);
    }
  } catch {
    // DB unavailable — fall through to key
  }

  // 6: key itself
  return key;
}

// ── Translation matrix ────────────────────────────────────────────────────────

/**
 * Build a full translation matrix for a set of keys across all supported
 * languages. Used by the /i18n/matrix endpoint.
 *
 * Returns:
 * {
 *   "transaction.swap_description": {
 *     "en": "Address {from} swapped ...",
 *     "es": "La dirección {from} intercambió ...",
 *     "ko": "주소 {from}이(가) ... 스왑했습니다",
 *     ...
 *   },
 *   ...
 * }
 */
export function buildStaticMatrix(
  keys: string[],
): Record<string, Record<string, string>> {
  const matrix: Record<string, Record<string, string>> = {};

  for (const key of keys) {
    matrix[key] = {};
    for (const lang of SUPPORTED_LANGUAGES) {
      const dict = STATIC_DICTIONARIES[lang as SupportedLanguage];
      const enDict = STATIC_DICTIONARIES['en']!;
      matrix[key][lang] = dict?.[key] ?? enDict[key] ?? key;
    }
  }

  return matrix;
}

/**
 * Return all keys defined in the English (master) static dictionary.
 */
export function getAllStaticKeys(): string[] {
  return Object.keys(STATIC_DICTIONARIES['en']!);
}

/**
 * Return the static dictionary for a given language (read-only).
 */
export function getStaticDictionary(
  language: SupportedLanguage,
): Record<string, string> {
  return { ...(STATIC_DICTIONARIES[language] ?? STATIC_DICTIONARIES['en']!) };
}
