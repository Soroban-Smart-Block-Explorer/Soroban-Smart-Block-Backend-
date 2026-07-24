import { prismaRead, prismaWrite } from '../../db';

export interface Suggestion {
  prefix: string;
  suffix: string | null;
  docType: string;
  docId: string;
  label: string;
  weight: number;
}

export async function indexSuggestion(
  docType: string,
  docId: string,
  label: string,
  weight = 1,
): Promise<void> {
  const parts = label.toLowerCase().split(/\s+/);

  for (const part of parts) {
    if (part.length < 2) continue;

    for (let i = 1; i <= part.length; i++) {
      const prefix = part.slice(0, i);
      const suffix = part.slice(i) || null;

      await prismaWrite.searchSuggestion.upsert({
        where: {
          docType_prefix_docId: {
            docType,
            prefix,
            docId,
          },
        } as never,
        create: {
          prefix,
          suffix,
          docType,
          docId,
          label,
          weight,
        },
        update: {
          weight: { increment: 1 },
        },
      } as never);
    }
  }
}

export async function queryAutocomplete(
  prefix: string,
  docType?: string,
  limit = 10,
): Promise<Suggestion[]> {
  const where: Record<string, unknown> = {
    prefix: { startsWith: prefix.toLowerCase() },
  };
  if (docType) where.docType = docType;

  const rows = await prismaRead.searchSuggestion.findMany({
    where,
    orderBy: { weight: 'desc' },
    take: limit,
    select: {
      prefix: true,
      suffix: true,
      docType: true,
      docId: true,
      label: true,
      weight: true,
    },
  });

  const seen = new Set<string>();
  const unique: Suggestion[] = [];
  for (const r of rows) {
    const key = `${r.docType}:${r.label}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(r);
    }
  }

  return unique.slice(0, limit);
}

export async function querySuffixAutocomplete(
  suffix: string,
  docType?: string,
  limit = 10,
): Promise<Suggestion[]> {
  const where: Record<string, unknown> = {
    suffix: { startsWith: suffix.toLowerCase() },
  };
  if (docType) where.docType = docType;

  const rows = await prismaRead.searchSuggestion.findMany({
    where,
    orderBy: { weight: 'desc' },
    take: limit,
    select: {
      prefix: true,
      suffix: true,
      docType: true,
      docId: true,
      label: true,
      weight: true,
    },
  });

  const seen = new Set<string>();
  const unique: Suggestion[] = [];
  for (const r of rows) {
    const key = `${r.docType}:${r.label}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(r);
    }
  }

  return unique.slice(0, limit);
}

export async function clearSuggestions(): Promise<void> {
  await prismaWrite.searchSuggestion.deleteMany({});
}
