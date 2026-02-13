/**
 * Content ingestion pipeline
 */

import type { SourceType } from './types.js';
import type { IngestOptions, IngestResult } from './types.js';
import type { ExtractedContent } from './extractors/article.js';

// Re-export types for convenience
export type { IngestResult } from './types.js';
import { extractContent } from './extractors/index.js';
import { normalizeUrl, generateContentHash, cleanContent } from './dedupe.js';
import { validateContent, MAX_CONTENT_LENGTH } from './quality.js';
import { chunkText } from './chunking.js';
import { generateEmbeddingsBatch, serializeFloat32, setAvailable } from './embeddings.js';
import {
  createSource,
  createChunk,
  getSourceByUrl,
  getSourceByHash,
  updateSource,
  deleteChunksBySourceId,
  listSources,
  type KBSource,
} from './storage.js';
import { KBLock } from './locks.js';
import { logger } from '../logger.js';

/**
 * Ingest content from a URL
 */
export async function ingestUrl(
  url: string,
  options: IngestOptions,
): Promise<IngestResult> {
  return await ingestUrlInternal(url, options, false);
}

/**
 * Update existing content from a URL
 */
export async function updateUrl(
  url: string,
  options: IngestOptions,
): Promise<IngestResult> {
  return await ingestUrlInternal(url, options, true);
}

/**
 * Internal implementation for ingest/update
 */
async function ingestUrlInternal(
  url: string,
  options: IngestOptions,
  forceUpdate: boolean,
): Promise<IngestResult> {
  const { groupFolder, tags, sourceType: explicitType } = options;

  // Acquire lock
  const release = await KBLock.acquire('ingest', groupFolder);

  try {
    // Normalize URL
    const normalizedUrl = normalizeUrl(url);

    // Check for duplicate by URL
    const existingByUrl = getSourceByUrl(normalizedUrl);
    if (existingByUrl) {
      if (forceUpdate) {
        // Delete existing chunks (will cascade)
        deleteChunksBySourceId(existingByUrl.id);
      } else {
        return { success: false, error: 'URL already ingested', existingSourceId: existingByUrl.id };
      }
    }

    // Detect source type
    const sourceType = explicitType || detectSourceType(url);

    // Extract content
    const extracted = await extractContent(url, sourceType);
    if (!extracted) {
      return { success: false, error: 'Content extraction failed' };
    }

    return await finishIngestion({
      url: normalizedUrl,
      title: extracted.title,
      content: extracted.content,
      sourceType,
      groupFolder,
      tags,
      existingSource: existingByUrl ?? undefined,
    });
  } catch (err) {
    logger.error({ url, err }, 'URL ingestion failed');
    return { success: false, error: String(err) };
  } finally {
    release();
  }
}

/**
 * Ingest direct content (text/notes)
 */
export async function ingestContent(
  content: string,
  options: IngestOptions,
): Promise<IngestResult> {
  return await ingestContentInternal(content, options, false);
}

/**
 * Update existing direct content
 */
export async function updateContent(
  content: string,
  options: IngestOptions,
): Promise<IngestResult> {
  return await ingestContentInternal(content, options, true);
}

/**
 * Internal implementation for content ingest/update
 */
async function ingestContentInternal(
  content: string,
  options: IngestOptions,
  forceUpdate: boolean,
): Promise<IngestResult> {
  const { groupFolder, title, tags, sourceType = 'text', url } = options;

  // Acquire lock
  const release = await KBLock.acquire('ingest', groupFolder);

  try {
    // If URL provided, check for existing
    let existingSource: KBSource | undefined;
    if (url) {
      const normalizedUrl = normalizeUrl(url);
      existingSource = getSourceByUrl(normalizedUrl);
      if (existingSource) {
        if (forceUpdate) {
          deleteChunksBySourceId(existingSource.id);
        } else {
          return { success: false, error: 'URL already ingested', existingSourceId: existingSource.id };
        }
      }
    }

    return await finishIngestion({
      url: url ? normalizeUrl(url) : undefined,
      title,
      content,
      sourceType,
      groupFolder,
      tags,
      existingSource,
    });
  } catch (err) {
    logger.error({ err }, 'Content ingestion failed');
    return { success: false, error: String(err) };
  } finally {
    release();
  }
}

