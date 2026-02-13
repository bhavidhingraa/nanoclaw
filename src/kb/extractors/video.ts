/**
 * YouTube video transcript extraction using yt-dlp
 */

import { execFile } from 'child_process';
import { logger } from '../../logger.js';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { decode } from 'entities';
import crypto from 'crypto';

// yt-dlp path - configurable via env, falls back to PATH resolution
const YTDLP_PATH = process.env.YTDLP_PATH || 'yt-dlp';

export interface ExtractedContent {
  title: string;
  content: string;
}

/**
 * Execute a command with arguments as array (prevents shell injection)
 */
function execSafe(
  file: string,
  args: string[],
  options: { timeout?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        reject(error);
      } else {
        resolve({ stdout: stdout?.toString() || '', stderr: stderr?.toString() || '' });
      }
    });
  });
}

/**
 * Extract YouTube video transcript using yt-dlp
 * @param url - YouTube video URL
 * @returns Video title and transcript content, or null if extraction fails
 */
export async function extractVideoTranscript(
  url: string,
): Promise<ExtractedContent | null> {
  const tmpDir = os.tmpdir();
  const baseName = `yt-sub-${crypto.randomBytes(8).toString('hex')}`;
  const subPath = path.join(tmpDir, `${baseName}.%(ext)s`);
  let transcriptFiles: string[] = [];

  try {
    // Get video title first
    const titleResult = await execSafe(YTDLP_PATH, [
      '--no-warnings',
      '--skip-download',
      '--print',
      '%(title)s',
      url
    ], { timeout: 30000 });

    const title = titleResult.stdout.trim();

    if (!title) {
      return null;
    }

    // Try to download subtitles (both manual and auto-generated)
    try {
      await execSafe(YTDLP_PATH, [
        '--no-warnings',
        '--skip-download',
        '--write-subs',
        '--write-auto-subs',
        '--sub-langs', 'en,en-US',
        '--sub-format', 'vtt',
        '--output', subPath,
        url
      ], { timeout: 60000 });

      // Dynamically find all subtitle files created by yt-dlp
      const tmpFiles = await fs.readdir(tmpDir);
      for (const f of tmpFiles) {
        if (f.startsWith(baseName) && f.endsWith('.vtt')) {
          transcriptFiles.push(path.join(tmpDir, f));
        }
      }
    } catch (subErr) {
      logger.debug({ url, err: subErr }, 'Subtitles not available, will try description');
    }

    let content = '';

    // Process subtitle files if found
    if (transcriptFiles.length > 0) {
      for (const subFile of transcriptFiles) {
        try {
          const vttContent = await fs.readFile(subFile, 'utf-8');

          // Parse VTT format and extract text
          content = parseVTT(vttContent);
        } catch (readErr) {
          logger.debug({ subFile, err: readErr }, 'Failed to read subtitle file');
        }
      }
    }

    // If no transcript or transcript is too short, fall back to description
    if (content.length < 200) {
      try {
        const descResult = await execSafe(YTDLP_PATH, [
          '--no-warnings',
          '--skip-download',
          '--print',
          '%(description)s',
          url
        ], { timeout: 30000 });

        const description = descResult.stdout.trim() || '';

        if (description.length > content.length) {
          content = description;
        }
      } catch {
        // Description might not exist
      }
    }

    if (content.length > 50) {
      logger.info({ url, title, contentLength: content.length }, 'Video content extracted');
      return { title, content };
    }

    // Fallback: return title with URL
    logger.warn({ url, title }, 'No transcript or description available for video');
    return {
      title,
      content: `[Video: ${title}]\n\nNo transcript available. URL: ${url}`,
    };
  } catch (err) {
    logger.error({ url, err }, 'Video extraction failed');
    return null;
  } finally {
    // Centralized cleanup — always runs
    for (const subFile of transcriptFiles) {
      try {
        await fs.unlink(subFile);
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}

/**
 * Parse VTT subtitle file and extract plain text
 */
function parseVTT(vtt: string): string {
  const lines = vtt.split('\n');
  const textLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip VTT headers, timestamps, and empty lines
    if (
      !trimmed ||
      trimmed === 'WEBVTT' ||
      /^NOTE/.test(trimmed) ||
      /^\d{2}:/.test(trimmed) ||  // Timestamp like 00:00:00
      /^-->.+-->/.test(trimmed)    // Timestamp range like 00:00:00 --> 00:00:05
    ) {
      continue;
    }

    // Remove VTT formatting tags
    const cleanLine = trimmed
      .replace(/<[^>]+>/g, '') // Remove HTML tags
      .replace(/\{[^}]+\}/g, '') // Remove {} tags
      .trim();

    // Use proper HTML entity decoder (handles all entities, not just common ones)
    const decodedLine = decode(cleanLine);

    // Skip duplicate consecutive lines (common in auto-generated subtitles)
    if (decodedLine && decodedLine.length > 2 && decodedLine !== textLines[textLines.length - 1]) {
      textLines.push(decodedLine);
    }
  }

  return textLines.join(' ');
}

/**
 * Extract video ID from YouTube URL
 */
export function extractVideoId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/v\/([a-zA-Z0-9_-]{11})/,
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) {
      return match[1];
    }
  }

  return null;
}
