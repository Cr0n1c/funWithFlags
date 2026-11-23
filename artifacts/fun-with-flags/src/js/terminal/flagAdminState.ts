import { ApiError, AuthRequiredError, describeError } from '../services/api.js';
import {
  checkFlagAdminAccess,
  createFlag,
  deleteFlag,
  downloadFlagBackup,
  getChallengeImportStatus,
  importChallenges,
  importFlagBackup,
  previewFlagBackup,
  previewFlagDeletion,
  type DeletePreview,
  type HashPuzzleStatus,
} from '../services/flagAdminService.js';
import { getCurrentUser } from '../services/authService.js';
import { captureTerminalOwnership } from './lifecycle.js';

type CreateStep = 'title' | 'description' | 'flag' | 'points' | 'hidden';
type Session =
  | { kind: 'backup-access'; normalPrompt: string }
  | {
      kind: 'create';
      step: CreateStep;
      normalPrompt: string;
      title: string;
      description: string;
      flag: string;
      points: number;
    }
  | {
      kind: 'delete';
      normalPrompt: string;
      flag: string;
      preview: DeletePreview;
    }
  | {
      kind: 'hash-import';
      normalPrompt: string;
      step: 'preview' | 'easy' | 'medium' | 'hard' | 'extra-hard' | 'confirm';
      missing: ('easy' | 'medium' | 'hard' | 'extra-hard')[];
      puzzles: HashPuzzleStatus[];
      terminal: HashPuzzleStatus[];
      words: Partial<Record<'easy' | 'medium' | 'hard' | 'extra-hard', string>>;
    }
  | {
      kind: 'backup-import';
      normalPrompt: string;
      step: 'select' | 'confirm';
      data: string;
      owner: string;
      control: HTMLElement;
      preview: { missing: number; identical: number; conflicts: number };
    };

export interface GuidedResult {
  display: string;
  output: string;
  prompt: string;
  done: boolean;
  authLost?: boolean;
  refresh?: boolean;
}

const PROMPTS: Record<CreateStep, string> = {
  title: 'Flag title: ',
  description: 'Short description: ',
  flag: 'Actual flag: ',
  points: 'Point value (0-1000000): ',
  hidden: 'Hidden? [y/N]: ',
};

let session: Session | null = null;
let secretInput = '';
let sessionGeneration = 0;

export function hasGuidedSession(): boolean {
  return session !== null;
}

export function isGuidedSecretInput(): boolean {
  return (session?.kind === 'create' && session.step === 'flag')
    || (session?.kind === 'hash-import' && ['easy', 'medium', 'hard', 'extra-hard'].includes(session.step));
}

export function guidedInputValue(visibleValue: string): string {
  return isGuidedSecretInput() ? secretInput : visibleValue;
}

export function setGuidedSecretInput(value: string): void {
  if (isGuidedSecretInput()) secretInput = value;
}

export function getGuidedSecretMask(): string {
  return '•'.repeat(Array.from(secretInput).length);
}

function clearSession(): void {
  sessionGeneration++;
  if (session?.kind === 'create') session.flag = '';
  if (session?.kind === 'delete') session.flag = '';
  if (session?.kind === 'hash-import') session.words = {};
  if (session?.kind === 'backup-import') {
    session.data = '';
    session.control.remove();
  }
  secretInput = '';
  session = null;
}

export async function beginExportFlags(
  normalPrompt: string, ownsTerminal = captureTerminalOwnership(),
): Promise<GuidedResult> {
  try {
    const owner = getCurrentUser()?.account_id;
    if (!owner) throw new AuthRequiredError();
    const count = await downloadFlagBackup(() =>
      ownsTerminal() && getCurrentUser()?.account_id === owner);
    return { display: '', output: `Downloaded backup of ${count} challenges. Store it securely: it contains flag hashes.`,
      prompt: normalPrompt, done: true };
  } catch (error) {
    return failedStart(error, normalPrompt);
  }
}

