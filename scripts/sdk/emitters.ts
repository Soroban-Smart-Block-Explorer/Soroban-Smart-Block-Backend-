/**
 * Additional client emitters. Each emitter receives the normalized operations
 * and returns the files it owns; `generate.ts` handles writing and drift
 * checks uniformly. Add a language by appending an emitter here.
 */
import type { NormalizedOperation, OpenApiDocument } from '../../src/lib/openapi/normalize';

export interface EmitterInput {
  doc: OpenApiDocument;
  ops: NormalizedOperation[];
  fingerprint: string;
}

export type Emitter = (input: EmitterInput) => Array<{ path: string; content: string }>;

export const EXTRA_EMITTERS: Emitter[] = [];
