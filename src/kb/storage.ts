/**
 * SQLite storage operations for Knowledge Base
 */

import Database from 'better-sqlite3';
import type { KBSource, KBChunk } from './types.js';

// Re-export types for convenience
export type { KBSource, KBChunk } from './types.js';

let db: Database.Database | null = null;

/**
 * Initialize KB tables in the database
 */
export function initKBTables(database: Database.Database): void {
  db = database;

  // Create sources table
  db.exec(`
    CREATE TABLE IF NOT EXISTS kb_sources (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      url TEXT,
      title TEXT,
      source_type TEXT,
      summary TEXT,
      raw_content TEXT,
      content_hash TEXT UNIQUE,
      tags TEXT,
      created_at TEXT,
      updated_at TEXT
    );
  `);

  // Create indexes for sources
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_kb_sources_type ON kb_sources(source_type);
    CREATE INDEX IF NOT EXISTS idx_kb_sources_hash ON kb_sources(content_hash);
    CREATE INDEX IF NOT EXISTS idx_kb_sources_group ON kb_sources(group_folder);
    CREATE INDEX IF NOT EXISTS idx_kb_sources_url ON kb_sources(url);
  `);

  // Create chunks table
  db.exec(`
    CREATE TABLE IF NOT EXISTS kb_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      embedding BLOB,
      embedding_dim INTEGER,
      embedding_provider TEXT,
      embedding_model TEXT,
      created_at TEXT,
      FOREIGN KEY (source_id) REFERENCES kb_sources(id) ON DELETE CASCADE
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_kb_chunks_source ON kb_chunks(source_id);
  `);

  // Load sqlite-vss extension for vector search
  try {
    // Let better-sqlite3 resolve the module path
    db.loadExtension('sqlite-vss');

    // Create virtual table for vector search
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS kb_chunks_vss USING vss0(embedding(768));
    `);

    // Create triggers to sync embeddings
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS kb_chunks_sync AFTER INSERT ON kb_chunks BEGIN
        INSERT INTO kb_chunks_vss(rowid, embedding) VALUES (new.id, new.embedding);
      END;
    `);

    db.exec(`
      CREATE TRIGGER IF NOT EXISTS kb_chunks_delete AFTER DELETE ON kb_chunks BEGIN
        DELETE FROM kb_chunks_vss WHERE rowid = old.id;
      END;
    `);
  } catch (err) {
    // VSS extension not available - will use in-memory search
    console.warn('sqlite-vss extension not loaded:', err);
  }
}

/**
 * Create a new source
 */
export function createSource(
  source: Omit<KBSource, 'id' | 'created_at' | 'updated_at'>,
): KBSource {
  if (!db) throw new Error('Database not initialized');

  const id = `kb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO kb_sources (id, group_folder, url, title, source_type, summary, raw_content, content_hash, tags, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    id,
    source.group_folder,
    source.url ?? null,
    source.title ?? null,
    source.source_type,
    source.summary ?? null,
    source.raw_content,
    source.content_hash,
    source.tags ? JSON.stringify(source.tags) : null,
    now,
    now,
  );

  return { ...source, id, created_at: now, updated_at: now };
}

/**
 * Get source by ID
 */
export function getSourceById(id: string): KBSource | undefined {
  if (!db) throw new Error('Database not initialized');

  const row = db
    .prepare('SELECT * FROM kb_sources WHERE id = ?')
    .get(id) as KBSourceRow | undefined;

  return row ? rowToSource(row) : undefined;
}

/**
 * Get source by content hash
 */
export function getSourceByHash(contentHash: string): KBSource | undefined {
  if (!db) throw new Error('Database not initialized');

  const row = db
    .prepare('SELECT * FROM kb_sources WHERE content_hash = ?')
    .get(contentHash) as KBSourceRow | undefined;

  return row ? rowToSource(row) : undefined;
}

/**
 * Get source by URL
 */
export function getSourceByUrl(url: string): KBSource | undefined {
  if (!db) throw new Error('Database not initialized');

  const row = db
    .prepare('SELECT * FROM kb_sources WHERE url = ?')
    .get(url) as KBSourceRow | undefined;

  return row ? rowToSource(row) : undefined;
}

/**
 * List sources for a group
 */
export function listSources(
  groupFolder: string,
  limit = 100,
  offset = 0,
): KBSource[] {
  if (!db) throw new Error('Database not initialized');

  const rows = db
    .prepare(
      `
      SELECT * FROM kb_sources
      WHERE group_folder = ?
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `,
    )
    .all(groupFolder, limit, offset) as KBSourceRow[];

  return rows.map(rowToSource);
}

/**
 * Update source
 */
