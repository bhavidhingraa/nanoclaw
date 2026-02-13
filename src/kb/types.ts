/**
 * Knowledge Base Types
 */

export type SourceType = 'article' | 'video' | 'pdf' | 'text' | 'tweet' | 'other';

export interface KBSource {
  id: string;
  group_folder: string;
  url?: string;
  title?: string;
  source_type: SourceType;
  summary?: string;
  raw_content: string;
  content_hash: string;
  tags?: string[];
  created_at: string;
  updated_at: string;
}

export interface KBChunk {
  id: number;
  source_id: string;
  chunk_index: number;
  content: string;
  embedding?: Buffer;
  embedding_dim?: number;
  embedding_provider?: string;
  embedding_model?: string;
  created_at: string;
}

export interface IngestOptions {
  groupFolder: string;
  url?: string;
  content?: string;
  title?: string;
  sourceType?: SourceType;
  tags?: string[];
}

export interface IngestResult {
  success: boolean;
  source_id?: string;
  chunks_count?: number;
  error?: string;
  existingSourceId?: string;
  updated?: boolean;
}

export interface SearchResult {
  chunk_id: number;
  source_id: string;
  source_url?: string;
  source_title?: string;
  source_type: SourceType;
  content: string;
  similarity: number;
}

export interface ChunkOptions {
  chunkSize?: number;
  overlap?: number;
  minChunk?: number;
}

export interface ValidationResult {
  valid: boolean;
  reason?: string;
  truncated?: boolean;
}
