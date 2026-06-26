import axios from 'axios';
import { prismaWrite, prismaRead } from '../../db';
import { logger } from '../../logger';
import { recordAudit } from './audit';

const OFAC_SDN_URL = 'https://www.treasury.gov/ofac/downloads/sdn.xml';
const OFAC_SDN_CSV_URL = 'https://www.treasury.gov/ofac/downloads/sdn.csv';
const OFAC_CAP_URL = 'https://www.treasury.gov/ofac/downloads/consolidated/consolidated.xml';
const EU_SANCTIONS_URL = 'https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1/content';
const UN_SANCTIONS_URL = 'https://scsanctions.un.org/resources/xml/en/consolidated.xml';
const UK_OFSI_URL = 'https://ofsistorage.blob.core.windows.net/publishlive/2022format/ConList.xml';

export type SanctionsSource = 'ofac_sdn' | 'ofac_cap' | 'eu' | 'un' | 'uk_ofsi' | 'custom';

interface FetchedEntry {
  source: SanctionsSource;
  sourceUrl?: string;
  listVersion: string;
  listName?: string;
  entityType: string;
  address?: string;
  addressPattern?: string;
  name?: string;
  aliases: string[];
  program?: string;
  country?: string;
  idDocument?: string;
  citizenship: string[];
  birthDate?: string;
  placeOfBirth?: string;
  title?: string;
  addedToListAt: Date;
}

