/**
 * Text chunking with overlap for embedding generation
 */

import type { ChunkOptions } from './types.js';

/**
 * Sentence boundary pattern for intelligent chunking
 */
const SENTENCE_BOUNDARY = /(?<=[.!?])\s+/;

/**
 * Default chunking options
 */
const DEFAULT_OPTIONS = {
  chunkSize: 800,
  overlap: 200,
  minChunk: 100,
};

/**
 * Split text into chunks with overlap, preferring sentence boundaries
 */
export function chunkText(text: string, options: ChunkOptions = {}): string[] {
  const { chunkSize = DEFAULT_OPTIONS.chunkSize, overlap = DEFAULT_OPTIONS.overlap, minChunk = DEFAULT_OPTIONS.minChunk } = options;

  const chunks: string[] = [];
  let position = 0;

  while (position < text.length) {
    let end = Math.min(position + chunkSize, text.length);

    // If not at end of text, try to find a good breaking point
    if (end < text.length) {
      // Look for sentence boundary within the overlap window
      const windowEnd = Math.min(end + overlap, text.length);
      const windowStart = Math.max(position, end - overlap);
      const window = text.slice(windowStart, windowEnd);
      const match = SENTENCE_BOUNDARY.exec(window);

      if (match) {
        // Break at sentence boundary
        end = windowStart + match.index + match[0].length;
      } else {
        // No sentence boundary found, try to break at word boundary
        const wordMatch = /\s\S*$/.exec(window);
        if (wordMatch) {
          end = windowStart + wordMatch.index + 1;
        }
      }
    }

    const chunk = text.slice(position, end).trim();

    // Only add chunk if it meets minimum size
    if (chunk.length >= minChunk) {
      chunks.push(chunk);
    }

    position = end;
  }

  // Handle tiny remainder - append to last chunk
  const lastEnd = position;
  if (lastEnd < text.length && text.length - lastEnd < minChunk) {
    const remainder = text.slice(lastEnd).trim();
    if (remainder.length > 0 && chunks.length > 0) {
      chunks[chunks.length - 1] += ' ' + remainder;
    }
  }

  return chunks;
}

/**
 * Count approximate tokens (rough estimate: ~4 chars per token)
 */
export function countTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Calculate how many chunks a text will produce
 */
export function estimateChunkCount(text: string, options: ChunkOptions = {}): number {
  const { chunkSize = DEFAULT_OPTIONS.chunkSize, overlap = DEFAULT_OPTIONS.overlap } = options;
  const effectiveSize = chunkSize - overlap;
  return Math.max(1, Math.ceil(text.length / effectiveSize));
}
