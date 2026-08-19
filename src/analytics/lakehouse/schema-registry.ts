/**
 * Layer 1 — Schema Registry (Issue #551)
 *
 * Central registry for all event types flowing through the stream bus. Every
 * message published to the lakehouse event bus carries a schema id in its
 * envelope so that consumers, materialized views, and the OLAP loaders can
 * evolve independently.
 *
 * The registry enforces subject-level compatibility (BACKWARD by default,
 * matching Confluent Schema Registry semantics) so that a producer cannot ship
 * a breaking schema change without an explicit compatibility override.
 *
 * Serialization format:
 *   In production this module is backed by Confluent Schema Registry with
 *   Avro or Protobuf wire encoding. Here we use a self-describing JSON envelope
 *   — `{ magic: 0, schemaId, payload }` — which mirrors the Avro single-object
 *   encoding (magic byte + 4-byte schema id + body). The `encode`/`decode`
 *   seam is identical, so swapping in `avsc`/`protobufjs` is a drop-in change.
 */

// ── Schema definition types ────────────────────────────────────────────────────

export type FieldType = 'string' | 'long' | 'int' | 'double' | 'boolean' | 'bytes';

export interface SchemaField {
  name: string;
  type: FieldType;
  /** Optional fields may be absent; they are the only backward-compatible add. */
  optional?: boolean;
  /** Default applied when an older writer omits a newer optional field. */
  default?: string | number | boolean | null;
  doc?: string;
}

export interface EventSchema {
  /** Logical subject, e.g. `soroban.tx.confirmed`. */
  subject: string;
  /** Monotonic version within the subject, starting at 1. */
  version: number;
  /** Globally-unique id assigned by the registry on registration. */
  id: number;
  /** Wire format the payload is encoded with. */
  format: 'avro' | 'protobuf' | 'json';
  fields: SchemaField[];
}

export type CompatibilityMode = 'BACKWARD' | 'FORWARD' | 'FULL' | 'NONE';

export interface Envelope<T = Record<string, unknown>> {
  /** Magic byte — 0 identifies the single-object encoding. */
  magic: 0;
  schemaId: number;
  subject: string;
  version: number;
  payload: T;
}

// ── Registry ────────────────────────────────────────────────────────────────

export class SchemaRegistry {
  private byId = new Map<number, EventSchema>();
  private bySubject = new Map<string, EventSchema[]>();
  private compat = new Map<string, CompatibilityMode>();
  private nextId = 1;

  /**
   * Register a new schema version for a subject. Returns the existing schema
   * (idempotent) when an identical field set is re-registered, otherwise
   * validates compatibility against the latest version and assigns a new id.
   */
  register(
    subject: string,
    fields: SchemaField[],
    format: EventSchema['format'] = 'avro',
  ): EventSchema {
    const versions = this.bySubject.get(subject) ?? [];
    const latest = versions[versions.length - 1];

    if (latest && fingerprint(latest.fields) === fingerprint(fields)) {
      return latest; // identical schema — idempotent registration
    }

    if (latest) {
      const mode = this.compat.get(subject) ?? 'BACKWARD';
      const violation = checkCompatibility(mode, latest.fields, fields);
      if (violation) {
        throw new SchemaCompatibilityError(subject, mode, violation);
      }
    }

    const schema: EventSchema = {
      subject,
      version: (latest?.version ?? 0) + 1,
      id: this.nextId++,
      format,
      fields,
    };
    this.byId.set(schema.id, schema);
    this.bySubject.set(subject, [...versions, schema]);
    return schema;
  }

  setCompatibility(subject: string, mode: CompatibilityMode): void {
    this.compat.set(subject, mode);
  }

  getCompatibility(subject: string): CompatibilityMode {
    return this.compat.get(subject) ?? 'BACKWARD';
  }

  getById(id: number): EventSchema | undefined {
    return this.byId.get(id);
  }

  latest(subject: string): EventSchema | undefined {
    const versions = this.bySubject.get(subject);
    return versions?.[versions.length - 1];
  }

  versions(subject: string): EventSchema[] {
    return [...(this.bySubject.get(subject) ?? [])];
  }

  subjects(): string[] {
    return [...this.bySubject.keys()];
  }

  // ── Encode / decode (single-object envelope) ──────────────────────────────

  encode<T extends Record<string, unknown>>(subject: string, payload: T): Envelope<T> {
    const schema = this.latest(subject);
    if (!schema) throw new Error(`No schema registered for subject "${subject}"`);
    const validated = coerceToSchema(schema, payload);
    return {
      magic: 0,
      schemaId: schema.id,
      subject,
      version: schema.version,
      payload: validated as T,
    };
  }

  decode<T = Record<string, unknown>>(envelope: Envelope): T {
    const schema = this.byId.get(envelope.schemaId);
    if (!schema) throw new Error(`Unknown schemaId ${envelope.schemaId} in envelope`);
    return coerceToSchema(schema, envelope.payload) as T;
  }
}

// ── Compatibility checking ────────────────────────────────────────────────────

