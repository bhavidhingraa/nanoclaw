/**
 * Knowledge Base Module - Main Entry Point
 */

import type Database from 'better-sqlite3';
import { initKBTables } from './storage.js';
import { KBLock } from './locks.js';
import { checkOllamaHealth } from './embeddings.js';
import { logger } from '../logger.js';

// Re-export types
export * from './types.js';

// Re-export storage functions
export {
  initKBTables,
  createSource,
  getSourceById,
  getSourceByHash,
  getSourceByUrl,
  listSources,
  updateSource,
  deleteSource,
  createChunk,
  getChunksBySourceId,
  deleteChunksBySourceId,
  getAllChunks,
  getChunkById,
  getDatabase as getKBDatabase,
} from './storage.js';

// Re-export ingest functions
export {
  ingestUrl,
  updateUrl,
  ingestContent,
  updateContent,
  detectSourceType,
  extractContent,
  deleteSource as deleteKBSource,
  listKBSources,
} from './ingest.js';

export type { IngestResult } from './ingest.js';

// Re-export search functions
export { search, formatSearchResults, findSimilar } from './search.js';
export type { SearchOptions } from './search.js';

// Re-export embedding functions
export {
  generateEmbedding,
  generateEmbeddingsBatch,
  serializeFloat32,
  deserializeFloat32,
  getEmbeddingDimensions,
  isAvailable as isEmbeddingAvailable,
  setAvailable as setEmbeddingAvailable,
  checkOllamaHealth,
} from './embeddings.js';

// Re-export chunking functions
export { chunkText, countTokens, estimateChunkCount } from './chunking.js';

// Re-export dedupe functions
export {
  normalizeUrl,
  generateContentHash,
  areUrlsEquivalent,
  cleanContent,
} from './dedupe.js';

// Re-export quality functions
export {
  validateContent,
  detectErrorPage,
  truncateContent,
  MAX_CONTENT_LENGTH,
} from './quality.js';

// Re-export locks
export { KBLock };

// Re-export extractors
export { extractArticle, extractTweet } from './extractors/index.js';
export type { ExtractedContent } from './extractors/article.js';

// State
let ollamaAvailable = false;

/**
 * Initialize the Knowledge Base module
 * - Checks Ollama availability
 * - Initializes database tables
 * - Cleans up stale locks
 */
export async function initKB(database: Database.Database): Promise<void> {
  // Check Ollama health
  ollamaAvailable = await checkOllamaHealth();
  if (ollamaAvailable) {
    logger.info('Ollama is available for embeddings');
  } else {
    logger.warn('Ollama not available - KB search will be disabled');
  }

  // Initialize database tables
  initKBTables(database);

  // Clean up stale locks
  cleanupStaleLocks();

  logger.info('Knowledge Base initialized');
}

/**
 * Check if KB is fully operational
 */
export function isKBOperational(): boolean {
  return ollamaAvailable;
}

/**
 * Cleanup stale locks (exported for manual cleanup)
 */
export function cleanupStaleLocks(): void {
  KBLock.cleanupStale();
}