function parseXmlToEntries(xml: string, source: SanctionsSource): FetchedEntry[] {
  const entries: FetchedEntry[] = [];
  try {
    const nameMatches = xml.match(/<[^>]*?(?:FirstName|LastName|IdentityName|PartyName)[^>]*>([^<]+)<\/[^>]*?>/gi);
    const programs: string[] = [];
    const programMatches = xml.match(/<Program[^>]*>([^<]+)<\/Program>/gi);
    if (programMatches) {
      programMatches.forEach(m => {
        const v = m.replace(/<\/?[^>]+>/g, '').trim();
        if (v) programs.push(v);
      });
    }
    const idMatches = xml.match(/<ID[^>]*>([^<]+)<\/ID>/gi);
    const ids: string[] = [];
    if (idMatches) {
      idMatches.forEach(m => {
        const v = m.replace(/<\/?[^>]+>/g, '').trim();
        if (v) ids.push(v);
      });
    }
    const countryMatches = xml.match(/<Country[^>]*>([^<]+)<\/Country>/gi);

    const names = nameMatches?.map(m => m.replace(/<\/?[^>]+>/g, '').trim()).filter(Boolean) ?? [];
    const uniqueNames = [...new Set(names)];
    const countries = countryMatches?.map(m => m.replace(/<\/?[^>]+>/g, '').trim()).filter(Boolean) ?? [];

    if (uniqueNames.length === 0) {
      const textBlocks = xml.match(/>([A-Z][A-Za-z\s,.'-]{2,})</g);
      if (textBlocks) {
        const filtered = textBlocks
          .map(t => t.replace(/[<>]/g, '').trim())
          .filter(t => t.length > 3 && t.length < 200 && !t.startsWith('<?') && !t.startsWith('!'));
        uniqueNames.push(...filtered.slice(0, 100));
      }
    }

    const listVersion = new Date().toISOString().split('T')[0];
    const listName = `${source} sanctions list`;

    for (const name of uniqueNames.slice(0, 500)) {
      entries.push({
        source,
        sourceUrl: getSourceUrl(source),
        listVersion,
        listName,
        entityType: 'individual',
        name,
        aliases: [],
        program: programs[0] ?? undefined,
        country: countries[0] ?? undefined,
        idDocument: ids[0] ?? undefined,
        citizenship: [],
        addedToListAt: new Date(),
      });
    }
  } catch (err) {
    logger.error(`Failed to parse XML for ${source}`, { error: (err as Error).message });
  }
  return entries;
}

function parseCsvToEntries(csv: string, source: SanctionsSource): FetchedEntry[] {
  const entries: FetchedEntry[] = [];
  try {
    const lines = csv.split('\n').filter(l => l.trim());
    if (lines.length < 2) return entries;
    const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
    const listVersion = new Date().toISOString().split('T')[0];

    for (let i = 1; i < Math.min(lines.length, 500); i++) {
      const values = lines[i].split(',').map(v => v.trim().replace(/^"|"$/g, ''));
      const row: Record<string, string> = {};
      headers.forEach((h, idx) => { row[h] = values[idx] ?? ''; });

      entries.push({
        source,
        sourceUrl: getSourceUrl(source),
        listVersion,
        listName: `${source} sanctions list`,
        entityType: row.type ?? 'individual',
        name: row.name ?? (row.first_name && row.last_name ? `${row.first_name} ${row.last_name}` : undefined),
        aliases: row.aliases ? row.aliases.split(';') : [],
        program: row.program ?? undefined,
        country: row.country ?? undefined,
        idDocument: row.id ?? undefined,
        citizenship: row.citizenship ? row.citizenship.split(';') : [],
        addedToListAt: new Date(),
      });
    }
  } catch (err) {
    logger.error(`Failed to parse CSV for ${source}`, { error: (err as Error).message });
  }
  return entries;
}

function getSourceUrl(source: SanctionsSource): string {
  const urls: Record<SanctionsSource, string> = {
    ofac_sdn: OFAC_SDN_URL,
    ofac_cap: OFAC_CAP_URL,
    eu: EU_SANCTIONS_URL,
    un: UN_SANCTIONS_URL,
    uk_ofsi: UK_OFSI_URL,
    custom: '',
  };
  return urls[source];
}

export interface FetchResult {
  source: SanctionsSource;
  entriesFound: number;
  entriesImported: number;
  listVersion: string;
  errors: string[];
}

export async function fetchSanctionsList(source: SanctionsSource): Promise<FetchResult> {
  const result: FetchResult = {
    source,
    entriesFound: 0,
    entriesImported: 0,
    listVersion: new Date().toISOString().split('T')[0],
    errors: [],
  };

  try {
    const url = getSourceUrl(source);
    if (!url) {
      result.errors.push(`No URL configured for source: ${source}`);
      return result;
    }

    logger.info(`Fetching sanctions list: ${source} from ${url}`);
    const response = await axios.get(url, { timeout: 60000 });
    const contentType = response.headers['content-type'] ?? '';
    let entries: FetchedEntry[];

    const ct = Array.isArray(contentType) ? contentType.join(',') : (contentType as string);
    if (ct.includes('csv') || url.endsWith('.csv')) {
      entries = parseCsvToEntries(response.data as string, source);
    } else {
      entries = parseXmlToEntries(response.data as string, source);
    }

    result.entriesFound = entries.length;
    if (entries.length === 0) {
      result.errors.push(`No entries parsed from ${source} response`);
      return result;
    }

    const existingCount = await prismaWrite.sanctionsList.count({
      where: { source, listVersion: result.listVersion },
    });

    if (existingCount > 0) {
      logger.info(`List ${source} version ${result.listVersion} already exists, updating`);
      await prismaWrite.sanctionsList.updateMany({
        where: { source, listVersion: result.listVersion },
        data: { isActive: false },
      });
    }

    const batchSize = 100;
    for (let i = 0; i < entries.length; i += batchSize) {
      const batch = entries.slice(i, i + batchSize);
      await prismaWrite.sanctionsList.createMany({
        data: batch.map(e => ({
          source: e.source,
          sourceUrl: e.sourceUrl,
          listVersion: e.listVersion,
          listName: e.listName,
          entityType: e.entityType,
          address: e.address,
          addressPattern: e.addressPattern,
          name: e.name,
          aliases: e.aliases,
          program: e.program,
          country: e.country,
          idDocument: e.idDocument,
          citizenship: e.citizenship,
          birthDate: e.birthDate,
          placeOfBirth: e.placeOfBirth,
          title: e.title,
          isActive: true,
          addedToListAt: e.addedToListAt,
        })),
        skipDuplicates: true,
      });
    }

    result.entriesImported = entries.length;
    recordAudit({
      action: 'refresh_lists',
      resourceType: 'sanctions_list',
      resourceId: source,
      details: { entriesFound: entries.length, listVersion: result.listVersion },
    });

    logger.info(`Successfully imported ${entries.length} entries from ${source}`);
  } catch (err) {
    const msg = (err as Error).message;
    result.errors.push(msg);
    logger.error(`Failed to fetch sanctions list ${source}`, { error: msg });
  }

  return result;
}

export async function refreshAllLists(): Promise<FetchResult[]> {
  const sources: SanctionsSource[] = ['ofac_sdn', 'ofac_cap', 'eu', 'un', 'uk_ofsi'];
  const results = await Promise.allSettled(sources.map(s => fetchSanctionsList(s)));
  return results.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    return {
      source: sources[i],
      entriesFound: 0,
      entriesImported: 0,
      listVersion: '',
      errors: [(r.reason as Error).message],
    };
  });
}

export async function importCustomList(
  data: FetchedEntry[],
  listName: string,
): Promise<FetchResult> {
  const result: FetchResult = {
    source: 'custom',
    entriesFound: data.length,
    entriesImported: 0,
    listVersion: new Date().toISOString().split('T')[0],
    errors: [],
  };

  try {
    const batchSize = 100;
    for (let i = 0; i < data.length; i += batchSize) {
      const batch = data.slice(i, i + batchSize);
      await prismaWrite.sanctionsList.createMany({
        data: batch.map(e => ({
          source: 'custom',
          listName,
          listVersion: result.listVersion,
          entityType: e.entityType,
          name: e.name,
          aliases: e.aliases,
          address: e.address,
          addressPattern: e.addressPattern,
          program: e.program,
          country: e.country,
          isActive: true,
          addedToListAt: new Date(),
        })),
        skipDuplicates: true,
      });
    }
    result.entriesImported = data.length;
    recordAudit({
      action: 'import_list',
      resourceType: 'sanctions_list',
      resourceId: `custom:${listName}`,
      details: { entries: data.length, listVersion: result.listVersion },
    });
  } catch (err) {
    result.errors.push((err as Error).message);
  }

  return result;
}

export async function getListVersions(source: string): Promise<{ version: string; count: number; active: number }[]> {
  const results = await prismaRead.sanctionsList.groupBy({
    by: ['listVersion'],
    where: { source },
    _count: true,
  });

  return results.map(r => ({
    version: r.listVersion,
    count: r._count,
    active: 0,
  }));
}

export async function getChangelog(days: number = 30): Promise<{
  date: string;
  source: string;
  additions: number;
  removals: number;
}[]> {
  const since = new Date(Date.now() - days * 86400000);
  const recent = await prismaRead.sanctionsList.findMany({
    where: { importedAt: { gte: since } },
    select: { source: true, importedAt: true, isActive: true, listVersion: true },
    orderBy: { importedAt: 'desc' },
  });

  const grouped = new Map<string, { source: string; additions: number; removals: number }>();
  for (const r of recent) {
    const key = `${r.importedAt.toISOString().split('T')[0]}_${r.source}`;
    const existing = grouped.get(key) ?? { source: r.source, additions: 0, removals: 0 };
    if (r.isActive) existing.additions++;
    else existing.removals++;
    grouped.set(key, existing);
  }

  return Array.from(grouped.entries()).map(([key, val]) => ({
    date: key.split('_')[0],
    source: val.source,
    additions: val.additions,
    removals: val.removals,
  }));
}

export async function deleteCustomList(id: string): Promise<void> {
  await prismaWrite.sanctionsList.update({
    where: { id },
    data: { isActive: false },
  });
  recordAudit({
    action: 'delete_list',
    resourceType: 'sanctions_list',
    resourceId: id,
  });
}