/**
 * Finish ingestion (common logic for URL and content)
 */
async function finishIngestion(params: {
  url?: string;
  title?: string;
  content: string;
  sourceType: SourceType;
  groupFolder: string;
  tags?: string[];
  existingSource?: KBSource;
}): Promise<IngestResult> {
  const { url, title, content, sourceType, groupFolder, tags, existingSource } = params;

  // Clean content
  const cleanedContent = cleanContent(content);

  // Validate content quality
  const validation = validateContent(cleanedContent, sourceType);
  if (!validation.valid) {
    return { success: false, error: validation.reason };
  }

  // Truncate if needed
  const finalContent = validation.truncated
    ? cleanedContent.slice(0, MAX_CONTENT_LENGTH)
    : cleanedContent;

  // Generate content hash and check for duplicates (unless updating existing)
  const contentHash = generateContentHash(finalContent);
  if (!existingSource) {
    const existingByHash = getSourceByHash(contentHash);
    if (existingByHash) {
      return { success: false, error: 'Duplicate content (same hash)', existingSourceId: existingByHash.id };
    }
  }

  let source: KBSource;

  if (existingSource) {
    // Update existing source
    updateSource(existingSource.id, {
      url,
      title,
      raw_content: finalContent,
      content_hash: contentHash,
      tags,
    });
    source = { ...existingSource, url, title, raw_content: finalContent, content_hash: contentHash, tags };
  } else {
    // Create new source
    source = createSource({
      group_folder: groupFolder,
      url,
      title: title || 'Untitled',
      source_type: sourceType,
      raw_content: finalContent,
      content_hash: contentHash,
      tags,
    });
  }

  // Chunk content
  const chunks = chunkText(finalContent);

  // Generate embeddings
  setAvailable(true); // Assume available unless we get errors
  const embeddings = await generateEmbeddingsBatch(chunks);

  // Store chunks
  let chunksStored = 0;
  for (let i = 0; i < chunks.length; i++) {
    const emb = embeddings[i];
    if (emb) {
      createChunk({
        source_id: source.id,
        chunk_index: i,
        content: chunks[i],
        embedding: serializeFloat32(emb),
        embedding_dim: emb.length,
        embedding_provider: 'ollama',
        embedding_model: 'nomic-embed-text',
      });
      chunksStored++;
    }
  }

  logger.info(
    {
      sourceId: source.id,
      url,
      title: source.title,
      updated: !!existingSource,
      chunks: chunksStored,
    },
    existingSource ? 'Content updated in KB' : 'Content ingested to KB',
  );

  return {
    success: true,
    source_id: source.id,
    chunks_count: chunksStored,
    updated: !!existingSource,
  };
}

/**
 * Delete a source from KB
 */
export async function deleteSource(sourceId: string): Promise<{ success: boolean; error?: string }> {
  try {
    const { deleteSource: deleteSourceFn } = await import('./storage.js');
    deleteSourceFn(sourceId);
    logger.info({ sourceId }, 'Source deleted from KB');
    return { success: true };
  } catch (err) {
    logger.error({ sourceId, err }, 'Failed to delete source');
    return { success: false, error: String(err) };
  }
}

/**
 * List all sources in KB
 */
export function listKBSources(groupFolder: string, limit = 50): KBSource[] {
  return listSources(groupFolder, limit);
}

/**
 * Detect source type from URL
 */
export function detectSourceType(url: string): SourceType {
  // Twitter/X
  if (
    /^(?:https?:\/\/)?(?:www\.)?(?:twitter|x)\.com\/[\w]+\/status\/[\d]+/i.test(
      url,
    )
  ) {
    return 'tweet';
  }

  // YouTube
  if (
    /^(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)[\w-]+/i.test(
      url,
    )
  ) {
    return 'video';
  }

  // PDF
  if (/\.pdf$/i.test(url)) {
    return 'pdf';
  }

  // Default to article
  return 'article';
}

/**
 * Extract content from URL (re-export)
 */
export { extractContent };