export async function beginImportFlags(
  normalPrompt: string, update: (result: GuidedResult) => void,
  ownsTerminal = captureTerminalOwnership(),
): Promise<GuidedResult> {
  clearSession();
  const generation = sessionGeneration;
  session = { kind: 'backup-access', normalPrompt };
  try {
    const owner = getCurrentUser()?.account_id;
    const access = await checkFlagAdminAccess();
    if (!ownsTerminal() || generation !== sessionGeneration || access.allowed !== true
      || !owner || getCurrentUser()?.account_id !== owner) {
      throw new Error('Import session changed');
    }
    const control = document.createElement('span');
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Choose local backup file';
    button.setAttribute('aria-label', 'Choose local flag backup JSON file');
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.hidden = true;
    control.append(button, input);
    const output = document.getElementById('terminal-output');
    if (!output) throw new Error('Terminal is unavailable');
    output.appendChild(control);
    const current: Extract<Session, { kind: 'backup-import' }> = {
      kind: 'backup-import', normalPrompt, step: 'select', data: '', owner, control,
      preview: { missing: 0, identical: 0, conflicts: 0 },
    };
    session = current;
    button.addEventListener('click', () => input.click());
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      input.value = '';
      if (!file || session !== current || current.step !== 'select') return;
      if (file.size > 1_048_576) {
        update({ display: '', output: 'Backup exceeds size limit (1 MiB). Choose another file.',
          prompt: normalPrompt, done: false });
        return;
      }
      button.disabled = true;
      try {
        const data = await file.text();
        if (session !== current || getCurrentUser()?.account_id !== owner) return;
        const preview = await previewFlagBackup(data);
        if (session !== current || getCurrentUser()?.account_id !== owner) return;
        if (![preview.missing, preview.identical, preview.conflicts].every(
          value => Number.isSafeInteger(value) && value >= 0
        )) throw new Error('Invalid import preview response');
        current.preview = preview;
        if (preview.conflicts || !preview.missing) {
          clearSession();
          update({ display: '', output: preview.conflicts
            ? `Import blocked: ${preview.conflicts} conflicting challenges; ${preview.missing} missing, ${preview.identical} identical. Nothing changed.`
            : `Nothing to import: ${preview.identical} challenges already identical. No import request sent.`,
          prompt: normalPrompt, done: true });
          return;
        }
        current.data = data;
        current.step = 'confirm';
        control.remove();
        update({ display: '', output: `Backup preview: ${preview.missing} missing, ${preview.identical} identical, ${preview.conflicts} conflicts. Existing records, solves and scores remain unchanged. Import missing challenges?`,
          prompt: 'Import missing flags? [y/N]: ', done: false });
      } catch (error) {
        if (session !== current || getCurrentUser()?.account_id !== owner) return;
        update({ display: '', output: error instanceof ApiError && error.status === 403
          ? 'Permission denied' : error instanceof AuthRequiredError
            ? 'Session expired' : 'Unable to preview backup. Check format, version and flag key, then choose another file.',
        prompt: normalPrompt, done: false, authLost: error instanceof AuthRequiredError });
        if (error instanceof AuthRequiredError || error instanceof ApiError && error.status === 403) clearSession();
      } finally {
        if (session === current && current.step === 'select') button.disabled = false;
      }
    });
    return { display: '', output: 'Choose a local JSON backup using the button below. Escape or Ctrl+C cancels.',
      prompt: normalPrompt, done: false };
  } catch (error) {
    if (generation !== sessionGeneration) {
      return { display: '', output: '', prompt: normalPrompt, done: true };
    }
    return failedStart(error, normalPrompt);
  }
}

function safeError(error: unknown, secrets: string[]): string {
  let message = describeError(error);
  for (const secret of secrets) {
    if (secret) message = message.split(secret).join('[redacted]');
  }
  return message;
}

function failedStart(error: unknown, normalPrompt: string, secrets: string[] = []): GuidedResult {
  clearSession();
  if (error instanceof ApiError && error.status === 403) {
    return { display: '', output: 'Permission denied', prompt: normalPrompt, done: true };
  }
  return {
    display: '',
    output: safeError(error, secrets),
    prompt: normalPrompt,
    done: true,
    authLost: error instanceof AuthRequiredError,
  };
}

