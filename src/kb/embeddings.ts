/**
 * Embedding generation using Ollama
 */

import { LRUCache } from 'lru-cache';
import { logger } from '../logger.js';

const OLLAMA_URL = 'http://localhost:11434/api/embeddings';
const MODEL = 'nomic-embed-text';
const DIMENSIONS = 768;
const MAX_INPUT_LENGTH = 8000;

// LRU cache for embeddings (1000 entries)
const cache = new LRUCache<string, Float32Array>({ max: 1000 });

// Track Ollama availability
let ollamaAvailable = true;

/**
 * Check if Ollama is running and accessible
 */
export async function checkOllamaHealth(): Promise<boolean> {
  try {
    const res = await fetch('http://localhost:11434/api/tags', {
      signal: AbortSignal.timeout(5000),
    });
    const ok = res.ok;
    ollamaAvailable = ok;
    return ok;
  } catch {
    ollamaAvailable = false;
    return false;
  }
}

/**
 * Generate embedding for a single text
 */
export async function generateEmbedding(text: string): Promise<Float32Array | null> {
  // Check cache first
  const cacheKey = text.slice(0, 500); // Cache by prefix for efficiency
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  if (!ollamaAvailable) {
    logger.warn('Ollama not available, skipping embedding generation');
    return null;
  }

  // Truncate to max input length
  const truncated = text.slice(0, MAX_INPUT_LENGTH);

  // Retry with exponential backoff
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(OLLAMA_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODEL, prompt: truncated }),
        signal: AbortSignal.timeout(30000),
      });

      if (!res.ok) {
        throw new Error(`Ollama error: ${res.status} ${res.statusText}`);
      }

      const data = (await res.json()) as { embedding?: number[] };
      if (!data.embedding || !Array.isArray(data.embedding)) {
        throw new Error('Invalid embedding response from Ollama');
      }

      const embedding = new Float32Array(data.embedding);
      cache.set(cacheKey, embedding);
      return embedding;
    } catch (err) {
      const isLastAttempt = attempt === 2;
      const isTransient = isTransientError(err);

      if (!isLastAttempt && isTransient) {
        const delay = [1000, 2000, 4000][attempt];
        logger.debug({ attempt, delay }, 'Retrying embedding generation');
        await sleep(delay);
        continue;
      }

      if (isLastAttempt) {
        logger.error({ err }, 'Embedding generation failed after retries');
        return null;
      }
    }
  }

  return null;
}

/**
 * Generate embeddings for multiple texts in batch
 * Processes in batches of 10 with delay between batches
 */
export async function generateEmbeddingsBatch(
  texts: string[],
  delay = 200,
): Promise<(Float32Array | null)[]> {
  const results: (Float32Array | null)[] = [];
  const batchSize = 10;

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);

    // Process batch in parallel
    const batchResults = await Promise.all(
      batch.map((text) => generateEmbedding(text)),
    );

    results.push(...batchResults);

    // Add delay between batches (except after last batch)
    if (i + batchSize < texts.length) {
      await sleep(delay);
    }
  }

  return results;
}

/**
 * Serialize Float32Array to Buffer for database storage
 */
export function serializeFloat32(arr: Float32Array): Buffer {
  return Buffer.from(arr.buffer);
}

/**
 * Deserialize Buffer to Float32Array
 */
export function deserializeFloat32(buffer: Buffer): Float32Array {
  return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
}

/**
 * Get embedding dimensions
 */
export function getEmbeddingDimensions(): number {
  return DIMENSIONS;
}

/**
 * Check if embeddings are available
 */
export function isAvailable(): boolean {
  return ollamaAvailable;
}

/**
 * Set availability status
 */
export function setAvailable(available: boolean): void {
  ollamaAvailable = available;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientError(err: unknown): boolean {
  if (err instanceof Error) {
    return (
      /ECONNRESET|ETIMEDOUT|ECONNREFUSED|fetch|network|timeout/i.test(
        err.message,
      ) || err.name === 'AbortError'
    );
  }
  return false;
}
