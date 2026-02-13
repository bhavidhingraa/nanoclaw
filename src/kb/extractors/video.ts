/**
 * YouTube video transcript extraction using yt-dlp
 */

import { execSync } from 'child_process';
import { logger } from '../../logger.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

// yt-dlp path - use full path since service may not have homebrew in PATH
const YTDLP_PATH = '/opt/homebrew/bin/yt-dlp';

export interface ExtractedContent {
  title: string;
  content: string;
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
  const baseName = `yt-sub-${Date.now()}`;
  const subPath = path.join(tmpDir, `${baseName}.%(ext)s`);
  let transcriptFiles: string[] = [];

  try {
    // Check if yt-dlp is available
    try {
      execSync(`test -x "${YTDLP_PATH}"`, { stdio: 'ignore' });
    } catch {
      logger.warn({ ytDlpPath: YTDLP_PATH }, 'yt-dlp not found at expected path');
      return null;
    }

    // Get video title first
    const titleCmd = `${YTDLP_PATH} --no-warnings --skip-download --print '%(title)s' ${url}`;

    const title = execSync(titleCmd, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30000,
    }).trim();

    if (!title) {
      return null;
    }

    // Try to download subtitles (both manual and auto-generated)
    const subCmd = `${YTDLP_PATH} --no-warnings --skip-download --write-subs --write-auto-subs --sub-langs en,en-US --sub-format vtt --output '${subPath}' ${url}`;

    try {
      execSync(subCmd, {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60000,
      });

      // Find the created subtitle files
      const possibleFiles = [
        path.join(tmpDir, `${baseName}.en.vtt`),
        path.join(tmpDir, `${baseName}.en-US.vtt`),
        path.join(tmpDir, `${baseName}.zh-Hans.vtt`),
        path.join(tmpDir, `${baseName}.vtt`),
      ];

      for (const f of possibleFiles) {
        if (fs.existsSync(f)) {
          transcriptFiles.push(f);
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
          let vttContent = fs.readFileSync(subFile, 'utf-8');

          // Parse VTT format and extract text
          content = parseVTT(vttContent);

          // Clean up the subtitle file
          fs.unlinkSync(subFile);
        } catch (readErr) {
          logger.debug({ subFile, err: readErr }, 'Failed to read subtitle file');
        }
      }
    }

    // If no transcript or transcript is too short, fall back to description
    if (content.length < 200) {
      const descCmd = `${YTDLP_PATH} --no-warnings --skip-download --print '%(description)s' ${url}`;

      try {
        const description = execSync(descCmd, {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 30000,
        }).trim() || '';

        if (description.length > content.length) {
          content = description;
        }
      } catch {
        // Description might not exist
      }
    }

    // Clean up any remaining subtitle files
    for (const subFile of transcriptFiles) {
      try {
        if (fs.existsSync(subFile)) {
          fs.unlinkSync(subFile);
        }
      } catch {}
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

    // Clean up any remaining subtitle files on error
    for (const subFile of transcriptFiles) {
      try {
        if (fs.existsSync(subFile)) {
          fs.unlinkSync(subFile);
        }
      } catch {}
    }

    return null;
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
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\d+/g, '') // Remove standalone numbers (timestamps)
      .trim();

    if (cleanLine && cleanLine.length > 2) {
      textLines.push(cleanLine);
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