export async function beginCreateFlag(normalPrompt: string): Promise<GuidedResult> {
  clearSession();
  try {
    const access = await checkFlagAdminAccess();
    if (access.allowed !== true) throw new Error('Invalid access response from server');
    session = {
      kind: 'create',
      step: 'title',
      normalPrompt,
      title: '',
      description: '',
      flag: '',
      points: 0,
    };
    return {
      display: '',
      output: 'Create a gold challenge. Press Escape or Ctrl+C to cancel.',
      prompt: PROMPTS.title,
      done: false,
    };
  } catch (error) {
    return failedStart(error, normalPrompt);
  }
}

export async function beginImportChallenges(normalPrompt: string): Promise<GuidedResult> {
  clearSession();
  try {
    const { puzzles, terminal } = await getChallengeImportStatus();
    const names = ['easy', 'medium', 'hard', 'extra-hard'] as const;
    if (puzzles.length > names.length || puzzles.some((puzzle, index) =>
      !names.includes(puzzle.slug.replace('crack-the-hash-', '') as typeof names[number])
      || (index > 0 && names.indexOf(puzzle.slug.replace('crack-the-hash-', '') as typeof names[number])
        <= names.indexOf(puzzles[index - 1]!.slug.replace('crack-the-hash-', '') as typeof names[number]))
      || typeof puzzle.title !== 'string' || typeof puzzle.points !== 'number'
    )) throw new Error('Invalid import status response from server');
    if (!Array.isArray(terminal) || terminal.some(p =>
      typeof p.slug !== 'string' || typeof p.title !== 'string'
      || typeof p.points !== 'number' || p.missing !== true
    ) || new Set(terminal.map(p => p.slug)).size !== terminal.length) {
      throw new Error('Invalid terminal import status response from server');
    }
    const missing = puzzles.map(p => p.slug.replace('crack-the-hash-', '') as typeof names[number]);
    if (!missing.length && !terminal.length) {
      return {
        display: '', output: 'All built-in Gold track challenges already exist. Nothing to import.',
        prompt: normalPrompt, done: true,
      };
    }
    session = {
      kind: 'hash-import', normalPrompt, step: 'preview',
      words: {}, missing, puzzles, terminal,
    };
    return {
      display: '',
      output: [
        'Import only missing challenges:',
        ...puzzles.map(puzzle => `  ${puzzle.title} — ${puzzle.points} pts (Gold track / Cracking; missing)`),
        ...terminal.map(puzzle => `  ${puzzle.title} — ${puzzle.points} pts (Gold track; missing)`),
        `${names.length - missing.length} Cracking challenges already exist; terminal challenges not listed are unchanged.`,
        'Existing puzzles keep their IDs, answers, solves and points unchanged. Conflicts or a stale preview abort the import.',
        ...(missing.length ? ['Original words are masked and never saved in terminal history.'] : []),
        'Escape or Ctrl+C cancels.',
      ].join('\n'),
      prompt: missing.length
        ? 'Continue to masked word entry for missing puzzles? [y/N]: '
        : 'Import missing Gold track challenges? [y/N]: ',
      done: false,
    };
  } catch (error) {
    return failedStart(error, normalPrompt);
  }
}

export async function beginDeleteFlag(flag: string, normalPrompt: string): Promise<GuidedResult> {
  clearSession();
  try {
    const preview = await previewFlagDeletion(flag);
    session = { kind: 'delete', normalPrompt, flag, preview };
    const safeTitle = flag ? preview.title.split(flag).join('[redacted]') : preview.title;
    return {
      display: '',
      output: [
        `Delete "${safeTitle}" (${preview.points} pts)?`,
        'WARNING: personal and group points awarded for this challenge will be removed.',
      ].join('\n'),
      prompt: 'Are you sure? [y/N]: ',
      done: false,
    };
  } catch (error) {
    return failedStart(error, normalPrompt, [flag]);
  }
}

function validation(message: string, prompt: string, display: string): GuidedResult {
  return { display, output: message, prompt, done: false };
}

