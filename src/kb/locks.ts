/**
 * File-based concurrency protection for KB operations
 */

import fs from 'fs';
import path from 'path';
import { KB_LOCK_DIR } from '../config.js';

const STALE_AGE_MS = 15 * 60 * 1000; // 15 minutes

export class KBLock {
  static readonly STALE_AGE_MS = STALE_AGE_MS;

  /**
   * Acquire a lock for a specific operation and group
   * Returns a release function that must be called when done
   */
  static acquire(operation: string, groupFolder: string): () => void {
    const lockDir = KB_LOCK_DIR;
    fs.mkdirSync(lockDir, { recursive: true });

    const lockFile = path.join(lockDir, `${groupFolder}-${operation}.lock`);
    const pid = process.pid;

    // Check for existing lock
    if (fs.existsSync(lockFile)) {
      const stat = fs.statSync(lockFile);
      const age = Date.now() - stat.mtimeMs;

      // Check if lock is stale
      if (age > STALE_AGE_MS) {
        fs.unlinkSync(lockFile);
      } else {
        // Try to check if the process is still alive
        try {
          const lockPid = parseInt(fs.readFileSync(lockFile, 'utf-8'), 10);
          process.kill(lockPid, 0); // Signal 0 checks if process exists
          throw new Error(`Lock file exists and process ${lockPid} is still running`);
        } catch {
          // Process is dead, remove stale lock
          fs.unlinkSync(lockFile);
        }
      }
    }

    // Write lock file
    fs.writeFileSync(lockFile, pid.toString());

    // Return release function
    return () => {
      if (fs.existsSync(lockFile)) {
        fs.unlinkSync(lockFile);
      }
    };
  }

  /**
   * Clean up stale lock files
   */
  static cleanupStale(): void {
    const lockDir = KB_LOCK_DIR;
    if (!fs.existsSync(lockDir)) return;

    const files = fs.readdirSync(lockDir);
    for (const file of files) {
      const filePath = path.join(lockDir, file);
      try {
        const stat = fs.statSync(filePath);
        if (Date.now() - stat.mtimeMs > STALE_AGE_MS) {
          fs.unlinkSync(filePath);
        }
      } catch {
        // File might have been deleted, ignore
      }
    }
  }

  /**
   * Check if a specific lock file is stale
   */
  static isStale(lockPath: string): boolean {
    if (!fs.existsSync(lockPath)) return false;

    const stat = fs.statSync(lockPath);
    return Date.now() - stat.mtimeMs > STALE_AGE_MS;
  }
}
