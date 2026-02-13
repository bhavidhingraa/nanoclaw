/**
 * Twitter/X post extraction using FxTwitter API
 */

import type { ExtractedContent } from './article.js';
import { logger } from '../../logger.js';
import { decode } from 'entities';

const FXTWITTER_API = 'https://api.fxtwitter.com/status';

/**
 * Extract tweet content from a Twitter/X URL
 */
export async function extractTweet(url: string): Promise<ExtractedContent | null> {
  const tweetId = extractTweetId(url);
  if (!tweetId) {
    logger.warn({ url }, 'Could not extract tweet ID from URL');
    return null;
  }

  // Try FxTwitter API
  try {
    const res = await fetch(`${FXTWITTER_API}/${tweetId}`, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (res.ok) {
      const data = (await res.json()) as FxTwitterResponse;
      if (data.tweet) {
        const tweet = data.tweet;
        let content = tweet.text;

        // Include quoted tweet if present
        if (tweet.quote) {
          content += `\n\nQuoting: ${tweet.quote.text}`;
        }

        // Build title
        const author = tweet.author;
        const title = `@${author.screen_name}: ${content.slice(0, 60)}...`;

        // Build full content with metadata
        const fullContent = `Tweet by @${author.screen_name} (${author.name}):\n\n${content}\n\nLikes: ${tweet.likes} • Retweets: ${tweet.retweets}`;

        return {
          title,
          content: fullContent,
          url: tweet.url || url,
        };
      }
    }
  } catch (err) {
    logger.debug({ url, err }, 'FxTwitter API failed');
  }

  // Fallback: Try fixupx.com
  try {
    const fixupUrl = url.replace(
      /(?:twitter|x)\.com/,
      'fixupx.com',
    );
    const res = await fetch(fixupUrl, {
      signal: AbortSignal.timeout(15000),
    });

    if (res.ok) {
      const html = await res.text();
      // Try to extract tweet text from HTML
      const textMatch = html.match(/<meta\s+name="twitter:description"\s+content="([^"]+)"/);
      if (textMatch) {
        const content = decode(textMatch[1]); // Properly decode HTML entities
        const titleMatch = html.match(/<meta\s+name="twitter:title"\s+content="([^"]+)"/);
        const title = titleMatch ? decode(titleMatch[1]) : 'Tweet';

        return {
          title,
          content,
          url,
        };
      }
    }
  } catch (err) {
    logger.debug({ url, err }, 'fixupx fallback failed');
  }

  logger.warn({ url }, 'Tweet extraction failed');
  return null;
}

/**
 * Extract tweet ID from URL
 */
function extractTweetId(url: string): string | null {
  // Match patterns:
  // https://twitter.com/user/status/123456
  // https://x.com/user/status/123456
  // https://twitter.com/i/status/123456
  const patterns = [
    /(?:twitter|x)\.com\/[\w]+\/status\/(\d+)/i,
    /(?:twitter|x)\.com\/i\/status\/(\d+)/i,
    /(?:twitter|x)\.com\/[\w]+\/statuses\/(\d+)/i,
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) {
      return match[1];
    }
  }

  return null;
}

interface FxTwitterResponse {
  tweet?: {
    author: {
      name: string;
      screen_name: string;
    };
    text: string;
    url: string;
    likes: number;
    retweets: number;
    quote?: {
      text: string;
    };
  };
}
