/**
 * URL normalization and content hashing for deduplication
 */

import crypto from 'crypto';

/**
 * Tracking parameters to strip from URLs
 */
const TRACKING_PARAMS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'fbclid',
  'igshid',
  'ref',
  's',
  't',
  '_ga',
  '_gl',
  'gclid',
  'msclkid',
];

/**
 * Normalize a URL by removing tracking parameters, www, and fragments
 */
export function normalizeUrl(url: string): string {
  try {
    let normalized = url.trim();

    // Add protocol if missing
    if (!/^https?:\/\//i.test(normalized)) {
      normalized = `https://${normalized}`;
    }

    const u = new URL(normalized);

    // Strip tracking parameters
    for (const param of TRACKING_PARAMS) {
      u.searchParams.delete(param);
    }

    normalized = u.href;

    // Remove www. prefix
    normalized = normalized.replace(/^(https?:\/\/)www\./i, '$1');

    // Normalize x.com to twitter.com
    normalized = normalized.replace(/:\/\/x\.com\//i, '://twitter.com/');

    // Remove trailing slash
    normalized = normalized.replace(/\/$/, '');

    // Remove fragment
    const hashIdx = normalized.indexOf('#');
    if (hashIdx !== -1) {
      normalized = normalized.slice(0, hashIdx);
    }

    return normalized;
  } catch {
    // If URL parsing fails, return as-is
    return url;
  }
}

/**
 * Generate SHA-256 hash of content for deduplication
 */
export function generateContentHash(content: string): string {
  return crypto
    .createHash('sha256')
    .update(content.trim())
    .digest('hex');
}

/**
 * Check if two URLs are equivalent after normalization
 */
export function areUrlsEquivalent(url1: string, url2: string): boolean {
  return normalizeUrl(url1) === normalizeUrl(url2);
}

/**
 * Clean content by removing excess whitespace
 */
export function cleanContent(content: string): string {
  return content
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