export function updateSource(
  id: string,
  updates: Partial<Omit<KBSource, 'id' | 'created_at'>>,
): void {
  if (!db) throw new Error('Database not initialized');

  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.url !== undefined) {
    fields.push('url = ?');
    values.push(updates.url);
  }
  if (updates.title !== undefined) {
    fields.push('title = ?');
    values.push(updates.title);
  }
  if (updates.summary !== undefined) {
    fields.push('summary = ?');
    values.push(updates.summary);
  }
  if (updates.raw_content !== undefined) {
    fields.push('raw_content = ?');
    values.push(updates.raw_content);
  }
  if (updates.content_hash !== undefined) {
    fields.push('content_hash = ?');
    values.push(updates.content_hash);
  }
  if (updates.tags !== undefined) {
    fields.push('tags = ?');
    values.push(updates.tags ? JSON.stringify(updates.tags) : null);
  }

  if (fields.length > 0) {
    fields.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(id);

    db.prepare(`UPDATE kb_sources SET ${fields.join(', ')} WHERE id = ?`).run(
      ...values,
    );
  }
}

/**
 * Delete source (cascades to chunks)
 */
export function deleteSource(id: string): void {
  if (!db) throw new Error('Database not initialized');

  db.prepare('DELETE FROM kb_sources WHERE id = ?').run(id);
}

/**
 * Create a chunk
 */
export function createChunk(
  chunk: Omit<KBChunk, 'id' | 'created_at'>,
): KBChunk {
  if (!db) throw new Error('Database not initialized');

  const now = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO kb_chunks (source_id, chunk_index, content, embedding, embedding_dim, embedding_provider, embedding_model, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    chunk.source_id,
    chunk.chunk_index,
    chunk.content,
    chunk.embedding ?? null,
    chunk.embedding_dim ?? null,
    chunk.embedding_provider ?? null,
    chunk.embedding_model ?? null,
    now,
  );

  return {
    ...chunk,
    id: result.lastInsertRowid as number,
    created_at: now,
  };
}

/**
 * Get chunks by source ID
 */
export function getChunksBySourceId(sourceId: string): KBChunk[] {
  if (!db) throw new Error('Database not initialized');

  const rows = db
    .prepare(
      'SELECT * FROM kb_chunks WHERE source_id = ? ORDER BY chunk_index',
    )
    .all(sourceId) as KBChunkRow[];

  return rows.map(rowToChunk);
}

/**
 * Delete chunks by source ID
 */
export function deleteChunksBySourceId(sourceId: string): void {
  if (!db) throw new Error('Database not initialized');

  db.prepare('DELETE FROM kb_chunks WHERE source_id = ?').run(sourceId);
}

/**
 * Get all chunks with embeddings for vector search
 */
export function getAllChunks(groupFolder?: string): KBChunk[] {
  if (!db) throw new Error('Database not initialized');

  const rows = db
    .prepare(
      groupFolder
        ? `
      SELECT c.* FROM kb_chunks c
      JOIN kb_sources s ON c.source_id = s.id
      WHERE s.group_folder = ? AND c.embedding IS NOT NULL
    `
        : `SELECT * FROM kb_chunks WHERE embedding IS NOT NULL`,
    )
    .all(groupFolder ?? null) as KBChunkRow[];

  return rows.map(rowToChunk);
}

/**
 * Get chunk by ID
 */
export function getChunkById(id: number): KBChunk | undefined {
  if (!db) throw new Error('Database not initialized');

  const row = db
    .prepare('SELECT * FROM kb_chunks WHERE id = ?')
    .get(id) as KBChunkRow | undefined;

  return row ? rowToChunk(row) : undefined;
}

/**
 * Get database instance
 */
export function getDatabase(): Database.Database {
  if (!db) throw new Error('Database not initialized');
  return db;
}

// Type conversions

interface KBSourceRow {
  id: string;
  group_folder: string;
  url: string | null;
  title: string | null;
  source_type: string;
  summary: string | null;
  raw_content: string;
  content_hash: string;
  tags: string | null;
  created_at: string;
  updated_at: string;
}

function rowToSource(row: KBSourceRow): KBSource {
  return {
    id: row.id,
    group_folder: row.group_folder,
    url: row.url ?? undefined,
    title: row.title ?? undefined,
    source_type: row.source_type as KBSource['source_type'],
    summary: row.summary ?? undefined,
    raw_content: row.raw_content,
    content_hash: row.content_hash,
    tags: row.tags ? JSON.parse(row.tags) : undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

interface KBChunkRow {
  id: number;
  source_id: string;
  chunk_index: number;
  content: string;
  embedding: Buffer | null;
  embedding_dim: number | null;
  embedding_provider: string | null;
  embedding_model: string | null;
  created_at: string;
}

function rowToChunk(row: KBChunkRow): KBChunk {
  return {
    id: row.id,
    source_id: row.source_id,
    chunk_index: row.chunk_index,
    content: row.content,
    embedding: row.embedding ?? undefined,
    embedding_dim: row.embedding_dim ?? undefined,
    embedding_provider: row.embedding_provider ?? undefined,
    embedding_model: row.embedding_model ?? undefined,
    created_at: row.created_at,
  };
}
