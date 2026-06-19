import type { NormalizedEntry } from '../parser/har-normalizer.js';

export interface EntryCluster {
  signature: string;
  method: string;
  normalizedPath: string;
  baseUrl: string;
  entries: NormalizedEntry[];
}

export function clusterEntries(entries: NormalizedEntry[]): EntryCluster[] {
  const groups = new Map<string, NormalizedEntry[]>();

  for (const entry of entries) {
    const method = entry.entry.request.method.toUpperCase();
    const signature = `${method} ${entry.normalizedPath}`;
    const existing = groups.get(signature);
    if (existing) {
      existing.push(entry);
    } else {
      groups.set(signature, [entry]);
    }
  }

  const clusters: EntryCluster[] = [];
  for (const [signature, clusterEntries] of groups) {
    const [method, ...pathParts] = signature.split(' ');
    const normalizedPath = pathParts.join(' ');
    clusters.push({
      signature,
      method: method.toLowerCase(),
      normalizedPath,
      baseUrl: clusterEntries[0].baseUrl,
      entries: clusterEntries,
    });
  }

  return clusters;
}
