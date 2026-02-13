/**
 * Semantic search over knowledge base
 */

import type { SearchResult } from './types.js';
import type { KBChunk } from './types.js';
import type { SourceType } from './types.js';
import { generateEmbedding, cosineSimilarity, isAvailable } from './embeddings.js';
import { getDatabase } from './storage.js';
import { deserializeFloat32 } from './embeddings.js';
import { logger } from '../logger.js';

export interface SearchOptions {
  groupFolder?: string;
  limit?: number;
  minSimilarity?: number;
  dedupeBySource?: boolean;
}

/**
 * Search knowledge base for relevant content
 */
export async function search(
  query: string,
  options: SearchOptions = {},
): Promise<SearchResult[]> {
  const {
    groupFolder,
    limit = 10,
    minSimilarity = 0.7,
    dedupeBySource = true,
  } = options;

  // Check if embeddings are available
  if (!isAvailable()) {
    logger.warn('Search skipped: Ollama not available');
    return [];
  }

  // Generate query embedding
  const queryEmbedding = await generateEmbedding(query);
  if (!queryEmbedding) {
    logger.warn('Search failed: could not generate query embedding');
    return [];
  }

  // Get all chunks with embeddings
  const db = getDatabase();

  let sql = `
    SELECT c.id, c.source_id, c.content, c.embedding,
           s.url as source_url, s.title as source_title, s.source_type
    FROM kb_chunks c
    JOIN kb_sources s ON c.source_id = s.id
    WHERE c.embedding IS NOT NULL
  `;

  const params: unknown[] = [];

  if (groupFolder) {
    sql += ' AND s.group_folder = ?';
    params.push(groupFolder);
  }

  const rows = db.prepare(sql).all(...params) as SearchRow[];

  // Calculate similarities
  const results: SearchResult[] = [];

  for (const row of rows) {
    if (!row.embedding) continue;

    const chunkEmbedding = deserializeFloat32(row.embedding);
    const similarity = cosineSimilarity(queryEmbedding, chunkEmbedding);

    if (similarity >= minSimilarity) {
      results.push({
        chunk_id: row.id,
        source_id: row.source_id,
        source_url: row.source_url ?? undefined,
        source_title: row.source_title ?? undefined,
        source_type: row.source_type as SourceType,
        content: row.content,
        similarity,
      });
    }
  }

  // Sort by similarity descending
  results.sort((a, b) => b.similarity - a.similarity);

  // Dedupe by source (keep best chunk per source)
  let finalResults = results;
  if (dedupeBySource) {
    const bestBySource = new Map<string, SearchResult>();

    for (const r of results) {
      const existing = bestBySource.get(r.source_id);
      if (!existing || r.similarity > existing.similarity) {
        bestBySource.set(r.source_id, r);
      }
    }

    finalResults = Array.from(bestBySource.values());
    finalResults.sort((a, b) => b.similarity - a.similarity);
  }

  return finalResults.slice(0, limit);
}

/**
 * Format search results for LLM context
 */
export function formatSearchResults(
  results: SearchResult[],
  maxChars = 2500,
): string {
  if (results.length === 0) {
    return '';
  }

  let output = `Found ${results.length} relevant source${results.length > 1 ? 's' : ''}:\n\n`;

  let currentChars = output.length;

  for (const r of results) {
    const source = r.source_title || r.source_url || 'Unknown';
    const snippet = r.content.slice(0, 500);

    const entry = `[${r.source_type}] ${source}\n${snippet}...\n`;

    if (currentChars + entry.length > maxChars) {
      output += '\n...(truncated)';
      break;
    }

    output += entry;
    currentChars += entry.length;
  }

  return output;
}

/**
 * Find similar sources (for recommendations)
 */
export async function findSimilar(
  sourceId: string,
  limit = 5,
): Promise<SearchResult[]> {
  const db = getDatabase();

  // Get the source's chunks
  const chunks = db
    .prepare('SELECT embedding FROM kb_chunks WHERE source_id = ? AND embedding IS NOT NULL LIMIT 1')
    .all(sourceId) as { embedding: Buffer }[];

  if (chunks.length === 0) {
    return [];
  }

  const referenceEmbedding = deserializeFloat32(chunks[0].embedding);

  // Find similar chunks from other sources
  const rows = db
    .prepare(`
      SELECT c.id, c.source_id, c.content, c.embedding,
             s.url as source_url, s.title as source_title, s.source_type
      FROM kb_chunks c
      JOIN kb_sources s ON c.source_id = s.id
      WHERE c.source_id != ? AND c.embedding IS NOT NULL
    `)
    .all(sourceId) as SearchRow[];

  const results: SearchResult[] = [];

  for (const row of rows) {
    if (!row.embedding) continue;

    const chunkEmbedding = deserializeFloat32(row.embedding);
    const similarity = cosineSimilarity(referenceEmbedding, chunkEmbedding);

    if (similarity >= 0.6) {
      results.push({
        chunk_id: row.id,
        source_id: row.source_id,
        source_url: row.source_url ?? undefined,
        source_title: row.source_title ?? undefined,
        source_type: row.source_type as SourceType,
        content: row.content,
        similarity,
      });
    }
  }

  results.sort((a, b) => b.similarity - a.similarity);

  // Dedupe by source
  const bestBySource = new Map<string, SearchResult>();
  for (const r of results) {
    const existing = bestBySource.get(r.source_id);
    if (!existing || r.similarity > existing.similarity) {
      bestBySource.set(r.source_id, r);
    }
  }

  return Array.from(bestBySource.values())
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);
}

interface SearchRow {
  id: number;
  source_id: string;
  content: string;
  embedding: Buffer;
  source_url: string | null;
  source_title: string | null;
  source_type: string;
}
