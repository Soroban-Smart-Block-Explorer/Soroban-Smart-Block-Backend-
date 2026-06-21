import { prismaRead as prisma } from '../db';

export interface StructField {
  name: string;
  type: string;
  size?: number;
}

export interface StructLayout {
  name: string;
  fields: StructField[];
  totalSize: number;
}

export interface StorageTrapAlert {
  contractAddress: string;
  severity: 'critical' | 'warning';
  trapType: 'unversioned_struct_expansion' | 'field_reordering' | 'type_change';
  oldLayout: StructLayout;
  newLayout: StructLayout;
  affectedFields: string[];
  message: string;
}

/**
 * Compare old and new struct layouts to detect UnexpectedSize errors.
 * Flags unversioned struct expansions that will cause host-level failures.
 */
export async function analyzeStorageTrap(
  contractAddress: string,
  oldAbi: any,
  newAbi: any,
): Promise<StorageTrapAlert[]> {
  const alerts: StorageTrapAlert[] = [];

  if (!oldAbi?.types || !newAbi?.types) return alerts;

  const oldStructs = extractStructs(oldAbi.types);
  const newStructs = extractStructs(newAbi.types);

  for (const [structName, newLayout] of Object.entries(newStructs)) {
    const oldLayout = oldStructs[structName];
    if (!oldLayout) continue;

    const oldLayoutTyped = oldLayout as StructLayout;
    const newLayoutTyped = newLayout as StructLayout;

    // Detect unversioned expansion
    if (newLayoutTyped.totalSize > oldLayoutTyped.totalSize) {
      const newFieldNames = new Set(newLayoutTyped.fields.map((f) => f.name));
      const oldFieldNames = new Set(oldLayoutTyped.fields.map((f) => f.name));
      const addedFields = Array.from(newFieldNames).filter((f) => !oldFieldNames.has(f));

      if (addedFields.length > 0 && !isVersionedEnum(newAbi, structName)) {
        alerts.push({
          contractAddress,
          severity: 'critical',
          trapType: 'unversioned_struct_expansion',
          oldLayout: oldLayoutTyped,
          newLayout: newLayoutTyped,
          affectedFields: addedFields,
          message: `Struct '${structName}' expanded without versioning. Added fields: ${addedFields.join(', ')}. Will cause UnexpectedSize error.`,
        });
      }
    }

    // Detect field reordering
    const reorderedFields = detectFieldReordering(oldLayoutTyped, newLayoutTyped);
    if (reorderedFields.length > 0) {
      alerts.push({
        contractAddress,
        severity: 'warning',
        trapType: 'field_reordering',
        oldLayout: oldLayoutTyped,
        newLayout: newLayoutTyped,
        affectedFields: reorderedFields,
        message: `Struct '${structName}' fields reordered: ${reorderedFields.join(', ')}.`,
      });
    }

    // Detect type changes
    const typeChanges = detectTypeChanges(oldLayoutTyped, newLayoutTyped);
    if (typeChanges.length > 0) {
      alerts.push({
        contractAddress,
        severity: 'critical',
        trapType: 'type_change',
        oldLayout: oldLayoutTyped,
        newLayout: newLayoutTyped,
        affectedFields: typeChanges,
        message: `Struct '${structName}' field types changed: ${typeChanges.join(', ')}.`,
      });
    }
  }

  return alerts;
}

function extractStructs(types: any[]): Record<string, StructLayout> {
  const structs: Record<string, StructLayout> = {};

  for (const type of types) {
    if (type.kind === 'struct') {
      structs[type.name] = {
        name: type.name,
        fields: type.fields || [],
        totalSize: calculateStructSize(type.fields || []),
      };
    }
  }

  return structs;
}

function calculateStructSize(fields: StructField[]): number {
  return fields.reduce((sum, field) => sum + (field.size || 8), 0);
}

function isVersionedEnum(abi: any, structName: string): boolean {
  if (!abi.types) return false;
  return abi.types.some(
    (t: any) => t.kind === 'enum' && t.name === `${structName}Version` && t.variants?.length > 0,
  );
}

function detectFieldReordering(oldLayout: StructLayout, newLayout: StructLayout): string[] {
  const oldOrder = oldLayout.fields.map((f) => f.name);
  const newOrder = newLayout.fields.map((f) => f.name);

  const reordered: string[] = [];
  for (let i = 0; i < Math.min(oldOrder.length, newOrder.length); i++) {
    if (oldOrder[i] !== newOrder[i]) {
      reordered.push(`${oldOrder[i]} → position ${i}`);
    }
  }

  return reordered;
}

function detectTypeChanges(oldLayout: StructLayout, newLayout: StructLayout): string[] {
  const changes: string[] = [];
  const newFieldMap = new Map(newLayout.fields.map((f) => [f.name, f]));

  for (const oldField of oldLayout.fields) {
    const newField = newFieldMap.get(oldField.name);
    if (newField && oldField.type !== newField.type) {
      changes.push(`${oldField.name}: ${oldField.type} → ${newField.type}`);
    }
  }

  return changes;
}

/**
 * Mark contract with storage trap alert badge.
 */
export async function markStorageTrapAlert(
  contractAddress: string,
  alerts: StorageTrapAlert[],
): Promise<void> {
  if (alerts.length === 0) return;

  const criticalAlerts = alerts.filter((a) => a.severity === 'critical');
  const alertBadge = {
    hasStorageTrap: true,
    trapCount: alerts.length,
    criticalCount: criticalAlerts.length,
    alerts: alerts.map((a) => ({
      type: a.trapType,
      fields: a.affectedFields,
      message: a.message,
    })),
  };

  const contract = await prisma.contract.findUnique({
    where: { address: contractAddress },
    select: { abi: true },
  });

  const existingAbi =
    typeof contract?.abi === 'object' && contract?.abi !== null ? contract.abi : {};

  await prisma.contract.update({
    where: { address: contractAddress },
    data: {
      abi: {
        ...existingAbi,
        _storageTrapAlert: alertBadge,
      },
    },
  });
}
