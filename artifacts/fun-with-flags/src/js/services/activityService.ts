import { AVAILABLE_COMMANDS } from '../handlers/commands.js';
import { apiFetch } from './api.js';

// Names are metadata, never an excerpt of shell source. Unknown executables,
// paths, aliases and shell expressions share one deliberately generic name.
const ACTIVITY_COMMANDS = new Set([
  ...AVAILABLE_COMMANDS, 'leaderboard', 'top', 'rank', 'groups', 'history',
  'mail', 'reset-shell',
]);

export function activityCommandName(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const first = trimmed.split(/\s+/, 1)[0]?.toLowerCase() ?? '';
  if (!/^[a-z][a-z0-9_-]*$/.test(first) || !ACTIVITY_COMMANDS.has(first)) {
    return 'shell command';
  }
  // Never attribute a pipeline or nested command to the first executable.
  if (/[|;&<>`$()\n\r]/.test(trimmed)) return 'shell command';
  return first;
}

/** Best-effort, bounded and request-owned; activity must not affect the shell. */
export async function recordCommandActivity(line: string): Promise<void> {
  const command = activityCommandName(line);
  if (!command) return;
  try {
    await apiFetch<void>('/activity/command', {
      method: 'POST',
      body: JSON.stringify({ command }),
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    // No logging: a transport exception may include private request context.
  }
}