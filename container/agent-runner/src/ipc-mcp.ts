/**
 * IPC-based MCP Server for NanoClaw
 * Writes messages and tasks to files for the host process to pick up
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

export interface IpcMcpContext {
  chatJid: string;
  groupFolder: string;
  isMain: boolean;
}

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

export function createIpcMcp(ctx: IpcMcpContext) {
  const { chatJid, groupFolder, isMain } = ctx;

  return createSdkMcpServer({
    name: 'nanoclaw',
    version: '1.0.0',
    tools: [
      tool(
        'send_message',
        'Send a message to the current WhatsApp group. Use this to proactively share information or updates.',
        {
          text: z.string().describe('The message text to send')
        },
        async (args) => {
          const data = {
            type: 'message',
            chatJid,
            text: args.text,
            groupFolder,
            timestamp: new Date().toISOString()
          };

          const filename = writeIpcFile(MESSAGES_DIR, data);

          return {
            content: [{
              type: 'text',
              text: `Message queued for delivery (${filename})`
            }]
          };
        }
      ),

      tool(
        'schedule_task',
        `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools.

CONTEXT MODE - Choose based on task type:
• "group" (recommended for most tasks): Task runs in the group's conversation context, with access to chat history and memory. Use for tasks that need context about ongoing discussions, user preferences, or previous interactions.
• "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, ask the user. Examples:
- "Remind me about our discussion" → group (needs conversation context)
- "Check the weather every morning" → isolated (self-contained task)
- "Follow up on my request" → group (needs to know what was requested)
- "Generate a daily report" → isolated (just needs instructions in prompt)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
• cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
• interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
• once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
        {
          prompt: z.string().describe('What the agent should do when the task runs. For isolated mode, include all necessary context here.'),
          schedule_type: z.enum(['cron', 'interval', 'once']).describe('cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time'),
          schedule_value: z.string().describe('cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)'),
          context_mode: z.enum(['group', 'isolated']).default('group').describe('group=runs with chat history and memory, isolated=fresh session (include context in prompt)'),
          target_group: z.string().optional().describe('Target group folder (main only, defaults to current group)')
        },
        async (args) => {
          // Validate schedule_value before writing IPC
          if (args.schedule_type === 'cron') {
            try {
              CronExpressionParser.parse(args.schedule_value);
            } catch (err) {
              return {
                content: [{ type: 'text', text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).` }],
                isError: true
              };
            }
          } else if (args.schedule_type === 'interval') {
            const ms = parseInt(args.schedule_value, 10);
            if (isNaN(ms) || ms <= 0) {
              return {
                content: [{ type: 'text', text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).` }],
                isError: true
              };
            }
          } else if (args.schedule_type === 'once') {
            const date = new Date(args.schedule_value);
            if (isNaN(date.getTime())) {
              return {
                content: [{ type: 'text', text: `Invalid timestamp: "${args.schedule_value}". Use ISO 8601 format like "2026-02-01T15:30:00.000Z".` }],
                isError: true
              };
            }
          }

          // Non-main groups can only schedule for themselves
          const targetGroup = isMain && args.target_group ? args.target_group : groupFolder;

          const data = {
            type: 'schedule_task',
            prompt: args.prompt,
            schedule_type: args.schedule_type,
            schedule_value: args.schedule_value,
            context_mode: args.context_mode || 'group',
            groupFolder: targetGroup,
            chatJid,
            createdBy: groupFolder,
            timestamp: new Date().toISOString()
          };

          const filename = writeIpcFile(TASKS_DIR, data);

          return {
            content: [{
              type: 'text',
              text: `Task scheduled (${filename}): ${args.schedule_type} - ${args.schedule_value}`
            }]
          };
        }
      ),

      // Reads from current_tasks.json which host keeps updated
      tool(
        'list_tasks',
        'List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group\'s tasks.',
        {} as Record<string, never>,
        async () => {
          const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

          try {
            if (!fs.existsSync(tasksFile)) {
              return {
                content: [{
                  type: 'text',
                  text: 'No scheduled tasks found.'
                }]
              };
            }

            const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

            const tasks = isMain
              ? allTasks
              : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === groupFolder);

            if (tasks.length === 0) {
              return {
                content: [{
                  type: 'text',
                  text: 'No scheduled tasks found.'
                }]
              };
            }

            const formatted = tasks.map((t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
              `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`
            ).join('\n');

            return {
              content: [{
                type: 'text',
                text: `Scheduled tasks:\n${formatted}`
              }]
            };
          } catch (err) {
            return {
              content: [{
                type: 'text',
                text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}`
              }]
            };
          }
        }
      ),

      tool(
        'pause_task',
        'Pause a scheduled task. It will not run until resumed.',
        {
          task_id: z.string().describe('The task ID to pause')
        },
        async (args) => {
          const data = {
            type: 'pause_task',
            taskId: args.task_id,
            groupFolder,
            isMain,
            timestamp: new Date().toISOString()
          };

          writeIpcFile(TASKS_DIR, data);

          return {
            content: [{
              type: 'text',
              text: `Task ${args.task_id} pause requested.`
            }]
          };
        }
      ),

      tool(
        'resume_task',
        'Resume a paused task.',
        {
          task_id: z.string().describe('The task ID to resume')
        },
        async (args) => {
          const data = {
            type: 'resume_task',
            taskId: args.task_id,
            groupFolder,
            isMain,
            timestamp: new Date().toISOString()
          };

          writeIpcFile(TASKS_DIR, data);

          return {
            content: [{
              type: 'text',
              text: `Task ${args.task_id} resume requested.`
            }]
          };
        }
      ),

      tool(
        'cancel_task',
        'Cancel and delete a scheduled task.',
        {
          task_id: z.string().describe('The task ID to cancel')
        },
        async (args) => {
          const data = {
            type: 'cancel_task',
            taskId: args.task_id,
            groupFolder,
            isMain,
            timestamp: new Date().toISOString()
          };

          writeIpcFile(TASKS_DIR, data);

          return {
            content: [{
              type: 'text',
              text: `Task ${args.task_id} cancellation requested.`
            }]
          };
        }
      ),

      tool(
        'register_group',
        `Register a new WhatsApp group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name should be lowercase with hyphens (e.g., "family-chat").`,
        {
          jid: z.string().describe('The WhatsApp JID (e.g., "120363336345536173@g.us")'),
          name: z.string().describe('Display name for the group'),
          folder: z.string().describe('Folder name for group files (lowercase, hyphens, e.g., "family-chat")'),
          trigger: z.string().describe('Trigger word (e.g., "@Andy")')
        },
        async (args) => {
          if (!isMain) {
            return {
              content: [{ type: 'text', text: 'Only the main group can register new groups.' }],
              isError: true
            };
          }

          const data = {
            type: 'register_group',
            jid: args.jid,
            name: args.name,
            folder: args.folder,
            trigger: args.trigger,
            timestamp: new Date().toISOString()
          };

          writeIpcFile(TASKS_DIR, data);

          return {
            content: [{
              type: 'text',
              text: `Group "${args.name}" registered. It will start receiving messages immediately.`
            }]
          };
        }
      ),

      // ===== Sugar Integration Tools =====

      tool(
        'sugar_add',
        `Add a task to Sugar queue. Sugar is an autonomous AI development system that works through tasks continuously.

Basic usage: sugar_add("Fix the authentication bug")

Task types: bug_fix, feature, test, refactor, documentation, chore
Priority: 1 (urgent) to 5 (minimal), default is 3

Examples:
- sugar_add("Fix memory leak in cache", { type: "bug_fix", priority: 1 })
- sugar_add("Add user settings page", { type: "feature", priority: 2, project: "frontend" })`,
        {
          task: z.string().describe('The task description to add to Sugar'),
          type: z.enum(['bug_fix', 'feature', 'test', 'refactor', 'documentation', 'chore']).optional().describe('Task type'),
          priority: z.number().min(1).max(5).optional().describe('Priority (1=urgent, 5=minimal)'),
          urgent: z.boolean().optional().describe('Mark as urgent (priority 1)'),
          project: z.string().optional().describe('Project name (uses default if not specified)')
        },
        async (args) => {
          const data = {
            type: 'sugar_add',
            task: args.task,
            taskType: args.type,
            priority: args.urgent ? 1 : args.priority,
            project: args.project,
            groupFolder,
            chatJid,
            timestamp: new Date().toISOString()
          };

          writeIpcFile(TASKS_DIR, data);

          return {
            content: [{
              type: 'text',
              text: `Task added to Sugar queue: "${args.task}"${args.type ? ` (${args.type})` : ''}${args.project ? ` [project: ${args.project}]` : ''}`
            }]
          };
        }
      ),

      tool(
        'sugar_list',
        `List tasks in Sugar queue with optional filtering.

Examples:
- sugar_list() - all pending tasks in default project
- sugar_list({ status: "pending", project: "frontend" }) - only pending tasks in frontend project
- sugar_list({ status: "completed" }) - only completed tasks
- sugar_list({ status: "active" }) - currently running tasks`,
        {
          status: z.enum(['pending', 'active', 'completed', 'failed', 'all']).optional().describe('Filter by status'),
          limit: z.number().optional().describe('Maximum number of tasks to show'),
          project: z.string().optional().describe('Project name (uses default if not specified)')
        },
        async (args) => {
          const data = {
            type: 'sugar_list',
            status: args.status || 'pending',
            limit: args.limit,
            project: args.project,
            groupFolder,
            chatJid,
            timestamp: new Date().toISOString()
          };

          writeIpcFile(TASKS_DIR, data);

          return {
            content: [{
              type: 'text',
              text: `Fetching Sugar task list${args.project ? ` for ${args.project}` : ''}...`
            }]
          };
        }
      ),

      tool(
        'sugar_status',
        `Get Sugar system status and queue statistics.

Shows:
- Total tasks in queue
- Task counts by status
- Currently active task
- Recent activity

Example: sugar_status({ project: "frontend" })`,
        {
          project: z.string().optional().describe('Project name (uses default if not specified)')
        },
        async (args) => {
          const data = {
            type: 'sugar_status',
            project: args.project,
            groupFolder,
            chatJid,
            timestamp: new Date().toISOString()
          };

          writeIpcFile(TASKS_DIR, data);

          return {
            content: [{
              type: 'text',
              text: `Fetching Sugar status${args.project ? ` for ${args.project}` : ''}...`
            }]
          };
        }
      ),

      tool(
        'sugar_run',
        `Start Sugar autonomous execution. Sugar will work through the task queue.

Options:
- continuous: Run continuously (auto-discovers GitHub issues, processes tasks repeatedly)
- once: Run once through the queue and exit (default, safer)
- dry_run: Safe mode without making actual changes

Examples:
- sugar_run({ project: "frontend" }) - Run once
- sugar_run({ project: "frontend", continuous: true }) - Run continuously until stopped`,
        {
          project: z.string().optional().describe('Project name (uses default if not specified)'),
          dry_run: z.boolean().optional().describe('Run in dry-run mode (safe, no actual changes)'),
          continuous: z.boolean().optional().describe('Run continuously until stopped (auto-discovers issues, processes tasks repeatedly)')
        },
        async (args) => {
          const data = {
            type: 'sugar_run',
            project: args.project,
            dryRun: args.dry_run || false,
            continuous: args.continuous || false,
            groupFolder,
            chatJid,
            timestamp: new Date().toISOString()
          };

          writeIpcFile(TASKS_DIR, data);

          const mode = args.continuous ? 'continuous mode' : 'once';
          return {
            content: [{
              type: 'text',
              text: `Starting Sugar for ${args.project || 'default'} (${mode})${args.dry_run ? ' (dry-run)' : ''}...`
            }]
          };
        }
      ),

      tool(
        'sugar_stop',
        `Stop a running Sugar process.

Example: sugar_stop({ project: "frontend" })`,
        {
          project: z.string().optional().describe('Project name to stop Sugar for (uses default if not specified)')
        },
        async (args) => {
          const data = {
            type: 'sugar_stop',
            project: args.project,
            groupFolder,
            chatJid,
            timestamp: new Date().toISOString()
          };

          writeIpcFile(TASKS_DIR, data);

          return {
            content: [{
              type: 'text',
              text: `Stopping Sugar for ${args.project || 'default'}...`
            }]
          };
        }
      ),

      tool(
        'sugar_list_projects',
        `List all configured Sugar projects.

Shows project names, paths, and which is the default.

Main group only - used to manage which projects Sugar works with.`,
        {} as Record<string, never>,
        async () => {
          const data = {
            type: 'sugar_list_projects',
            groupFolder,
            chatJid,
            timestamp: new Date().toISOString()
          };

          writeIpcFile(TASKS_DIR, data);

          return {
            content: [{
              type: 'text',
              text: `Fetching configured Sugar projects...`
            }]
          };
        }
      ),

      tool(
        'sugar_add_project',
        `Add a new Sugar project configuration.

Main group only - configures a project for Sugar to work with.

Example: sugar_add_project({ name: "frontend", path: "/path/to/frontend", repo: "owner/repo", default: true })`,
        {
          name: z.string().describe('Project name (e.g., "frontend", "backend")'),
          path: z.string().describe('Absolute path to the project directory'),
          repo: z.string().optional().describe('GitHub repo in "owner/repo" format (optional)'),
          default: z.boolean().optional().describe('Set as default project (first project is auto-default)')
        },
        async (args) => {
          const data = {
            type: 'sugar_add_project',
            name: args.name,
            projectPath: args.path,
            repo: args.repo,
            default: args.default,
            groupFolder,
            chatJid,
            timestamp: new Date().toISOString()
          };

          writeIpcFile(TASKS_DIR, data);

          return {
            content: [{
              type: 'text',
              text: `Adding project "${args.name}"...`
            }]
          };
        }
      ),

      tool(
        'sugar_init',
        `Initialize Sugar in a project directory.

Run this once per project before adding tasks.

Example: sugar_init({ project: "backend" })`,
        {
          project: z.string().describe('Project name to initialize Sugar in')
        },
        async (args) => {
          const data = {
            type: 'sugar_init',
            project: args.project,
            groupFolder,
            chatJid,
            timestamp: new Date().toISOString()
          };

          writeIpcFile(TASKS_DIR, data);

          return {
            content: [{
              type: 'text',
              text: `Initializing Sugar in ${args.project}...`
            }]
          };
        }
      ),

      // ===== GitHub Integration Tools =====

      tool(
        'github_list_issues',
        `List GitHub issues for a repository.

Examples:
- github_list_issues({ repo: "owner/repo" })
- github_list_issues({ repo: "owner/repo", state: "open", limit: 10 })

Requires: GitHub CLI (gh) installed and authenticated.`,
        {
          repo: z.string().describe('Repository in "owner/repo" format'),
          state: z.enum(['open', 'closed', 'all']).optional().describe('Filter by issue state'),
          limit: z.number().optional().describe('Maximum number of issues to return')
        },
        async (args) => {
          const data = {
            type: 'github_list_issues',
            repo: args.repo,
            state: args.state,
            limit: args.limit,
            groupFolder,
            chatJid,
            timestamp: new Date().toISOString()
          };

          writeIpcFile(TASKS_DIR, data);

          return {
            content: [{
              type: 'text',
              text: `Fetching issues from ${args.repo}...`
            }]
          };
        }
      ),

      tool(
        'github_create_task_from_issue',
        `Create a Sugar task from a GitHub issue.

This will:
1. Fetch the issue details from GitHub
2. Create a Sugar task with the issue title and content
3. Map issue labels to task type (bug → bug_fix, etc.)

Example: github_create_task_from_issue({ repo: "owner/repo", issue_number: 42 })`,
        {
          repo: z.string().describe('Repository in "owner/repo" format'),
          issue_number: z.number().describe('GitHub issue number')
        },
        async (args) => {
          const data = {
            type: 'github_create_task_from_issue',
            repo: args.repo,
            issueNumber: args.issue_number,
            groupFolder,
            chatJid,
            timestamp: new Date().toISOString()
          };

          writeIpcFile(TASKS_DIR, data);

          return {
            content: [{
              type: 'text',
              text: `Creating task from issue #${args.issue_number}...`
            }]
          };
        }
      ),

      tool(
        'github_create_pr',
        `Create a pull request from the current branch.

Example:
- github_create_pr({ repo: "owner/repo", branch: "feature-branch" })
- github_create_pr({ repo: "owner/repo", branch: "feature-branch", title: "My PR", body: "Description" })

If title/body not provided, will auto-fill from commits.`,
        {
          repo: z.string().describe('Repository in "owner/repo" format'),
          branch: z.string().describe('Branch name to create PR from'),
          title: z.string().optional().describe('PR title (optional, auto-filled from commits if not provided)'),
          body: z.string().optional().describe('PR body/description (optional)')
        },
        async (args) => {
          const data = {
            type: 'github_create_pr',
            repo: args.repo,
            branch: args.branch,
            title: args.title,
            body: args.body,
            groupFolder,
            chatJid,
            timestamp: new Date().toISOString()
          };

          writeIpcFile(TASKS_DIR, data);

          return {
            content: [{
              type: 'text',
              text: `Creating PR for branch ${args.branch}...`
            }]
          };
        }
      ),

      tool(
        'github_pr_status',
        `List pull requests for a repository.

Example: github_pr_status({ repo: "owner/repo" })`,
        {
          repo: z.string().describe('Repository in "owner/repo" format')
        },
        async (args) => {
          const data = {
            type: 'github_pr_status',
            repo: args.repo,
            groupFolder,
            chatJid,
            timestamp: new Date().toISOString()
          };

          writeIpcFile(TASKS_DIR, data);

          return {
            content: [{
              type: 'text',
              text: `Fetching PR status for ${args.repo}...`
            }]
          };
        }
      ),

      // ===== Knowledge Base Tools =====

      tool(
        'kb_list',
        `List all entries in the Knowledge Base.

The Knowledge Base (KB) stores external knowledge like articles, videos, PDFs, and documents that have been shared via URLs.

Examples:
- kb_list() - List all KB entries for current group
- kb_list({ group_folder: "main" }) - List entries for specific group (main only)

Main group can see all groups' entries. Other groups see only their own.`,
        {
          group_folder: z.string().optional().describe('Target group folder (main only can specify other groups)')
        },
        async (args) => {
          const data = {
            type: 'kb_list',
            groupFolder: args.group_folder,
            chatJid,
            isMain,
            timestamp: new Date().toISOString()
          };

          writeIpcFile(TASKS_DIR, data);

          return {
            content: [{
              type: 'text',
              text: `Listing KB entries${args.group_folder ? ` for ${args.group_folder}` : '...'}`
            }]
          };
        }
      ),

      tool(
        'kb_search',
        `Search the Knowledge Base by semantic similarity.

Finds relevant content from articles, videos, PDFs, and documents stored in the KB.

Examples:
- kb_search({ query: "Claude marketing" }) - Search for Claude marketing content
- kb_search({ query: "task management", limit: 5 }) - Get top 5 results

Results are ranked by semantic similarity to your query.`,
        {
          query: z.string().describe('Search query to find relevant content'),
          limit: z.number().optional().describe('Maximum number of results to return (default: 5)')
        },
        async (args) => {
          const data = {
            type: 'kb_search',
            query: args.query,
            limit: args.limit,
            groupFolder,
            chatJid,
            timestamp: new Date().toISOString()
          };

          writeIpcFile(TASKS_DIR, data);

          return {
            content: [{
              type: 'text',
              text: `Searching KB for: "${args.query}"...`
            }]
          };
        }
      ),

      tool(
        'kb_update',
        `Update an existing KB entry by URL or source ID.

Use this to:
- Refresh/re-index a URL (re-fetches content)
- Update metadata (title, tags) for an entry

Examples:
- kb_update({ url: "https://youtube.com/watch?v=xxx" }) - Refresh video transcript
- kb_update({ source_id: "kb-xxx", title: "New Title", tags: ["marketing"] }) - Update metadata

Note: This updates EXISTING entries. For new content, simply share the URL in chat.`,
        {
          url: z.string().optional().describe('URL of the content to update'),
          source_id: z.string().optional().describe('Source ID of the entry to update'),
          content: z.string().optional().describe('New text content to update (for direct text entries)'),
          title: z.string().optional().describe('New title for the KB entry'),
          tags: z.array(z.string()).optional().describe('Tags to categorize the entry')
        },
        async (args) => {
          const data = {
            type: 'kb_update',
            url: args.url,
            sourceId: args.source_id,
            content: args.content,
            title: args.title,
            tags: args.tags,
            groupFolder,
            chatJid,
            timestamp: new Date().toISOString()
          };

          writeIpcFile(TASKS_DIR, data);

          return {
            content: [{
              type: 'text',
              text: `Updating KB entry${args.url ? ` for URL` : args.source_id ? ` ${args.source_id}` : args.content ? ` with content` : ''}...`
            }]
          };
        }
      ),

      tool(
        'kb_add',
        `Add plain text or notes to the Knowledge Base.

Use this for storing any text content you want to search later - dates, preferences, reminders, notes, etc.

Examples:
- kb_add({ content: "Marriage anniversary: April 16th, 2022" })
- kb_add({ content: "Neet prefers coffee, Bhavi prefers tea", title: "Beverage preferences" })
- kb_add({ content: "Remember to call mom on Sundays", tags: ["family", "reminder"] })

The KB will create embeddings so this can be found later via semantic search.`,
        {
          content: z.string().describe('The text content to store'),
          title: z.string().optional().describe('Optional title for the entry'),
          tags: z.array(z.string()).optional().describe('Optional tags for categorization')
        },
        async (args) => {
          const data = {
            type: 'kb_add',
            content: args.content,
            title: args.title,
            tags: args.tags,
            groupFolder,
            chatJid,
            timestamp: new Date().toISOString()
          };

          writeIpcFile(TASKS_DIR, data);

          return {
            content: [{
              type: 'text',
              text: `Adding to KB...`
            }]
          };
        }
      ),

      tool(
        'kb_delete',
        `Delete a KB entry by source ID.

⚠️ WARNING: This deletes from the KNOWLEDGE BASE (SQLite database), NOT your memory files.

KB stores external knowledge (articles, videos, PDFs) shared via URLs.
Memory stores your learned info in /workspace/group/CLAUDE.md.

Before deleting:
1. Use kb_list() to find the entry
2. Confirm the source_id with the user
3. Use this tool with the source_id

Example:
- kb_delete({ source_id: "kb-1739451234-abc123" })

The entry and all its chunks will be permanently removed.`,
        {
          source_id: z.string().describe('The source ID of the KB entry to delete (e.g., "kb-1739451234-abc123")')
        },
        async (args) => {
          const data = {
            type: 'kb_delete',
            sourceId: args.source_id,
            groupFolder,
            chatJid,
            timestamp: new Date().toISOString()
          };

          writeIpcFile(TASKS_DIR, data);

          return {
            content: [{
              type: 'text',
              text: `Deleting KB entry: ${args.source_id}`
            }]
          };
        }
      )
    ]
  });
}
