/**
 * i18n Module Tests (#859)
 *
 * Tests for:
 *   - Translation key resolution and fallback behavior
 *   - Locale normalization and Accept-Language parsing
 *   - i18n router endpoints
 *   - Translation interpolation
 *   - Static dictionary coverage
 */

import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  normaliseLocale,
  parseAcceptLanguage,
  t,
  interpolate,
  buildStaticMatrix,
  getAllStaticKeys,
  getStaticDictionary,
  SUPPORTED_LANGUAGES,
  DEFAULT_LANGUAGE,
} from '../src/i18n/engine';
import { i18nMiddleware } from '../src/i18n/middleware';
import { i18nRouter } from '../src/api/i18n';

vi.mock('../src/db', () => ({
  prismaRead: {
    translationKey: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
  },
  prismaWrite: {
    translationKey: {
      create: vi.fn(),
      upsert: vi.fn(),
    },
    translation: {
      create: vi.fn(),
      update: vi.fn(),
    },
  },
}));

describe('i18n Module', () => {
  describe('normaliseLocale', () => {
    it('should return exact match for supported languages', () => {
      expect(normaliseLocale('en')).toBe('en');
      expect(normaliseLocale('es')).toBe('es');
      expect(normaliseLocale('ko')).toBe('ko');
    });

    it('should extract base language from BCP-47 tags', () => {
      expect(normaliseLocale('en-US')).toBe('en');
      expect(normaliseLocale('es-419')).toBe('es');
      expect(normaliseLocale('ko-KR')).toBe('ko');
    });

    it('should handle case-insensitivity', () => {
      expect(normaliseLocale('EN')).toBe('en');
      expect(normaliseLocale('ES-ES')).toBe('es');
      expect(normaliseLocale('Ko-kr')).toBe('ko');
    });

    it('should fall back to DEFAULT_LANGUAGE for unknown tags', () => {
      expect(normaliseLocale('xx')).toBe(DEFAULT_LANGUAGE);
      expect(normaliseLocale('fr')).toBe(DEFAULT_LANGUAGE);
      expect(normaliseLocale(null)).toBe(DEFAULT_LANGUAGE);
      expect(normaliseLocale(undefined)).toBe(DEFAULT_LANGUAGE);
      expect(normaliseLocale('')).toBe(DEFAULT_LANGUAGE);
    });

    it('should trim whitespace', () => {
      expect(normaliseLocale('  en  ')).toBe('en');
      expect(normaliseLocale('  es-ES  ')).toBe('es');
    });
  });

  describe('parseAcceptLanguage', () => {
    it('should parse single language tag', () => {
      expect(parseAcceptLanguage('es')).toBe('es');
      expect(parseAcceptLanguage('ko')).toBe('ko');
    });

    it('should respect q-values for priority', () => {
      expect(parseAcceptLanguage('es;q=0.9,en;q=0.8')).toBe('es');
      expect(parseAcceptLanguage('en;q=0.5,es;q=0.9')).toBe('es');
    });

    it('should handle complex Accept-Language headers', () => {
      const header = 'fr-FR,fr;q=0.9,en;q=0.8,es;q=0.7';
      expect(parseAcceptLanguage(header)).toBe('en');
    });

    it('should fall back to English for unsupported languages', () => {
      expect(parseAcceptLanguage('fr-FR,de;q=0.9')).toBe('en');
    });

    it('should return DEFAULT_LANGUAGE for null/undefined', () => {
      expect(parseAcceptLanguage(null)).toBe(DEFAULT_LANGUAGE);
      expect(parseAcceptLanguage(undefined)).toBe(DEFAULT_LANGUAGE);
      expect(parseAcceptLanguage('')).toBe(DEFAULT_LANGUAGE);
    });
  });

  describe('interpolate', () => {
    it('should replace simple placeholders', () => {
      expect(interpolate('Hello {name}', { name: 'World' })).toBe('Hello World');
      expect(interpolate('{greeting} {name}!', { greeting: 'Hi', name: 'Alice' })).toBe(
        'Hi Alice!',
      );
    });

    it('should handle multiple occurrences of same placeholder', () => {
      expect(interpolate('{a} and {a}', { a: 'test' })).toBe('test and test');
    });

    it('should leave unknown placeholders as-is', () => {
      expect(interpolate('Hello {unknown}', {})).toBe('Hello {unknown}');
    });

    it('should handle null/undefined values as placeholders', () => {
      expect(interpolate('Value: {val}', { val: null })).toBe('Value: {val}');
      expect(interpolate('Value: {val}', { val: undefined })).toBe('Value: {val}');
    });

    it('should convert non-string values to strings', () => {
      expect(interpolate('Count: {n}', { n: 42 })).toBe('Count: 42');
      expect(interpolate('Flag: {flag}', { flag: true })).toBe('Flag: true');
    });

    it('should work with empty values object', () => {
      expect(interpolate('No placeholders')).toBe('No placeholders');
    });
  });

  describe('t (sync translation)', () => {
    it('should return translated string from static dictionary', () => {
      const result = t('general.ok', 'en');
      expect(result).toBe('OK');
    });

    it('should use English fallback for missing translations', () => {
      expect(t('general.ok', 'fr')).toBe('OK');
    });

    it('should return key itself as last resort', () => {
      expect(t('nonexistent.key', 'en')).toBe('nonexistent.key');
    });

    it('should interpolate values', () => {
      const result = t('transaction.swap_description', 'en', {
        from: 'GAAAA',
        amountIn: '100',
        assetIn: 'USDC',
        amountOut: '95',
        assetOut: 'EURC',
      });
      expect(result).toContain('GAAAA');
      expect(result).toContain('100');
      expect(result).toContain('USDC');
    });

    it('should default to DEFAULT_LANGUAGE if not specified', () => {
      const result = t('general.ok');
      expect(result).toBe('OK');
    });
  });

  describe('buildStaticMatrix', () => {
    it('should build translation matrix for given keys', () => {
      const keys = ['general.ok', 'general.not_found'];
      const matrix = buildStaticMatrix(keys);

      expect(matrix).toHaveProperty('general.ok');
      expect(matrix).toHaveProperty('general.not_found');
      expect(matrix['general.ok']).toHaveProperty('en');
      expect(matrix['general.ok']).toHaveProperty('es');
    });

    it('should include all supported languages', () => {
      const keys = ['general.ok'];
      const matrix = buildStaticMatrix(keys);

      for (const lang of SUPPORTED_LANGUAGES) {
        expect(matrix['general.ok']).toHaveProperty(lang);
      }
    });

    it('should return key itself for missing translations', () => {
      const keys = ['nonexistent.key'];
      const matrix = buildStaticMatrix(keys);

      expect(matrix['nonexistent.key']['en']).toBe('nonexistent.key');
    });
  });

  describe('getAllStaticKeys', () => {
    it('should return array of all keys', () => {
      const keys = getAllStaticKeys();
      expect(Array.isArray(keys)).toBe(true);
      expect(keys.length).toBeGreaterThan(0);
    });

    it('should include common keys', () => {
      const keys = getAllStaticKeys();
      expect(keys).toContain('general.ok');
      expect(keys).toContain('general.not_found');
    });
  });

  describe('getStaticDictionary', () => {
    it('should return dictionary for supported language', () => {
      const enDict = getStaticDictionary('en');
      expect(enDict).toHaveProperty('general.ok');
      expect(enDict['general.ok']).toBe('OK');
    });

    it('should return English fallback for unsupported language', () => {
      const frDict = getStaticDictionary('fr' as any);
      expect(frDict).toHaveProperty('general.ok');
    });

    it('should return a copy (not reference)', () => {
      const dict1 = getStaticDictionary('en');
      const dict2 = getStaticDictionary('en');
      expect(dict1).not.toBe(dict2);
      expect(dict1).toEqual(dict2);
    });
  });

  describe('i18nMiddleware', () => {
    it('should resolve locale from X-Language header', () => {
      const app = express();
      app.use(i18nMiddleware);
      app.get('/test', (req, res) => {
        res.json({ locale: req.locale });
      });

      return request(app).get('/test').set('X-Language', 'es').expect(200).expect({ locale: 'es' });
    });

    it('should resolve locale from query parameter', () => {
      const app = express();
      app.use(i18nMiddleware);
      app.get('/test', (req, res) => {
        res.json({ locale: req.locale });
      });

      return request(app).get('/test?lang=ko').expect(200).expect({ locale: 'ko' });
    });

    it('should resolve locale from Accept-Language header', () => {
      const app = express();
      app.use(i18nMiddleware);
      app.get('/test', (req, res) => {
        res.json({ locale: req.locale });
      });

      return request(app)
        .get('/test')
        .set('Accept-Language', 'es-ES,es;q=0.9')
        .expect(200)
        .expect({ locale: 'es' });
    });

    it('should attach translation helpers to request', () => {
      const app = express();
      app.use(i18nMiddleware);
      app.get('/test', (req, res) => {
        res.json({
          hasT: typeof req.t === 'function',
          hasTAsync: typeof req.tAsync === 'function',
        });
      });

      return request(app).get('/test').expect(200).expect({ hasT: true, hasTAsync: true });
    });

    it('should translate using middleware helpers', () => {
      const app = express();
      app.use(i18nMiddleware);
      app.get('/test', (req, res) => {
        res.json({ translated: req.t('general.ok') });
      });

      return request(app).get('/test').expect(200).expect({ translated: 'OK' });
    });

    it('should prioritize X-Language > query > Accept-Language', () => {
      const app = express();
      app.use(i18nMiddleware);
      app.get('/test', (req, res) => {
        res.json({ locale: req.locale });
      });

      return request(app)
        .get('/test?lang=ko')
        .set('X-Language', 'es')
        .set('Accept-Language', 'en')
        .expect(200)
        .expect({ locale: 'es' });
    });
  });

  describe('i18nRouter', () => {
    it('should list supported languages', () => {
      const app = express();
      app.use('/i18n', i18nRouter);

      return request(app)
        .get('/i18n/languages')
        .expect(200)
        .then((res) => {
          expect(res.body).toHaveProperty('en');
          expect(res.body.en).toHaveProperty('static');
          expect(res.body.en).toHaveProperty('staticPct');
        });
    });

    it('should list all translation keys', () => {
      const app = express();
      app.use('/i18n', i18nRouter);

      return request(app)
        .get('/i18n/keys')
        .expect(200)
        .then((res) => {
          expect(Array.isArray(res.body)).toBe(true);
          expect(res.body.length).toBeGreaterThan(0);
        });
    });

    it('should translate single key', () => {
      const app = express();
      app.use('/i18n', i18nRouter);

      return request(app)
        .get('/i18n/translate?key=general.ok')
        .expect(200)
        .then((res) => {
          expect(res.body).toHaveProperty('key');
          expect(res.body).toHaveProperty('translation');
          expect(res.body.translation).toBe('OK');
        });
    });

    it('should translate with interpolation', () => {
      const app = express();
      app.use('/i18n', i18nRouter);

      return request(app)
        .get('/i18n/translate?key=general.bad_request&reason=Invalid%20input')
        .expect(200)
        .then((res) => {
          expect(res.body.translation).toContain('Invalid input');
        });
    });

    it('should get full static dictionary', () => {
      const app = express();
      app.use('/i18n', i18nRouter);

      return request(app)
        .get('/i18n/dictionary/en')
        .expect(200)
        .then((res) => {
          expect(typeof res.body).toBe('object');
          expect(res.body).toHaveProperty('general.ok');
          expect(res.body['general.ok']).toBe('OK');
        });
    });

    it('should build translation matrix', () => {
      const app = express();
      app.use('/i18n', i18nRouter);

      return request(app)
        .get('/i18n/matrix')
        .expect(200)
        .then((res) => {
          expect(typeof res.body).toBe('object');
          expect(Object.keys(res.body).length).toBeGreaterThan(0);
        });
    });
  });

  describe('Translation coverage assertion', () => {
    it('should have every master key translated to all static languages', () => {
      const masterKeys = getAllStaticKeys();
      const staticLanguages = ['en', 'es', 'ko'] as const;

      for (const key of masterKeys) {
        for (const lang of staticLanguages) {
          const translation = t(key, lang);
          expect(translation).not.toBe(key);
          expect(translation.length).toBeGreaterThan(0);
        }
      }
    });
  });
});