export class SchemaCompatibilityError extends Error {
  constructor(
    public subject: string,
    public mode: CompatibilityMode,
    public violation: string,
  ) {
    super(`Schema for "${subject}" violates ${mode} compatibility: ${violation}`);
    this.name = 'SchemaCompatibilityError';
  }
}

/**
 * Returns a human-readable violation string, or null when `next` is compatible
 * with `prev` under `mode`.
 *
 *  - BACKWARD: new consumers can read old data → may delete fields or add
 *    optional fields; may NOT add required fields or change types.
 *  - FORWARD: old consumers can read new data → may add fields or delete
 *    optional fields; may NOT delete required fields or change types.
 *  - FULL: both of the above.
 */
export function checkCompatibility(
  mode: CompatibilityMode,
  prev: SchemaField[],
  next: SchemaField[],
): string | null {
  if (mode === 'NONE') return null;

  const prevByName = new Map(prev.map((f) => [f.name, f]));
  const nextByName = new Map(next.map((f) => [f.name, f]));

  const backwardOk = (): string | null => {
    for (const f of next) {
      const before = prevByName.get(f.name);
      if (!before && !f.optional && f.default === undefined) {
        return `added required field "${f.name}" without a default`;
      }
      if (before && before.type !== f.type) {
        return `type of "${f.name}" changed ${before.type} → ${f.type}`;
      }
    }
    return null;
  };

  const forwardOk = (): string | null => {
    for (const f of prev) {
      const after = nextByName.get(f.name);
      if (!after && !f.optional) {
        return `removed required field "${f.name}"`;
      }
      if (after && after.type !== f.type) {
        return `type of "${f.name}" changed ${f.type} → ${after.type}`;
      }
    }
    return null;
  };

  if (mode === 'BACKWARD') return backwardOk();
  if (mode === 'FORWARD') return forwardOk();
  return backwardOk() ?? forwardOk(); // FULL
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fingerprint(fields: SchemaField[]): string {
  return fields
    .map((f) => `${f.name}:${f.type}:${f.optional ? '?' : '!'}`)
    .sort()
    .join('|');
}

/**
 * Validate a payload against a schema and fill in defaults for missing optional
 * fields. Throws on missing required fields or gross type mismatches — the same
 * guarantees an Avro writer gives you at serialization time.
 */
function coerceToSchema(
  schema: EventSchema,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of schema.fields) {
    const present = Object.prototype.hasOwnProperty.call(payload, field.name);
    if (!present) {
      if (field.optional || field.default !== undefined) {
        out[field.name] = field.default ?? null;
        continue;
      }
      throw new Error(`Missing required field "${field.name}" for subject "${schema.subject}"`);
    }
    const value = payload[field.name];
    if (value !== null && !typeMatches(field.type, value)) {
      throw new Error(
        `Field "${field.name}" expected ${field.type}, got ${typeof value} for subject "${schema.subject}"`,
      );
    }
    out[field.name] = value;
  }
  return out;
}

function typeMatches(type: FieldType, value: unknown): boolean {
  switch (type) {
    case 'string':
    case 'bytes':
      return typeof value === 'string';
    case 'int':
    case 'long':
    case 'double':
      return typeof value === 'number';
    case 'boolean':
      return typeof value === 'boolean';
    default:
      return false;
  }
}

// ── Default registry seeded with the core Soroban event schemas ──────────────

export const CORE_SCHEMAS: Record<string, SchemaField[]> = {
  'soroban.tx.confirmed': [
    { name: 'network_id', type: 'string' },
    { name: 'tx_hash', type: 'string' },
    { name: 'ledger_sequence', type: 'long' },
    { name: 'ledger_close_time', type: 'string' },
    { name: 'contract_id', type: 'string' },
    { name: 'wallet_address', type: 'string' },
    { name: 'operation_type', type: 'string' },
    { name: 'fee_charged', type: 'long' },
    { name: 'resource_instructions', type: 'long' },
    { name: 'status', type: 'string' },
  ],
  'soroban.swap.executed': [
    { name: 'network_id', type: 'string' },
    { name: 'tx_hash', type: 'string' },
    { name: 'ledger_sequence', type: 'long' },
    { name: 'ledger_close_time', type: 'string' },
    { name: 'contract_id', type: 'string' },
    { name: 'wallet_address', type: 'string' },
    { name: 'token_in', type: 'string' },
    { name: 'token_out', type: 'string' },
    { name: 'amount_in', type: 'double' },
    { name: 'amount_out', type: 'double' },
  ],
  'soroban.gas.sample': [
    { name: 'network_id', type: 'string' },
    { name: 'ledger_sequence', type: 'long' },
    { name: 'ledger_close_time', type: 'string' },
    { name: 'fee_charged', type: 'long' },
    { name: 'resource_instructions', type: 'long' },
  ],
};

/** Build a registry pre-loaded with the core Soroban event schemas. */
export function createDefaultRegistry(): SchemaRegistry {
  const registry = new SchemaRegistry();
  for (const [subject, fields] of Object.entries(CORE_SCHEMAS)) {
    registry.register(subject, fields, 'avro');
  }
  return registry;
}
