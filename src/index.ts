import { exec, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import makeWASocket, {
  DisconnectReason,
  WASocket,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  IPC_POLL_INTERVAL,
  MAIN_GROUP_FOLDER,
  POLL_INTERVAL,
  STORE_DIR,
  TIMEZONE,
  PROJECT_ROOT,
  SUGAR_PROJECTS_FILE,
  getSugarProjects,
  getSugarProject,
  getDefaultSugarProject,
} from './config.js';
import {
  AvailableGroup,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  getAllChats,
  getAllTasks,
  getLastGroupSync,
  getMessagesSince,
  getNewMessages,
  getTaskById,
  initDatabase,
  setLastGroupSync,
  storeChatMetadata,
  storeMessage,
  updateChatName,
  db,
} from './db.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { NewMessage, RegisteredGroup, Session } from './types.js';
import { loadJson, saveJson } from './utils.js';
import { logger } from './logger.js';
import { initKB, ingestUrl, search as kbSearch, formatSearchResults } from './kb/index.js';
import { KB_URL_PATTERNS } from './config.js';

// Sugar path constant
const SUGAR_PATH = '/Users/neetidhingra/Github/bhavidhingraa/sugar';

// Helper to build sugar command with proper PYTHONPATH
function sugarCmd(args: string): string {
  return `PYTHONPATH=${SUGAR_PATH}:$PYTHONPATH python -m sugar.main ${args}`;
}

const GROUP_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

let sock: WASocket;
let lastTimestamp = '';
let sessions: Session = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
// LID to phone number mapping (WhatsApp now sends LID JIDs for self-chats)
let lidToPhoneMap: Record<string, string> = {};
// Guards to prevent duplicate loops on WhatsApp reconnect
let messageLoopRunning = false;
let ipcWatcherRunning = false;
let groupSyncTimerStarted = false;
// Track running Sugar processes by project name
const runningSugarProcesses: Record<string, number> = {};

/**
 * Translate a JID from LID format to phone format if we have a mapping.
 * Returns the original JID if no mapping exists.
 */
function translateJid(jid: string): string {
  if (!jid.endsWith('@lid')) return jid;
  const lidUser = jid.split('@')[0].split(':')[0];
  const phoneJid = lidToPhoneMap[lidUser];
  if (phoneJid) {
    logger.debug({ lidJid: jid, phoneJid }, 'Translated LID to phone JID');
    return phoneJid;
  }
  return jid;
}

async function setTyping(jid: string, isTyping: boolean): Promise<void> {
  try {
    await sock.sendPresenceUpdate(isTyping ? 'composing' : 'paused', jid);
  } catch (err) {
    logger.debug({ jid, err }, 'Failed to update typing status');
  }
}

function loadState(): void {
  const statePath = path.join(DATA_DIR, 'router_state.json');
  const state = loadJson<{
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  }>(statePath, {});
  lastTimestamp = state.last_timestamp || '';
  lastAgentTimestamp = state.last_agent_timestamp || {};
  sessions = loadJson(path.join(DATA_DIR, 'sessions.json'), {});
  registeredGroups = loadJson(
    path.join(DATA_DIR, 'registered_groups.json'),
    {},
  );
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  saveJson(path.join(DATA_DIR, 'router_state.json'), {
    last_timestamp: lastTimestamp,
    last_agent_timestamp: lastAgentTimestamp,
  });
  saveJson(path.join(DATA_DIR, 'sessions.json'), sessions);
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  registeredGroups[jid] = group;
  saveJson(path.join(DATA_DIR, 'registered_groups.json'), registeredGroups);

  // Create group folder
  const groupDir = path.join(DATA_DIR, '..', 'groups', group.folder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Sync group metadata from WhatsApp.
 * Fetches all participating groups and stores their names in the database.
 * Called on startup, daily, and on-demand via IPC.
 */
async function syncGroupMetadata(force = false): Promise<void> {
  // Check if we need to sync (skip if synced recently, unless forced)
  if (!force) {
    const lastSync = getLastGroupSync();
    if (lastSync) {
      const lastSyncTime = new Date(lastSync).getTime();
      const now = Date.now();
      if (now - lastSyncTime < GROUP_SYNC_INTERVAL_MS) {
        logger.debug({ lastSync }, 'Skipping group sync - synced recently');
        return;
      }
    }
  }

  try {
    logger.info('Syncing group metadata from WhatsApp...');
    const groups = await sock.groupFetchAllParticipating();

    let count = 0;
    for (const [jid, metadata] of Object.entries(groups)) {
      if (metadata.subject) {
        updateChatName(jid, metadata.subject);
        count++;
      }
    }

    setLastGroupSync();
    logger.info({ count }, 'Group metadata synced');
  } catch (err) {
    logger.error({ err }, 'Failed to sync group metadata');
  }
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
function getAvailableGroups(): AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.jid.endsWith('@g.us'))
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/**
 * Build a regex pattern for a group's trigger word
 * @param trigger - The trigger string (e.g., "@Alfred", "@bhai")
 * @returns RegExp that matches the trigger at the start of a message (case-insensitive)
 */
function buildTriggerPattern(trigger: string): RegExp {
  // Extract the name from trigger (remove @ if present)
  const name = trigger.startsWith('@') ? trigger.slice(1) : trigger;
  // Escape special regex characters
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^@${escaped}\\b`, 'i');
}

/**
 * Extract the assistant name from a trigger string
 * @param trigger - The trigger string (e.g., "@Alfred", "@bhai")
 * @returns The name without @ prefix
 */
function getAssistantNameFromTrigger(trigger: string): string {
  return trigger.startsWith('@') ? trigger.slice(1) : trigger;
}

/**
 * Detect URLs in a message using regex patterns
 */
function detectUrls(content: string): string[] {
  const urls: string[] = [];

  // Create a new global regex each time to avoid lastIndex issues
  const urlPattern = new RegExp(KB_URL_PATTERNS.url.source, 'gi');
  const matches = content.matchAll(urlPattern);

  for (const match of matches) {
    if (match[0]) {
      urls.push(match[0]);
    }
  }

  return urls;
}

/**
 * Check if a message contains a question that might benefit from KB search
 */
function isSearchQuery(content: string): boolean {
  const questionPatterns = [
    /^(?:what|how|why|when|where|who|which|can|could|would|should|is|are|do|does)/i,
    /\?$/,
  ];
  return questionPatterns.some((p) => p.test(content.trim()));
}

async function processMessage(msg: NewMessage): Promise<void> {
  const group = registeredGroups[msg.chat_jid];
  if (!group) return;

  const content = msg.content.trim();
  const isMainGroup = group.folder === MAIN_GROUP_FOLDER;

  // Main group responds to all messages; other groups require their specific trigger prefix
  if (!isMainGroup) {
    const triggerPattern = buildTriggerPattern(group.trigger);
    if (!triggerPattern.test(content)) return;
  }

  // Detect and auto-ingest URLs in background
  const urls = detectUrls(content);
  for (const url of urls) {
    // Non-blocking ingestion
    ingestUrl(url, { groupFolder: group.folder })
      .then((result) => {
        if (result.success) {
          logger.info({ url, sourceId: result.source_id }, 'URL ingested to KB');
        } else if (result.error && !result.error.includes('already ingested')) {
          logger.debug({ url, error: result.error }, 'URL ingestion skipped');
        }
      })
      .catch((err) => logger.debug({ url, err }, 'URL ingestion failed'));
  }

  // Get all messages since last agent interaction so the session has full context
  const sinceTimestamp = lastAgentTimestamp[msg.chat_jid] || '';
  // Use the group's assistant name for filtering out assistant messages
  const groupAssistantName = getAssistantNameFromTrigger(group.trigger);
  const missedMessages = getMessagesSince(
    msg.chat_jid,
    sinceTimestamp,
    groupAssistantName,
  );

  const lines = missedMessages.map((m) => {
    // Escape XML special characters in content
    const escapeXml = (s: string) =>
      s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    return `<message sender="${escapeXml(m.sender_name)}" time="${m.timestamp}">${escapeXml(m.content)}</message>`;
  });
  const prompt = `<messages>\n${lines.join('\n')}\n</messages>`;

  if (!prompt) return;

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing message',
  );

  await setTyping(msg.chat_jid, true);
  const response = await runAgent(group, prompt, msg.chat_jid, missedMessages[missedMessages.length - 1]?.content);
  await setTyping(msg.chat_jid, false);

  if (response) {
    lastAgentTimestamp[msg.chat_jid] = msg.timestamp;
    const responsePrefix = isMainGroup ? ASSISTANT_NAME : groupAssistantName;
    await sendMessage(msg.chat_jid, `${responsePrefix}: ${response}`);
  }
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  lastMessageContent?: string,
): Promise<string | null> {
  const isMain = group.folder === MAIN_GROUP_FOLDER;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Search KB for relevant context to add to prompt
  let kbContext = '';
  try {
    if (lastMessageContent && isSearchQuery(lastMessageContent)) {
      const results = await kbSearch(lastMessageContent, {
        groupFolder: group.folder,
        limit: 3,
      });
      if (results.length > 0) {
        kbContext = formatSearchResults(results, 2000);
      }
    }
  } catch (err) {
    logger.debug({ err }, 'KB search failed, continuing without context');
  }

  // Prepend KB context to prompt if found
  const enhancedPrompt = kbContext
    ? `<knowledge_base>\n${kbContext}\n</knowledge_base>\n\n${prompt}`
    : prompt;

  try {
    const output = await runContainerAgent(group, {
      prompt: enhancedPrompt,
      sessionId,
      groupFolder: group.folder,
      chatJid,
      isMain,
    });

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      saveJson(path.join(DATA_DIR, 'sessions.json'), sessions);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return `Error: ${output.error}`;
    }

    return output.result;
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    const errMsg = err instanceof Error ? err.message : String(err);
    return `Error: ${errMsg}`;
  }
}

async function sendMessage(jid: string, text: string): Promise<void> {
  try {
    await sock.sendMessage(jid, { text });
    logger.info({ jid, length: text.length }, 'Message sent');
  } catch (err) {
    logger.error({ jid, err }, 'Failed to send message');
  }
}

function startIpcWatcher(): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    for (const sourceGroup of groupFolders) {
      const isMain = sourceGroup === MAIN_GROUP_FOLDER;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (data.type === 'message' && data.chatJid && data.text) {
                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  await sendMessage(
                    data.chatJid,
                    `${ASSISTANT_NAME}: ${data.text}`,
                  );
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    groupFolder?: string;
    chatJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    containerConfig?: RegisteredGroup['containerConfig'];
    // For Sugar integration
    task?: string;
    taskType?: string;
    priority?: number;
    project?: string;
    projectName?: string;
    status?: string;
    limit?: number;
    dryRun?: boolean;
    continuous?: boolean;
    projectPath?: string;
    // For GitHub integration
    repo?: string;
    state?: string;
    issueNumber?: number;
    branch?: string;
    title?: string;
    body?: string;
    default?: boolean;
    // For KB integration
    url?: string;
    query?: string;
    content?: string;
    tags?: string[];
    sourceId?: string;
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
): Promise<void> {
  // Import db functions dynamically to avoid circular deps
  const {
    createTask,
    updateTask,
    deleteTask,
    getTaskById: getTask,
  } = await import('./db.js');
  const { CronExpressionParser } = await import('cron-parser');

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.groupFolder
      ) {
        // Authorization: non-main groups can only schedule for themselves
        const targetGroup = data.groupFolder;
        if (!isMain && targetGroup !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetGroup },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        // Resolve the correct JID for the target group (don't trust IPC payload)
        const targetJid = Object.entries(registeredGroups).find(
          ([, group]) => group.folder === targetGroup,
        )?.[0];

        if (!targetJid) {
          logger.warn(
            { targetGroup },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const scheduled = new Date(data.schedule_value);
          if (isNaN(scheduled.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = scheduled.toISOString();
        }

        const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetGroup,
          chat_jid: targetJid,
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetGroup, contextMode },
          'Task created via IPC',
        );
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTask(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTask(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTask(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await syncGroupMetadata(true);
        // Write updated snapshot immediately
        const availableGroups = getAvailableGroups();
        const { writeGroupsSnapshot: writeGroups } =
          await import('./container-runner.js');
        writeGroups(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    // ===== Sugar Integration Handlers =====

    case 'sugar_add': {
      if (!data.task) {
        logger.warn({ data }, 'Invalid sugar_add request - missing task');
        break;
      }

      // Get the target project (use provided name or default)
      const projectName = data.project || (data.projectName as string);
      const project = projectName ? getSugarProject(projectName) : getDefaultSugarProject();

      if (!project) {
        const errorMsg = `Sugar project not found. Configure projects in ${SUGAR_PROJECTS_FILE}`;
        logger.warn({ projectName }, errorMsg);
        if (data.chatJid) {
          await sendMessage(data.chatJid, `${ASSISTANT_NAME}: ${errorMsg}`);
        }
        break;
      }

      const sugarProjectDir = path.join(project.path, '.sugar');
      if (!fs.existsSync(sugarProjectDir)) {
        const errorMsg = `Sugar not initialized in ${project.name}. Run: cd ${project.path} && sugar init`;
        logger.warn({ sugarProjectDir }, errorMsg);
        if (data.chatJid) {
          await sendMessage(data.chatJid, `${ASSISTANT_NAME}: ${errorMsg}`);
        }
        break;
      }

      try {
        // Escape task string for shell: replace newlines and special chars
        const safeTask = data.task
          .replace(/"/g, '\\"')
          .replace(/\n/g, '\\n')
          .replace(/\$/g, '\\$')
          .replace(/`/g, '\\`');

        // Map task types to valid Sugar types
        const validTypes = ['bug_fix', 'feature', 'test', 'refactor', 'documentation'];
        const typeMapping: Record<string, string> = {
          'chore': 'feature',
          'bug': 'bug_fix',
          'fix': 'bug_fix',
          'enhancement': 'feature',
          'docs': 'documentation',
          'doc': 'documentation',
        };
        const safeType = data.taskType ? (typeMapping[data.taskType] || data.taskType) : null;

        let cmd = `cd "${project.path}" && ${sugarCmd(`add "${safeTask}"`)}`;
        if (safeType && validTypes.includes(safeType)) cmd += ` --type ${safeType}`;
        if (data.priority) cmd += ` --priority ${data.priority}`;

        const result = execSyncCmd(cmd, { timeout: 30000 });
        logger.info({ task: data.task, project: project.name, stdout: result.stdout, stderr: result.stderr }, 'Sugar task added via IPC');

        if (data.chatJid) {
          const response = result.stdout.trim() || `Task added to ${project.name}: "${data.task.substring(0, 50)}..."`;
          await sendMessage(data.chatJid, `${ASSISTANT_NAME}: ${response}`);
        }
      } catch (err) {
        logger.error({ err, task: data.task, project: project.name }, 'Sugar add failed');
        if (data.chatJid) {
          await sendMessage(
            data.chatJid,
            `${ASSISTANT_NAME}: Failed to add task - ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      break;
    }

    case 'sugar_list': {
      // Get the target project (use provided name or default)
      const projectName = data.project || (data.projectName as string);
      const project = projectName ? getSugarProject(projectName) : getDefaultSugarProject();

      if (!project) {
        const errorMsg = `Sugar project not found. Configure projects in ${SUGAR_PROJECTS_FILE}`;
        logger.warn({ projectName }, errorMsg);
        if (data.chatJid) {
          await sendMessage(data.chatJid, `${ASSISTANT_NAME}: ${errorMsg}`);
        }
        break;
      }

      const sugarProjectDir = path.join(project.path, '.sugar');
      if (!fs.existsSync(sugarProjectDir)) {
        const errorMsg = `Sugar not initialized in ${project.name}. Run: cd ${project.path} && sugar init`;
        logger.warn({ sugarProjectDir }, errorMsg);
        if (data.chatJid) {
          await sendMessage(data.chatJid, `${ASSISTANT_NAME}: ${errorMsg}`);
        }
        break;
      }

      try {
        let cmd = `cd "${project.path}" && ${sugarCmd(`list --status ${data.status || 'pending'} --json`)}`;
        if (data.limit) cmd += ` --limit ${data.limit}`;

        const { stdout } = execSyncCmd(cmd, { timeout: 30000 });
        const tasks = JSON.parse(stdout);

        if (data.chatJid) {
          if (tasks.length === 0) {
            await sendMessage(data.chatJid, `${ASSISTANT_NAME}: No ${data.status || 'pending'} tasks found in ${project.name}.`);
          } else {
            const formatted = tasks.map((t: any) =>
              `- [${t.id}] ${t.title} (priority: ${t.priority}, type: ${t.type})`
            ).join('\n');
            await sendMessage(data.chatJid, `${ASSISTANT_NAME}: ${project.name} tasks (${tasks.length}):\n${formatted}`);
          }
        }
      } catch (err) {
        logger.error({ err, project: project.name }, 'Sugar list failed');
        if (data.chatJid) {
          await sendMessage(
            data.chatJid,
            `${ASSISTANT_NAME}: Failed to list tasks - ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      break;
    }

    case 'sugar_status': {
      // Get the target project (use provided name or default)
      const projectName = data.project || (data.projectName as string);
      const project = projectName ? getSugarProject(projectName) : getDefaultSugarProject();

      if (!project) {
        const errorMsg = `Sugar project not found. Configure projects in ${SUGAR_PROJECTS_FILE}`;
        logger.warn({ projectName }, errorMsg);
        if (data.chatJid) {
          await sendMessage(data.chatJid, `${ASSISTANT_NAME}: ${errorMsg}`);
        }
        break;
      }

      const sugarProjectDir = path.join(project.path, '.sugar');
      if (!fs.existsSync(sugarProjectDir)) {
        const errorMsg = `Sugar not initialized in ${project.name}. Run: cd ${project.path} && sugar init`;
        logger.warn({ sugarProjectDir }, errorMsg);
        if (data.chatJid) {
          await sendMessage(data.chatJid, `${ASSISTANT_NAME}: ${errorMsg}`);
        }
        break;
      }

      try {
        const { stdout } = execSyncCmd(`cd "${project.path}" && ${sugarCmd('status')}`, { timeout: 30000 });

        if (data.chatJid) {
          await sendMessage(data.chatJid, `${ASSISTANT_NAME} (${project.name}):\n${stdout}`);
        }
      } catch (err) {
        logger.error({ err, project: project.name }, 'Sugar status failed');
        if (data.chatJid) {
          await sendMessage(
            data.chatJid,
            `${ASSISTANT_NAME}: Failed to get status - ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      break;
    }

    case 'sugar_run': {
      // Get the target project (use provided name or default)
      const projectName = data.project || (data.projectName as string);
      const project = projectName ? getSugarProject(projectName) : getDefaultSugarProject();

      if (!project) {
        const errorMsg = `Sugar project not found. Configure projects in ${SUGAR_PROJECTS_FILE}`;
        logger.warn({ projectName }, errorMsg);
        if (data.chatJid) {
          await sendMessage(data.chatJid, `${ASSISTANT_NAME}: ${errorMsg}`);
        }
        break;
      }

      const sugarProjectDir = path.join(project.path, '.sugar');
      if (!fs.existsSync(sugarProjectDir)) {
        const errorMsg = `Sugar not initialized in ${project.name}. Run: cd ${project.path} && sugar init`;
        logger.warn({ sugarProjectDir }, errorMsg);
        if (data.chatJid) {
          await sendMessage(data.chatJid, `${ASSISTANT_NAME}: ${errorMsg}`);
        }
        break;
      }

      // Check if already running in continuous mode
      if (runningSugarProcesses[project.name]) {
        if (data.chatJid) {
          await sendMessage(data.chatJid, `${ASSISTANT_NAME}: Sugar is already running for ${project.name}. Use sugar_stop() first.`);
        }
        break;
      }

      const dryRun = data.dryRun ? '--dry-run ' : '';
      const continuous = data.continuous ? '' : '--once ';
      const sugarPath = '/Users/neetidhingra/Github/bhavidhingraa/sugar';
      const cmd = `cd "${project.path}" && PYTHONPATH=${sugarPath}:$PYTHONPATH python -m sugar.main run ${dryRun}${continuous}`;

      const homeDir = process.env.HOME || '/Users/neetidhingra';
      const envPath = `/opt/homebrew/bin:/opt/homebrew/sbin:${homeDir}/.pyenv/shims:${homeDir}/.pyenv/bin:${process.env.PATH}`;

      logger.info({ dryRun: data.dryRun, continuous: !!data.continuous, project: project.name }, 'Starting Sugar run via IPC');

      const sugarProcess = exec(cmd, { env: { ...process.env, PATH: envPath } }, (error: any, stdout: string, stderr: string) => {
        // Clear PID tracking when process exits
        delete runningSugarProcesses[project.name];

        if (error) {
          logger.error({ error, stderr, project: project.name }, 'Sugar run failed');
        } else {
          logger.info({ stdout, project: project.name }, 'Sugar run completed');
        }
      });

      // Track PID for continuous mode so we can stop it later
      if (data.continuous) {
        runningSugarProcesses[project.name] = sugarProcess.pid || 0;
        logger.info({ pid: sugarProcess.pid, project: project.name }, 'Sugar continuous mode started');
      }

      if (data.chatJid) {
        const mode = data.continuous ? 'continuous mode' : 'once';
        await sendMessage(data.chatJid, `${ASSISTANT_NAME}: Sugar started for ${project.name} (${mode})${data.dryRun ? ' (dry-run)' : ''}.${data.continuous ? ' Use sugar_stop() to stop it.' : ''}`);
      }
      break;
    }

    case 'sugar_stop': {
      const projectName = data.project;
      const project = projectName ? getSugarProject(projectName) : getDefaultSugarProject();

      if (!project) {
        const errorMsg = `Sugar project not found. Configure projects in ${SUGAR_PROJECTS_FILE}`;
        logger.warn({ projectName }, errorMsg);
        if (data.chatJid) {
          await sendMessage(data.chatJid, `${ASSISTANT_NAME}: ${errorMsg}`);
        }
        break;
      }

      const pid = runningSugarProcesses[project.name];
      if (!pid) {
        if (data.chatJid) {
          await sendMessage(data.chatJid, `${ASSISTANT_NAME}: No running Sugar process found for ${project.name}.`);
        }
        break;
      }

      try {
        process.kill(pid, 'SIGTERM');
        delete runningSugarProcesses[project.name];
        logger.info({ pid, project: project.name }, 'Sugar process stopped via IPC');

        if (data.chatJid) {
          await sendMessage(data.chatJid, `${ASSISTANT_NAME}: Sugar stopped for ${project.name}.`);
        }
      } catch (err) {
        logger.error({ err, pid, project: project.name }, 'Failed to stop Sugar process');
        // Process might have already died, clear tracking
        delete runningSugarProcesses[project.name];

        if (data.chatJid) {
          await sendMessage(data.chatJid, `${ASSISTANT_NAME}: Sugar process for ${project.name} was not running (may have already exited).`);
        }
      }
      break;
    }

    case 'sugar_list_projects': {
      const projects = getSugarProjects();
      const projectList = Object.entries(projects).map(([key, p]) =>
        `- ${p.name}${p.default ? ' (default)' : ''}: ${p.path}${p.repo ? ` [${p.repo}]` : ''}`
      ).join('\n');

      if (data.chatJid) {
        if (Object.keys(projects).length === 0) {
          await sendMessage(data.chatJid, `${ASSISTANT_NAME}: No Sugar projects configured. Add projects to ${SUGAR_PROJECTS_FILE}`);
        } else {
          await sendMessage(data.chatJid, `${ASSISTANT_NAME}: Configured projects:\n${projectList}`);
        }
      }
      break;
    }

    case 'sugar_add_project': {
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized sugar_add_project attempt blocked');
        break;
      }

      if (!data.name || !data.projectPath) {
        logger.warn({ data }, 'Invalid sugar_add_project request - missing name or path');
        break;
      }

      const projects = getSugarProjects();
      projects[data.name] = {
        name: data.name,
        path: data.projectPath,
        repo: data.repo,
        default: data.default || Object.keys(projects).length === 0,
      };

      saveJson(SUGAR_PROJECTS_FILE, projects);
      logger.info({ name: data.name, path: data.projectPath }, 'Sugar project added via IPC');

      if (data.chatJid) {
        await sendMessage(data.chatJid, `${ASSISTANT_NAME}: Added project "${data.name}" at ${data.projectPath}`);
      }
      break;
    }

    case 'sugar_init': {
      const projectName = data.project;
      const project = projectName ? getSugarProject(projectName) : getDefaultSugarProject();

      if (!project) {
        const errorMsg = `Sugar project not found. Configure projects in ${SUGAR_PROJECTS_FILE}`;
        logger.warn({ projectName }, errorMsg);
        if (data.chatJid) {
          await sendMessage(data.chatJid, `${ASSISTANT_NAME}: ${errorMsg}`);
        }
        break;
      }

      const sugarProjectDir = path.join(project.path, '.sugar');
      if (fs.existsSync(sugarProjectDir)) {
        if (data.chatJid) {
          await sendMessage(data.chatJid, `${ASSISTANT_NAME}: Sugar already initialized in ${project.name}`);
        }
        break;
      }

      try {
        const { stdout } = execSyncCmd(`cd "${project.path}" && ${sugarCmd('init')}`, { timeout: 30000 });
        logger.info({ project: project.name }, 'Sugar initialized via IPC');

        if (data.chatJid) {
          await sendMessage(data.chatJid, `${ASSISTANT_NAME}: Sugar initialized in ${project.name}!`);
        }
      } catch (err) {
        logger.error({ err, project: project.name }, 'Sugar init failed');
        if (data.chatJid) {
          await sendMessage(
            data.chatJid,
            `${ASSISTANT_NAME}: Failed to initialize Sugar - ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      break;
    }

    // ===== GitHub Integration Handlers =====

    case 'github_list_issues': {
      const repo = data.repo;
      if (!repo) {
        logger.warn({ data }, 'Invalid github_list_issues request - missing repo');
        break;
      }

      try {
        let cmd = `gh issue list --repo ${repo} --json number,title,state,labels`;
        if (data.state) cmd += ` --state ${data.state}`;
        if (data.limit) cmd += ` -L ${data.limit}`;

        const { stdout } = execSyncCmd(cmd, { timeout: 30000 });
        const issues = JSON.parse(stdout);

        if (data.chatJid) {
          if (issues.length === 0) {
            await sendMessage(data.chatJid, `${ASSISTANT_NAME}: No issues found in ${repo}.`);
          } else {
            const formatted = issues.map((i: any) =>
              `- #${i.number}: ${i.title} [${i.state}]${i.labels?.length ? ` (${i.labels.map((l: any) => l.name).join(', ')})` : ''}`
            ).join('\n');
            await sendMessage(data.chatJid, `${ASSISTANT_NAME}: Issues in ${repo}:\n${formatted}`);
          }
        }
      } catch (err) {
        logger.error({ err, repo }, 'GitHub list issues failed');
        if (data.chatJid) {
          await sendMessage(
            data.chatJid,
            `${ASSISTANT_NAME}: Failed to list issues - ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      break;
    }

    case 'github_create_task_from_issue': {
      const { repo, issueNumber } = data;
      if (!repo || !issueNumber) {
        logger.warn({ data }, 'Invalid github_create_task_from_issue request - missing repo or issueNumber');
        break;
      }

      try {
        // Get issue details
        const issueCmd = `gh issue view ${issueNumber} --repo ${repo} --json title,body,labels,number`;
        const { stdout } = execSyncCmd(issueCmd, { timeout: 30000 });
        const issue = JSON.parse(stdout);

        // Create sugar task from issue (escape title for shell)
        const taskTitle = `GitHub #${issue.number}: ${issue.title.replace(/"/g, '\\"').replace(/\n/g, '\\n')}`;
        const taskType = issue.labels?.some((l: any) => l.name === 'bug') ? 'bug_fix' : 'feature';
        const priorityFlag = issue.labels?.some((l: any) => l.name === 'urgent') ? ' --priority 1' : '';

        const result = execSyncCmd(sugarCmd(`add "${taskTitle}" --type ${taskType}${priorityFlag}`), { timeout: 30000 });

        logger.info({ repo, issueNumber, stdout: result.stdout, stderr: result.stderr }, 'Created Sugar task from GitHub issue');

        if (data.chatJid) {
          await sendMessage(
            data.chatJid,
            `${ASSISTANT_NAME}: Created task from issue #${issueNumber}: "${issue.title}"`,
          );
        }
      } catch (err) {
        logger.error({ err, repo, issueNumber }, 'Failed to create task from GitHub issue');
        if (data.chatJid) {
          await sendMessage(
            data.chatJid,
            `${ASSISTANT_NAME}: Failed to create task - ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      break;
    }

    case 'github_create_pr': {
      const { repo, branch, title, body } = data;
      if (!repo || !branch) {
        logger.warn({ data }, 'Invalid github_create_pr request - missing repo or branch');
        break;
      }

      try {
        let cmd = `gh pr create --repo ${repo} --base main --head ${branch}`;
        if (title) cmd += ` --title "${title.replace(/"/g, '\\"')}"`;
        if (body) cmd += ` --body "${body.replace(/"/g, '\\"')}"`;
        else cmd += ` --fill`; // Auto-fill from commits

        const { stdout } = execSyncCmd(cmd, { timeout: 30000 });

        logger.info({ repo, branch }, 'Created PR via IPC');

        if (data.chatJid) {
          await sendMessage(data.chatJid, `${ASSISTANT_NAME}: PR created:\n${stdout}`);
        }
      } catch (err) {
        logger.error({ err, repo, branch }, 'Failed to create PR');
        if (data.chatJid) {
          await sendMessage(
            data.chatJid,
            `${ASSISTANT_NAME}: Failed to create PR - ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      break;
    }

    case 'github_pr_status': {
      const repo = data.repo;
      if (!repo) {
        logger.warn({ data }, 'Invalid github_pr_status request - missing repo');
        break;
      }

      try {
        const cmd = `gh pr list --repo ${repo} --json number,title,state,headRefName,url --limit 10`;
        const { stdout } = execSyncCmd(cmd, { timeout: 30000 });
        const prs = JSON.parse(stdout);

        if (data.chatJid) {
          if (prs.length === 0) {
            await sendMessage(data.chatJid, `${ASSISTANT_NAME}: No PRs found in ${repo}.`);
          } else {
            const formatted = prs.map((p: any) =>
              `- #${p.number}: ${p.title} [${p.state}] from ${p.headRefName}\n  ${p.url}`
            ).join('\n');
            await sendMessage(data.chatJid, `${ASSISTANT_NAME}: PRs in ${repo}:\n${formatted}`);
          }
        }
      } catch (err) {
        logger.error({ err, repo }, 'GitHub PR status failed');
        if (data.chatJid) {
          await sendMessage(
            data.chatJid,
            `${ASSISTANT_NAME}: Failed to get PR status - ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      break;
    }

    // ===== Knowledge Base Management Handlers =====

    case 'kb_list': {
      // Only main group can list all KB sources; others see only their own
      const targetGroup = data.groupFolder ? data.groupFolder as string : sourceGroup;
      if (!isMain && targetGroup !== sourceGroup) {
        logger.warn({ sourceGroup, targetGroup }, 'Unauthorized kb_list attempt blocked');
        break;
      }

      try {
        const { listKBSources } = await import('./kb/index.js');
        const sources = listKBSources(targetGroup, 100);

        if (data.chatJid) {
          if (sources.length === 0) {
            await sendMessage(data.chatJid, `${ASSISTANT_NAME}: Knowledge base is empty.`);
          } else {
            const formatted = sources
              .map(
                (s) =>
                  `- [${s.id.slice(0, 8)}] ${s.title || 'Untitled'} (${s.source_type})${s.url ? ` - ${s.url}` : ''}`,
              )
              .join('\n');
            await sendMessage(data.chatJid, `${ASSISTANT_NAME}: KB entries (${sources.length}):\n${formatted}`);
          }
        }
      } catch (err) {
        logger.error({ err }, 'KB list failed');
        if (data.chatJid) {
          await sendMessage(
            data.chatJid,
            `${ASSISTANT_NAME}: Failed to list KB - ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      break;
    }

    case 'kb_search': {
      const query = data.query as string;
      if (!query) {
        logger.warn({ data }, 'Invalid kb_search request - missing query');
        break;
      }

      // Search in the specified group or source group
      const targetGroup = data.groupFolder ? (data.groupFolder as string) : sourceGroup;
      if (!isMain && targetGroup !== sourceGroup) {
        logger.warn({ sourceGroup, targetGroup }, 'Unauthorized kb_search attempt blocked');
        break;
      }

      try {
        const { search, formatSearchResults } = await import('./kb/index.js');
        const results = await search(query, {
          groupFolder: targetGroup,
          limit: data.limit || 5,
        });

        if (data.chatJid) {
          if (results.length === 0) {
            await sendMessage(data.chatJid, `${ASSISTANT_NAME}: No results found for "${query.slice(0, 50)}"`);
          } else {
            const formatted = formatSearchResults(results, 2000);
            await sendMessage(data.chatJid, `${ASSISTANT_NAME}: Found ${results.length} result(s):\n${formatted}`);
          }
        }
      } catch (err) {
        logger.error({ err, query }, 'KB search failed');
        if (data.chatJid) {
          await sendMessage(
            data.chatJid,
            `${ASSISTANT_NAME}: Search failed - ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      break;
    }

    case 'kb_update': {
      // Update existing KB content (by URL or source ID)
      const targetGroup = data.groupFolder ? (data.groupFolder as string) : sourceGroup;
      if (!isMain && targetGroup !== sourceGroup) {
        logger.warn({ sourceGroup, targetGroup }, 'Unauthorized kb_update attempt blocked');
        break;
      }

      // Validate: at least one identifier (url, source_id, or content) must be provided
      if (!data.url && !data.sourceId && !data.content) {
        logger.warn({ data }, 'Invalid kb_update request - missing url, source_id, or content');
        if (data.chatJid) {
          await sendMessage(data.chatJid, `${ASSISTANT_NAME}: To update a KB entry, provide either a URL, source_id, or content.`);
        }
        break;
      }

      try {
        const { updateUrl, updateContent, getSourceById } = await import('./kb/index.js');

        let result;
        if (data.url) {
          result = await updateUrl(data.url as string, {
            groupFolder: targetGroup,
            title: data.title as string,
            tags: data.tags as string[],
          });
        } else if (data.content) {
          result = await updateContent(data.content as string, {
            groupFolder: targetGroup,
            url: data.url as string,
            title: data.title as string,
            tags: data.tags as string[],
          });
        } else if (data.sourceId) {
          // Update by source ID - get source first, then update metadata
          const source = getSourceById(data.sourceId as string, targetGroup);
          if (!source) {
            throw new Error(`Source not found: ${data.sourceId}`);
          }
          if (source.url) {
            result = await updateUrl(source.url, {
              groupFolder: targetGroup,
              title: data.title as string,
              tags: data.tags as string[],
            });
          } else {
            // No URL (text note) - only title/tags update possible via DB
            if (data.title || data.tags) {
              result = { success: true, source_id: source.id, updated: false };
            } else {
              result = { success: false, error: 'Text-only sources need title or tags to update' };
            }
        } else {
          logger.warn({ data }, 'Invalid kb_update request - missing url, source_id, or content');
          break;
        }

        if (data.chatJid) {
          if (result.success) {
            await sendMessage(
              data.chatJid,
              `${ASSISTANT_NAME}: KB entry updated${result.updated ? ' (re-indexed)' : ''}: ${result.source_id?.slice(0, 8)}`,
            );
          } else {
            await sendMessage(data.chatJid, `${ASSISTANT_NAME}: Update failed - ${result.error}`);
          }
        }
      } catch (err) {
        logger.error({ err }, 'KB update failed');
        if (data.chatJid) {
          await sendMessage(
            data.chatJid,
            `${ASSISTANT_NAME}: Update failed - ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      break;
    }

    case 'kb_add': {
      // Add new plain text content to KB
      const content = data.content as string;
      if (!content) {
        logger.warn({ data }, 'Invalid kb_add request - missing content');
        break;
      }

      try {
        const { ingestContent } = await import('./kb/index.js');
        const result = await ingestContent(content, {
          groupFolder: sourceGroup,
          title: data.title as string,
          tags: data.tags as string[],
          sourceType: 'text',
        });

        if (data.chatJid) {
          if (result.success) {
            await sendMessage(
              data.chatJid,
              `${ASSISTANT_NAME}: Added to KB: ${result.source_id?.slice(0, 8)} (${result.chunks_count} chunks)`,
            );
          } else {
            await sendMessage(data.chatJid, `${ASSISTANT_NAME}: Failed - ${result.error}`);
          }
        }
      } catch (err) {
        logger.error({ err }, 'KB add failed');
        if (data.chatJid) {
          await sendMessage(
            data.chatJid,
            `${ASSISTANT_NAME}: Add failed - ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      break;
    }

    case 'kb_delete': {
      // Delete KB entry by source ID
      const targetGroup = data.groupFolder ? (data.groupFolder as string) : sourceGroup;
      if (!isMain && targetGroup !== sourceGroup) {
        logger.warn({ sourceGroup, targetGroup }, 'Unauthorized kb_delete attempt blocked');
        break;
      }

      const sourceId = data.sourceId as string;
      if (!sourceId) {
        logger.warn({ data }, 'Invalid kb_delete request - missing sourceId');
        break;
      }

      try {
        const { deleteKBSource } = await import('./kb/index.js');
        const result = await deleteKBSource(sourceId);

        if (data.chatJid) {
          if (result.success) {
            await sendMessage(data.chatJid, `${ASSISTANT_NAME}: KB entry deleted: ${sourceId}`);
          } else {
            await sendMessage(data.chatJid, `${ASSISTANT_NAME}: Delete failed - ${result.error}`);
          }
        }
      } catch (err) {
        logger.error({ err, sourceId }, 'KB delete failed');
        if (data.chatJid) {
          await sendMessage(
            data.chatJid,
            `${ASSISTANT_NAME}: Delete failed - ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      break;
    }

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}

/**
 * Execute a command synchronously and return stdout.
 * Wrapper around execSync for cleaner error handling.
 */
function execSyncCmd(command: string, options: { timeout?: number } = {}): { stdout: string; stderr: string } {
  try {
    const homeDir = process.env.HOME || '/Users/neetidhingra';
    const envPath = `/opt/homebrew/bin:/opt/homebrew/sbin:${homeDir}/.pyenv/shims:${homeDir}/.pyenv/bin:${process.env.PATH}`;
    const sugarPath = '/Users/neetidhingra/Github/bhavidhingraa/sugar';
    const pythonPath = `${sugarPath}:${process.env.PYTHONPATH || ''}`;

    // Capture both stdout and stderr by redirecting stderr to a temp file
    const tmpFile = `/tmp/sugar-cmd-${Date.now()}.log`;
    const cmdWithStderr = `${command} 2>${tmpFile}`;

    const stdout = execSync(cmdWithStderr, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: options.timeout || 30000,
      env: { ...process.env, PATH: envPath, PYTHONPATH: pythonPath },
    });

    let stderr = '';
    try {
      stderr = fs.readFileSync(tmpFile, 'utf-8');
      fs.unlinkSync(tmpFile);
    } catch {
      // File might not exist if no stderr output
    }

    return { stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err: any) {
    return { stdout: '', stderr: err.stderr?.toString() || err.message || String(err) };
  }
}

async function connectWhatsApp(): Promise<void> {
  const authDir = path.join(STORE_DIR, 'auth');
  fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    printQRInTerminal: false,
    logger,
    browser: ['NanoClaw', 'Chrome', '1.0.0'],
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      const msg =
        'WhatsApp authentication required. Run /setup in Claude Code.';
      logger.error(msg);
      exec(
        `osascript -e 'display notification "${msg}" with title "NanoClaw" sound name "Basso"'`,
      );
      setTimeout(() => process.exit(1), 1000);
    }

    if (connection === 'close') {
      const reason = (lastDisconnect?.error as any)?.output?.statusCode;
      const shouldReconnect = reason !== DisconnectReason.loggedOut;
      logger.info({ reason, shouldReconnect }, 'Connection closed');

      if (shouldReconnect) {
        logger.info('Reconnecting...');
        connectWhatsApp();
      } else {
        logger.info('Logged out. Run /setup to re-authenticate.');
        process.exit(0);
      }
    } else if (connection === 'open') {
      logger.info('Connected to WhatsApp');
      
      // Build LID to phone mapping from auth state for self-chat translation
      if (sock.user) {
        const phoneUser = sock.user.id.split(':')[0];
        const lidUser = sock.user.lid?.split(':')[0];
        if (lidUser && phoneUser) {
          lidToPhoneMap[lidUser] = `${phoneUser}@s.whatsapp.net`;
          logger.debug({ lidUser, phoneUser }, 'LID to phone mapping set');
        }
      }
      
      // Sync group metadata on startup (respects 24h cache)
      syncGroupMetadata().catch((err) =>
        logger.error({ err }, 'Initial group sync failed'),
      );
      // Set up daily sync timer (only once)
      if (!groupSyncTimerStarted) {
        groupSyncTimerStarted = true;
        setInterval(() => {
          syncGroupMetadata().catch((err) =>
            logger.error({ err }, 'Periodic group sync failed'),
          );
        }, GROUP_SYNC_INTERVAL_MS);
      }
      startSchedulerLoop({
        sendMessage,
        registeredGroups: () => registeredGroups,
        getSessions: () => sessions,
      });
      startIpcWatcher();
      startMessageLoop();
    }
  });

  // Debug: log all events to diagnose missing messages.upsert
  const originalEmit = sock.ev.emit;
  sock.ev.emit = function(event, data) {
    if (event !== 'messages.upsert' && event !== 'connection.update' && event !== 'creds.update') {
      logger.debug({ event }, 'Baileys event fired');
    }
    return originalEmit.call(this, event, data);
  };

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    logger.info({ count: messages.length, type, firstMsgJid: messages[0]?.key?.remoteJid }, 'messages.upsert FIRED!');
    for (const msg of messages) {
      if (!msg.message) continue;
      const rawJid = msg.key.remoteJid;
      if (!rawJid || rawJid === 'status@broadcast') continue;

      // Translate LID JID to phone JID if applicable
      const chatJid = translateJid(rawJid);
      
      const timestamp = new Date(
        Number(msg.messageTimestamp) * 1000,
      ).toISOString();

      // Always store chat metadata for group discovery
      storeChatMetadata(chatJid, timestamp);

      // Only store full message content for registered groups
      if (registeredGroups[chatJid]) {
        storeMessage(
          msg,
          chatJid,
          msg.key.fromMe || false,
          msg.pushName || undefined,
        );
      }
    }
  });
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;
  const groupList = Object.entries(registeredGroups)
    .map(([jid, g]) => `${g.name} (@${g.trigger.startsWith('@') ? g.trigger.slice(1) : g.trigger})`)
    .join(', ');
  logger.info(`NanoClaw running (${Object.keys(registeredGroups).length} groups: ${groupList})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      // Collect all bot prefixes to filter out bot responses from any group
      const botPrefixes = Object.values(registeredGroups).map(g =>
        g.trigger.startsWith('@') ? g.trigger.slice(1) : g.trigger
      );
      const { messages } = getNewMessages(jids, lastTimestamp, botPrefixes);

      if (messages.length > 0)
        logger.info({ count: messages.length }, 'New messages');
      for (const msg of messages) {
        try {
          await processMessage(msg);
          // Only advance timestamp after successful processing for at-least-once delivery
          lastTimestamp = msg.timestamp;
          saveState();
        } catch (err) {
          logger.error(
            { err, msg: msg.id },
            'Error processing message, will retry',
          );
          // Stop processing this batch - failed message will be retried next loop
          break;
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

function ensureContainerSystemRunning(): void {
  try {
    execSync('container system status', { stdio: 'pipe' });
    logger.debug('Apple Container system already running');
  } catch {
    logger.info('Starting Apple Container system...');
    try {
      execSync('container system start', { stdio: 'pipe', timeout: 30000 });
      logger.info('Apple Container system started');
    } catch (err) {
      logger.error({ err }, 'Failed to start Apple Container system');
      console.error(
        '\n╔════════════════════════════════════════════════════════════════╗',
      );
      console.error(
        '║  FATAL: Apple Container system failed to start                 ║',
      );
      console.error(
        '║                                                                ║',
      );
      console.error(
        '║  Agents cannot run without Apple Container. To fix:           ║',
      );
      console.error(
        '║  1. Install from: https://github.com/apple/container/releases ║',
      );
      console.error(
        '║  2. Run: container system start                               ║',
      );
      console.error(
        '║  3. Restart NanoClaw                                          ║',
      );
      console.error(
        '╚════════════════════════════════════════════════════════════════╝\n',
      );
      throw new Error('Apple Container system is required but failed to start');
    }
  }

  // Clean up stopped NanoClaw containers from previous runs
  try {
    const output = execSync('container ls -a --format {{.Names}}', {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    const stale = output
      .split('\n')
      .map((n) => n.trim())
      .filter((n) => n.startsWith('nanoclaw-'));
    if (stale.length > 0) {
      execSync(`container rm ${stale.join(' ')}`, { stdio: 'pipe' });
      logger.info({ count: stale.length }, 'Cleaned up stopped containers');
    }
  } catch {
    // No stopped containers or ls/rm not supported
  }
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  await initKB(db);
  logger.info('Database initialized');
  loadState();
  await connectWhatsApp();
}

main().catch((err) => {
  logger.error({ err }, 'Failed to start NanoClaw');
  process.exit(1);
});