export async function handleGuidedInput(raw: string): Promise<GuidedResult> {
  const current = session;
  if (!current) throw new Error('No guided terminal operation is active');
  const secretStep = isGuidedSecretInput();
  const display = secretStep ? '[redacted]' : raw;

  if (!secretStep && raw.trim().toLowerCase() === 'cancel') {
    const prompt = current.normalPrompt;
    clearSession();
    return { display, output: 'Cancelled.', prompt, done: true };
  }

  if (current.kind === 'backup-access') {
    return validation('Checking access. Press Escape or Ctrl+C to cancel.',
      current.normalPrompt, display);
  }

  if (current.kind === 'backup-import') {
    if (current.step === 'select') {
      return validation('Use the Choose local backup file button, or press Escape to cancel.',
        current.normalPrompt, display);
    }
    const answer = raw.trim().toLowerCase();
    if (!['y', 'yes', '', 'n', 'no'].includes(answer)) {
      return validation('Please answer yes or no.', 'Import missing flags? [y/N]: ', display);
    }
    if (answer !== 'y' && answer !== 'yes') {
      clearSession();
      return { display, output: 'Import cancelled.', prompt: current.normalPrompt, done: true };
    }
    try {
      if (getCurrentUser()?.account_id !== current.owner) throw new AuthRequiredError();
      const result = await importFlagBackup(current.data);
      if (session !== current || getCurrentUser()?.account_id !== current.owner) {
        return { display: '', output: '', prompt: current.normalPrompt, done: true };
      }
      clearSession();
      return { display, output: `Import complete: ${result.created} created, ${result.identical} identical unchanged.`,
        prompt: current.normalPrompt, done: true, refresh: true };
    } catch (error) {
      if (session !== current) return { display: '', output: '', prompt: current.normalPrompt, done: true };
      clearSession();
      return { display, output: error instanceof ApiError && error.status === 403
        ? 'Permission denied' : error instanceof ApiError && error.status === 409
          ? 'Import conflict: existing challenges changed or a flag already exists. Nothing imported.'
          : 'Import result could not be confirmed. Check challenges before retrying.',
      prompt: current.normalPrompt, done: true, authLost: error instanceof AuthRequiredError };
    }
  }

  if (current.kind === 'delete') {
    const answer = raw.trim().toLowerCase();
    if (answer === '' || answer === 'n' || answer === 'no') {
      const prompt = current.normalPrompt;
      clearSession();
      return { display, output: 'Deletion cancelled.', prompt, done: true };
    }
    if (answer !== 'y' && answer !== 'yes') {
      return validation('Please answer yes or no.', 'Are you sure? [y/N]: ', display);
    }
    try {
      const deleted = await deleteFlag(current.preview.slug, current.preview.confirmation_token);
      const prompt = current.normalPrompt;
      const title = current.flag
        ? deleted.title.split(current.flag).join('[redacted]')
        : deleted.title;
      const output = `Deleted "${title}" (${deleted.points} pts).`;
      clearSession();
      return { display, output, prompt, done: true, refresh: true };
    } catch (error) {
      const prompt = current.normalPrompt;
      const authLost = error instanceof AuthRequiredError;
      const output = error instanceof ApiError && error.status === 403
        ? 'Permission denied'
        : safeError(error, [current.flag, current.preview.confirmation_token]);
      clearSession();
      return { display, output, prompt, done: true, authLost };
    }
  }

  if (current.kind === 'hash-import') {
    const wordPrompt = (name: string) => `${name[0]?.toUpperCase()}${name.slice(1).replaceAll('-', ' ')} original word (masked): `;
    if (current.step === 'preview' || current.step === 'confirm') {
      const answer = raw.trim().toLowerCase();
      if (answer === '' || answer === 'n' || answer === 'no') {
        const prompt = current.normalPrompt;
        clearSession();
        return { display, output: 'Import cancelled.', prompt, done: true };
      }
      if (answer !== 'y' && answer !== 'yes') {
        return validation('Please answer yes or no.',
          current.step === 'preview'
            ? (current.missing.length ? 'Continue to masked word entry for missing puzzles? [y/N]: '
              : 'Import missing Gold track challenges? [y/N]: ')
            : 'Import missing challenges now? [y/N]: ',
          display);
      }
      if (current.step === 'preview' && current.missing.length) {
        current.step = current.missing[0]!;
        return { display, output: '', prompt: wordPrompt(current.step), done: false };
      }
      const words = { ...current.words };
      const prompt = current.normalPrompt;
      clearSession();
      try {
        const result = await importChallenges(words, current.terminal.map(p => p.slug));
        return {
          display, output: `Challenge import complete: ${result.created} created, ${result.unchanged} existing unchanged.`,
          prompt, done: true, refresh: true,
        };
      } catch (error) {
        return {
          display,
          output: error instanceof ApiError && error.status === 403
            ? 'Permission denied' : safeError(error, Object.values(words)),
          prompt, done: true, authLost: error instanceof AuthRequiredError,
        };
      } finally {
        for (const name of current.missing) words[name] = '';
      }
    }
    secretInput = '';
    if (!raw || raw.length > 4096) {
      return validation('Original word must be 1 to 4096 characters.',
        wordPrompt(current.step), display);
    }
    current.words[current.step] = raw;
    const next = current.missing[current.missing.indexOf(current.step) + 1];
    if (next) {
      current.step = next;
      return { display, output: '', prompt: wordPrompt(next), done: false };
    }
    current.step = 'confirm';
    return {
      display, output: `Ready to import ${[...current.puzzles, ...current.terminal].map(p => `${p.title} (${p.points})`).join(', ')}.`,
      prompt: 'Import missing challenges now? [y/N]: ', done: false,
    };
  }

  switch (current.step) {
    case 'title':
      if (raw.length < 1 || raw.length > 255) {
        return validation('Title must be 1 to 255 characters.', PROMPTS.title, display);
      }
      current.title = raw;
      current.step = 'description';
      return { display, output: '', prompt: PROMPTS.description, done: false };
    case 'description':
      if (raw.length < 1 || raw.length > 1000) {
        return validation('Description must be 1 to 1000 characters.', PROMPTS.description, display);
      }
      current.description = raw;
      current.step = 'flag';
      secretInput = '';
      return { display, output: '', prompt: PROMPTS.flag, done: false };
    case 'flag':
      secretInput = '';
      if (raw.trim().length === 0 || raw.length > 4096) {
        return validation('Flag must be nonblank and at most 4096 characters.', PROMPTS.flag, display);
      }
      current.flag = raw;
      current.step = 'points';
      return { display, output: '', prompt: PROMPTS.points, done: false };
    case 'points': {
      if (!/^\d+$/.test(raw)) {
        return validation('Points must be an integer from 0 to 1000000.', PROMPTS.points, display);
      }
      const points = Number(raw);
      if (!Number.isSafeInteger(points) || points > 1_000_000) {
        return validation('Points must be an integer from 0 to 1000000.', PROMPTS.points, display);
      }
      current.points = points;
      current.step = 'hidden';
      return { display, output: '', prompt: PROMPTS.hidden, done: false };
    }
    case 'hidden': {
      const answer = raw.trim().toLowerCase();
      if (!['y', 'yes', 'n', 'no'].includes(answer)) {
        return validation('Please answer yes or no.', PROMPTS.hidden, display);
      }
      try {
        const created = await createFlag({
          title: current.title,
          description: current.description,
          flag: current.flag,
          points: current.points,
          hidden: answer === 'y' || answer === 'yes',
        });
        const prompt = current.normalPrompt;
        const title = current.flag
          ? created.title.split(current.flag).join('[redacted]')
          : created.title;
        const output = `Created gold challenge "${title}" (${created.points} pts).`;
        clearSession();
        return { display, output, prompt, done: true };
      } catch (error) {
        const prompt = current.normalPrompt;
        const authLost = error instanceof AuthRequiredError;
        const output = error instanceof ApiError && error.status === 403
          ? 'Permission denied'
          : safeError(error, [current.flag]);
        clearSession();
        return { display, output, prompt, done: true, authLost };
      }
    }
  }
}

export function cancelGuidedSession(): GuidedResult | null {
  if (!session) return null;
  const prompt = session.normalPrompt;
  clearSession();
  return { display: '', output: 'Cancelled.', prompt, done: true };
}