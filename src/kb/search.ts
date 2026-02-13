/**
 * Semantic search over knowledge base using sqlite-vss
 */

import type { SearchResult } from './types.js';
import type { SourceType } from './types.js';
import { generateEmbedding, isAvailable, serializeFloat32 } from './embeddings.js';
import { getDatabase } from './storage.js';
import { logger } from '../logger.js';

export interface SearchOptions {
  groupFolder?: string;
  limit?: number;
  minSimilarity?: number;
  dedupeBySource?: boolean;
}

interface SearchRow {
  id: number;
  source_id: string;
  content: string;
  source_url: string | null;
  source_title: string | null;
  source_type: string;
}

/**
 * Sort by similarity, optionally dedupe by source, and cap at limit.
 */
function processAndRankResults(
  results: SearchResult[],
  limit: number,
  dedupeBySource: boolean,
): SearchResult[] {
  results.sort((a, b) => b.similarity - a.similarity);

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
 * Search knowledge base for relevant content using sqlite-vss
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

  const db = getDatabase();

  // Try to use sqlite-vss for efficient similarity search
  try {
    // Fetch more results to account for filtering and deduplication
    const fetchLimit = limit * 3;

    let sql = `
      SELECT
        c.id, c.source_id, c.content,
        s.url as source_url, s.title as source_title, s.source_type
      FROM kb_chunks_vss v
      JOIN kb_chunks c ON v.rowid = c.id
      JOIN kb_sources s ON c.source_id = s.id
      WHERE vss_search(
        v.embedding,
        vss_search_params(?, ?)
      )
    `;

    const vssParams: unknown[] = [
      serializeFloat32(queryEmbedding),
      fetchLimit,
    ];

    if (groupFolder) {
      sql += ' AND s.group_folder = ?';
      vssParams.push(groupFolder);
    }

    const rows = db.prepare(sql).all(...vssParams) as (SearchRow & { distance: number })[];

    // Calculate cosine similarity from L2 distance and filter
    const results: SearchResult[] = rows
      .map((row) => {
        // distance is sqrt(2 - 2 * cosine_similarity)
        // So: distance^2 = 2 - 2*cosine_similarity
        // cosine_similarity = (2 - distance^2) / 2
        const similarity = Math.max(0, 1 - (row.distance * row.distance) / 2);
        return {
          chunk_id: row.id,
          source_id: row.source_id,
          source_url: row.source_url ?? undefined,
          source_title: row.source_title ?? undefined,
          source_type: row.source_type as SourceType,
          content: row.content,
          similarity,
        };
      })
      .filter((r) => r.similarity >= minSimilarity);

    return processAndRankResults(results, limit, dedupeBySource);
  } catch (err) {
    logger.debug({ err }, 'VSS search failed, falling back to manual similarity');
    // Fall back to manual similarity calculation
    return fallbackSearch(queryEmbedding, options);
  }
}

/**
 * Fallback manual similarity search when VSS is not available
 */
async function fallbackSearch(
  queryEmbedding: Float32Array,
  options: SearchOptions,
): Promise<SearchResult[]> {
  const { groupFolder, limit = 10, minSimilarity = 0.7, dedupeBySource = true } = options;
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

  const rows = db.prepare(sql).all(...params) as (SearchRow & { embedding: Buffer })[];

  // Calculate similarities
  const results: SearchResult[] = [];

  for (const row of rows) {
    if (!row.embedding) continue;

    const chunkEmbedding = new Float32Array(
      row.embedding.buffer.slice(row.embedding.byteOffset, row.embedding.byteOffset + row.embedding.byteLength)
    );
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

  return processAndRankResults(results, limit, dedupeBySource);
}

/**
 * Calculate cosine similarity between two vectors
 */
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
  if (magnitude === 0) return 0;

  return dotProduct / magnitude;
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
