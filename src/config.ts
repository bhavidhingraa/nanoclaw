import path from 'path';
import fs from 'fs';

export const ASSISTANT_NAME = process.env.ASSISTANT_NAME || 'Alfred';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
export const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || '/Users/user';

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
export const MAIN_GROUP_FOLDER = 'main';

// Sugar projects configuration
export const SUGAR_PROJECTS_FILE = path.join(DATA_DIR, 'sugar-projects.json');

export interface SugarProject {
  name: string;
  path: string;
  repo?: string; // GitHub repo in "owner/repo" format
  default?: boolean;
}

/**
 * Get all configured Sugar projects
 */
export function getSugarProjects(): Record<string, SugarProject> {
  try {
    if (fs.existsSync(SUGAR_PROJECTS_FILE)) {
      const data = fs.readFileSync(SUGAR_PROJECTS_FILE, 'utf-8');
      return JSON.parse(data);
    }
  } catch (err) {
    // Return empty object on error
  }
  return {};
}

/**
 * Get a specific Sugar project by name
 */
export function getSugarProject(name: string): SugarProject | undefined {
  const projects = getSugarProjects();
  return projects[name];
}

/**
 * Get the default Sugar project, or the first one if none marked as default
 */
export function getDefaultSugarProject(): SugarProject | undefined {
  const projects = getSugarProjects();
  const defaultProject = Object.values(projects).find(p => p.default);
  return defaultProject || Object.values(projects)[0];
}

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '300000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const CONTAINER_MEMORY = process.env.CONTAINER_MEMORY || '2G';
export const IPC_POLL_INTERVAL = 1000;

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

// ============================================================================
// Knowledge Base Configuration
// ============================================================================

export const KB_DIR = path.join(DATA_DIR, 'kb');
export const KB_LOCK_DIR = path.join(KB_DIR, 'locks');

// Chunking settings
export const KB_CHUNK_SIZE = 800;
export const KB_CHUNK_OVERLAP = 200;
export const KB_MIN_CHUNK = 100;

// Search settings
export const KB_SEARCH_LIMIT = 10;
export const KB_MIN_SIMILARITY = 0.7;

// URL detection patterns
export const KB_URL_PATTERNS = {
  tweet: /(?:https?:\/\/)?(?:www\.)?(?:twitter|x)\.com\/[\w]+\/status\/[\d]+/i,
  youtube: /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)[\w-]+/i,
  pdf: /\.pdf$/i,
  url: /https?:\/\/[^\s]+/i,
} as const;
