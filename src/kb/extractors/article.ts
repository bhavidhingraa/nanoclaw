/**
 * Web article extraction using Mozilla Readability with fallbacks
 */

import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import { logger } from '../../logger.js';

export interface ExtractedContent {
  title: string;
  content: string;
  url?: string;
}

/**
 * Extract article content from a URL
 * Implements fallback chain: Readability -> basic extraction
 */
export async function extractArticle(url: string): Promise<ExtractedContent | null> {
  let lastError: Error | null = null;

  // Validate URL format
  try {
    new URL(url);
  } catch {
    return null;
  }

  // Attempt 1: Direct fetch with Readability (with retry)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
        signal: AbortSignal.timeout(30000),
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }

      const html = await res.text();

      // Check if we got actual content (not error page)
      if (html.length < 500) {
        throw new Error('Response too short, likely not an article');
      }

      const dom = new JSDOM(html, { url });
      const article = new Readability(dom.window.document).parse();

      if (article?.content && article.textContent) {
        const content = article.textContent.trim();
        if (content.length > 100) {
          return {
            title: article.title || extractTitle(dom),
            content,
            url,
          };
        }
      }
    } catch (err) {
      lastError = err as Error;
      if (attempt === 0 && isTransientError(err)) {
        logger.debug({ attempt, url, err }, 'Retrying article extraction');
        await sleep(2000);
        continue;
      }
    }
  }

  // Attempt 2: Fallback to basic text extraction
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const html = await res.text();
    const dom = new JSDOM(html);
    const doc = dom.window.document;

    // Remove non-content elements
    doc
      .querySelectorAll(
        'script, style, nav, header, footer, aside, iframe, noscript, svg',
      )
      .forEach((el) => el.remove());

    // Try to get main content area
    const mainContent =
      doc.querySelector('main')?.textContent ||
      doc.querySelector('article')?.textContent ||
      doc.querySelector('[role="main"]')?.textContent ||
      doc.body?.textContent ||
      '';

    const content = mainContent.trim().replace(/\s+/g, ' ');

    if (content.length > 100) {
      return {
        title: extractTitle(dom),
        content,
        url,
      };
    }
  } catch (err) {
    lastError = err as Error;
  }

  logger.warn({ url, err: lastError }, 'Article extraction failed');
  return null;
}

/**
 * Extract title from JSDOM document
 */
function extractTitle(dom: JSDOM): string {
  return (
    dom.window.document.querySelector('title')?.textContent ||
    dom.window.document.querySelector('h1')?.textContent ||
    'Untitled'
  );
}

/**
 * Check if error is transient (network-related)
 */
function isTransientError(err: unknown): boolean {
  if (err instanceof Error) {
    return (
      /ECONNRESET|ETIMEDOUT|ECONNREFUSED|fetch|network/i.test(err.message) ||
      err.name === 'AbortError'
    );
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
