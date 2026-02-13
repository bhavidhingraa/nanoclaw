/**
 * Content quality validation
 */

import type { SourceType, ValidationResult } from './types.js';

/**
 * Error page detection patterns
 */
const ERROR_PATTERNS = [
  'access denied',
  'captcha',
  'please enable javascript',
  'cloudflare',
  '404',
  'not found',
  'sign in',
  'blocked',
  'rate limit',
  'subscribe to continue',
  'login required',
  'authorization required',
  'page not found',
];

/**
 * Minimum content lengths by source type
 */
const MIN_LENGTHS: Record<SourceType, number> = {
  article: 500,
  video: 100,
  pdf: 100,
  text: 20,
  tweet: 20,
  other: 100,
};

/**
 * Maximum content length (truncate beyond this)
 */
export const MAX_CONTENT_LENGTH = 200_000;

/**
 * Validate content quality before storing in KB
 */
export function validateContent(
  content: string,
  type: SourceType,
): ValidationResult {
  // Min length check
  const minLength = MIN_LENGTHS[type] || 100;
  if (content.length < minLength) {
    return {
      valid: false,
      reason: `Content too short for ${type} (< ${minLength} chars)`,
    };
  }

  // Error page detection (need 2+ signals)
  const lower = content.toLowerCase();
  const errorSignals = ERROR_PATTERNS.filter((p) => lower.includes(p));
  if (errorSignals.length >= 2) {
    return {
      valid: false,
      reason: `Detected error page: ${errorSignals.slice(0, 2).join(', ')}`,
    };
  }

  // For non-tweets, check content quality (prose vs navigation)
  if (type !== 'tweet' && type !== 'text') {
    const lines = content.split('\n').filter((l) => l.trim().length > 0);
    if (lines.length > 10) {
      const longLines = lines.filter((l) => l.length > 80);
      const ratio = longLines.length / lines.length;

      // If most lines are short, likely navigation/menu content
      if (ratio < 0.15) {
        return {
          valid: false,
          reason: 'Low quality content (mostly short lines, likely navigation)',
        };
      }
    }
  }

  // Check for truncation
  const truncated = content.length > MAX_CONTENT_LENGTH;

  return { valid: true, truncated };
}

/**
 * Detect if content looks like an error page
 */
export function detectErrorPage(content: string): boolean {
  const lower = content.toLowerCase();
  const errorSignals = ERROR_PATTERNS.filter((p) => lower.includes(p));
  return errorSignals.length >= 2;
}

/**
 * Truncate content to max length if needed
 */
export function truncateContent(content: string): string {
  if (content.length <= MAX_CONTENT_LENGTH) {
    return content;
  }
  return content.slice(0, MAX_CONTENT_LENGTH);
}
