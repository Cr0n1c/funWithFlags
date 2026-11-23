import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/js/services/authService.js', () => ({
  checkAuthStatus: vi.fn(),
  invalidateAuthentication: vi.fn(),
  isAuthenticated: () => true,
  login: vi.fn(),
  logout: vi.fn(),
  refreshCurrentUser: vi.fn(),
  getCurrentUser: () => ({ account_id: 'offline-admin' }),
}));

import {
  checkFlagAdminAccess,
  createFlag,
  deleteFlag,
  previewFlagDeletion,
  previewFlagBackup,
  importFlagBackup,
  downloadFlagBackup,
} from '../src/js/services/flagAdminService.js';
import {
  beginCreateFlag,
  beginDeleteFlag,
  beginImportChallenges,
  beginImportFlags,
  cancelGuidedSession,
  getGuidedSecretMask,
  guidedInputValue,
  handleGuidedInput,
  hasGuidedSession,
  isGuidedSecretInput,
  setGuidedSecretInput,
} from '../src/js/terminal/flagAdminState.js';
import { processCommand, redactSensitiveCommand } from '../src/js/terminal/terminal.js';
import { getAutocompleteSuggestions } from '../src/js/handlers/commands.js';

type FetchCall = [url: string, init?: { body?: string; method?: string }];
interface MockCalls { mock: { calls: unknown[][]; lastCall?: unknown[] } }

const fetchCalls = (mock: MockCalls): FetchCall[] => mock.mock.calls as FetchCall[];
const sentBody = (mock: MockCalls, index: number): string | undefined =>
  fetchCalls(mock)[index]?.[1]?.body;
const sentJson = (mock: MockCalls, index: number): Record<string, unknown> =>
  JSON.parse(String(sentBody(mock, index))) as Record<string, unknown>;
const lastUpdate = (mock: MockCalls): { output?: string; prompt?: string } | undefined =>
  mock.mock.lastCall?.[0] as { output?: string; prompt?: string } | undefined;

const normalPrompt = 'player@hpux01:$ ';
const created = {
  slug: 'random-8c903',
  title: 'Gold challenge',
  description: 'Find the thing',
  points: 75,
  hidden: false,
  category: 'gold' as const,
};
const preview = {
  slug: 'random-8c903',
  title: 'Gold challenge',
  points: 75,
  confirmation_token: 'one-use-token',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

afterEach(() => {
  cancelGuidedSession();
  vi.unstubAllGlobals();
});

describe('flag admin API contract', () => {
  it('posts backup bytes unchanged and downloads without displaying hashes', async () => {
    const payload = '{"version":1,"key_id":"SENSITIVE","challenges":[]}';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ missing: 0, identical: 0, conflicts: 0 }))
      .mockResolvedValueOnce(json({ created: 1, identical: 0 }))
      .mockResolvedValueOnce(new Response(payload, { headers: { 'X-Flag-Count': '1' } }));
    vi.stubGlobal('fetch', fetchMock);
    const clicked = vi.fn();
    const removed = vi.fn();
    const revoked = vi.fn();
    vi.stubGlobal('document', {
      createElement: () => ({ style: {}, click: clicked, remove: removed }),
      body: { appendChild: vi.fn() },
    });
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:offline', revokeObjectURL: revoked });
    vi.stubGlobal('window', { setTimeout: (fn: () => void) => { fn(); } });
    expect(await previewFlagBackup(payload)).toEqual({ missing: 0, identical: 0, conflicts: 0 });
    expect(await importFlagBackup(payload)).toEqual({ created: 1, identical: 0 });
    expect(await downloadFlagBackup(() => true)).toBe(1);
    expect(sentBody(fetchMock, 0)).toBe(payload);
    expect(sentBody(fetchMock, 1)).toBe(payload);
    expect(fetchMock.mock.calls[2]?.[0]).toBe('/api/flag-admin/export-flags');
    expect(clicked).toHaveBeenCalledOnce();
    expect(removed).toHaveBeenCalledOnce();
    expect(revoked).toHaveBeenCalledWith('blob:offline');
  });

  it('never opens a file chooser when access is denied', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ detail: 'Permission denied' }, 403)));
    const update = vi.fn();
    const result = await beginImportFlags(normalPrompt, update);
    expect(result.output).toBe('Permission denied');
    expect(hasGuidedSession()).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it('selects a native file, previews, cancels or confirms only missing rows', async () => {
    type NodeStub = {
      type: string;
      textContent: string;
      value: string;
      files: Array<{ size: number; text: () => Promise<string> }> | null;
      disabled: boolean;
      removed: boolean;
      children: NodeStub[];
      handlers: Record<string, () => Promise<void> | void>;
      append: (...children: NodeStub[]) => void;
      appendChild: (child: NodeStub) => void;
      addEventListener: (name: string, fn: () => Promise<void> | void) => void;
      setAttribute: () => void;
      remove: () => void;
      click: () => void;
    };
    const nodes: NodeStub[] = [];
    const makeNode = (): NodeStub => {
      const node: NodeStub = {
        type: '', textContent: '', value: '', files: null, disabled: false, removed: false,
        children: [], handlers: {},
        append(...children) { this.children.push(...children); },
        appendChild(child) { this.children.push(child); },
        addEventListener(name, fn) { this.handlers[name] = fn; },
        setAttribute() {},
        remove() { this.removed = true; },
        click() { void this.handlers.click?.(); },
      };
      nodes.push(node);
      return node;
    };
    const terminal = makeNode();
    vi.stubGlobal('document', {
      createElement: makeNode,
      getElementById: () => terminal,
    });
    const payload = '{"version":1,"key_id":"private","challenges":[]}';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ allowed: true }))
      .mockResolvedValueOnce(json({ missing: 0, identical: 2, conflicts: 0 }))
      .mockResolvedValueOnce(json({ allowed: true }))
      .mockResolvedValueOnce(json({ missing: 1, identical: 2, conflicts: 0 }))
      .mockResolvedValueOnce(json({ allowed: true }))
      .mockResolvedValueOnce(json({ missing: 1, identical: 2, conflicts: 0 }))
      .mockResolvedValueOnce(json({ created: 1, identical: 2 }));
    vi.stubGlobal('fetch', fetchMock);
    const update = vi.fn();
    const select = async () => {
      const input = [...nodes].reverse().find(node => node.type === 'file')!;
      input.files = [{ size: payload.length, text: () => Promise.resolve(payload) }];
      await input.handlers.change?.();
    };
    await beginImportFlags(normalPrompt, update);
    expect([...nodes].reverse().find(node => node.type === 'file')).toBeDefined();
    await select();
    expect(lastUpdate(update)?.output).toContain('No import request sent');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await beginImportFlags(normalPrompt, update);
    const chooser = [...nodes].reverse().find(node => node.type === 'file')!;
    chooser.files = null;
    await chooser.handlers.change?.(); // native picker cancelled; still usable
    expect(hasGuidedSession()).toBe(true);
    await select();
    expect(lastUpdate(update)?.prompt).toBe('Import missing flags? [y/N]: ');
    expect(cancelGuidedSession()?.output).toBe('Cancelled.');
    expect(chooser.value).toBe('');
    expect(fetchMock).toHaveBeenCalledTimes(4); // no commit on cancellation

    await beginImportFlags(normalPrompt, update);
    await select();
    const result = await handleGuidedInput('yes');
    expect(result.output).toContain('1 created, 2 identical unchanged');
    expect(result.refresh).toBe(true);
    expect(fetchMock.mock.calls[6]?.[0]).toBe('/api/flag-admin/import-flags');
    expect(sentBody(fetchMock, 6)).toBe(payload);
    expect(hasGuidedSession()).toBe(false);
  });
  it('uses the fixed paths, methods, and JSON shapes', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ allowed: true }))
      .mockResolvedValueOnce(json(created))
      .mockResolvedValueOnce(json(preview))
      .mockResolvedValueOnce(json({ deleted: true, title: preview.title, points: preview.points }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(checkFlagAdminAccess()).resolves.toEqual({ allowed: true });
    await expect(createFlag({
      title: created.title,
      description: created.description,
      flag: 'xsecurity{gold}',
      points: created.points,
      hidden: created.hidden,
    })).resolves.toEqual(created);
    await expect(previewFlagDeletion('xsecurity{gold}')).resolves.toEqual(preview);
    await expect(deleteFlag(preview.slug, preview.confirmation_token)).resolves.toEqual({
      deleted: true, title: preview.title, points: preview.points,
    });

    expect(fetchCalls(fetchMock).map(([url]) => url)).toEqual([
      '/api/flag-admin/access',
      '/api/flag-admin/flags',
      '/api/flag-admin/delete-preview',
      `/api/flag-admin/flags/${preview.slug}`,
    ]);
    expect(sentJson(fetchMock, 1)).toEqual({
      title: created.title,
      description: created.description,
      flag: 'xsecurity{gold}',
      points: 75,
      hidden: false,
    });
    expect(fetchMock.mock.calls[3]?.[1]).toEqual(expect.objectContaining({
      method: 'DELETE',
      body: JSON.stringify({ confirmation_token: preview.confirmation_token }),
    }));
  });
});

describe('create_flag guided state', () => {
  async function start(): Promise<void> {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ allowed: true })));
    const result = await beginCreateFlag(normalPrompt);
    expect(result.prompt).toBe('Flag title: ');
    expect(hasGuidedSession()).toBe(true);
  }

  it('does not prompt or write after access is denied', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ detail: 'Permission denied' }, 403));
    vi.stubGlobal('fetch', fetchMock);

    const result = await beginCreateFlag(normalPrompt);

    expect(result).toEqual(expect.objectContaining({
      output: 'Permission denied',
      prompt: normalPrompt,
      done: true,
    }));
    expect(hasGuidedSession()).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/flag-admin/access', expect.any(Object));
  });

  it('keeps invalid values on their step and accepts boundary values', async () => {
    await start();
    expect((await handleGuidedInput('')).prompt).toBe('Flag title: ');
    expect((await handleGuidedInput('x'.repeat(256))).prompt).toBe('Flag title: ');
    expect((await handleGuidedInput('T')).prompt).toBe('Short description: ');
    expect((await handleGuidedInput('')).prompt).toBe('Short description: ');
    expect((await handleGuidedInput('D')).prompt).toBe('Actual flag: ');
    expect(isGuidedSecretInput()).toBe(true);
    expect((await handleGuidedInput('   ')).prompt).toBe('Actual flag: ');
    expect((await handleGuidedInput('x'.repeat(4097))).prompt).toBe('Actual flag: ');
    expect((await handleGuidedInput('xsecurity{ok}')).prompt).toBe('Point value (0-1000000): ');
    for (const invalid of ['-1', '1.5', '1000001', 'word']) {
      expect((await handleGuidedInput(invalid)).prompt).toBe('Point value (0-1000000): ');
    }
    expect((await handleGuidedInput('1000000')).prompt).toBe('Hidden? [y/N]: ');
    expect((await handleGuidedInput('maybe')).prompt).toBe('Hidden? [y/N]: ');
  });

  it.each(['y', 'Y', 'yes', 'YES', 'YeS'])('creates on affirmative hidden answer %s', async (yes) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ allowed: true }))
      .mockResolvedValueOnce(json({ ...created, hidden: true }));
    vi.stubGlobal('fetch', fetchMock);
    await beginCreateFlag(normalPrompt);
    await handleGuidedInput(created.title);
    await handleGuidedInput(created.description);
    await handleGuidedInput('xsecurity{secret}');
    await handleGuidedInput('75');

    const result = await handleGuidedInput(yes);

    expect(result).toEqual(expect.objectContaining({ done: true, prompt: normalPrompt }));
    expect(result.output).toContain('Created gold challenge');
    expect(sentJson(fetchMock, 1).hidden).toBe(true);
    expect(hasGuidedSession()).toBe(false);
  });

  it.each(['n', 'N', 'no', 'NO', 'nO'])('creates a visible challenge on negative answer %s', async (no) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ allowed: true }))
      .mockResolvedValueOnce(json(created));
    vi.stubGlobal('fetch', fetchMock);
    await beginCreateFlag(normalPrompt);
    await handleGuidedInput(created.title);
    await handleGuidedInput(created.description);
    await handleGuidedInput('xsecurity{secret}');
    await handleGuidedInput('0');
    await handleGuidedInput(no);
    expect(sentJson(fetchMock, 1)).toEqual(
      expect.objectContaining({ points: 0, hidden: false }),
    );
  });

  it('masks secret input, never uses it as cancellation, and clears it on cancel', async () => {
    await start();
    await handleGuidedInput('Title');
    await handleGuidedInput('Description');
    setGuidedSecretInput('cancel');

    expect(guidedInputValue('••••••')).toBe('cancel');
    expect(getGuidedSecretMask()).toBe('••••••');
    expect(redactSensitiveCommand('delete_flag xsecurity{delete-me}'))
      .toBe('delete_flag [redacted]');
    expect(cancelGuidedSession()).toEqual(expect.objectContaining({
      output: 'Cancelled.',
      prompt: normalPrompt,
    }));
    expect(hasGuidedSession()).toBe(false);
    expect(guidedInputValue('visible')).toBe('visible');
  });

  it('redacts a reflected secret error and resets after auth loss', async () => {
    const secret = 'xsecurity{never-print}';
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(json({ allowed: true }))
      .mockResolvedValueOnce(json({ detail: `bad ${secret}` }, 400)));
    await beginCreateFlag(normalPrompt);
    await handleGuidedInput('Title');
    await handleGuidedInput('Description');
    await handleGuidedInput(secret);
    await handleGuidedInput('5');
    const error = await handleGuidedInput('no');
    expect(error.output).toBe('bad [redacted]');
    expect(error.output).not.toContain(secret);
    expect(hasGuidedSession()).toBe(false);

    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(json({ allowed: true }))
      .mockResolvedValueOnce(json({}, 401)));
    await beginCreateFlag(normalPrompt);
    await handleGuidedInput('Title');
    await handleGuidedInput('Description');
    await handleGuidedInput(secret);
    await handleGuidedInput('5');
    const expired = await handleGuidedInput('n');
    expect(expired.authLost).toBe(true);
    expect(hasGuidedSession()).toBe(false);
  });
});

describe('delete_flag guided state', () => {
  it.each(['y', 'Y', 'yes', 'YES', 'yEs'])('deletes only after affirmative %s', async (yes) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(preview))
      .mockResolvedValueOnce(json({ deleted: true, title: preview.title, points: preview.points }));
    vi.stubGlobal('fetch', fetchMock);

    const started = await beginDeleteFlag('xsecurity{delete}', normalPrompt);
    expect(started.output).toContain('"Gold challenge" (75 pts)');
    expect(started.output).toContain('personal and group points');
    expect(started.prompt).toBe('Are you sure? [y/N]: ');
    const result = await handleGuidedInput(yes);

    expect(result).toEqual(expect.objectContaining({ done: true, refresh: true }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(['', 'n', 'N', 'no', 'NO'])('cancels without DELETE for %j', async (no) => {
    const fetchMock = vi.fn().mockResolvedValue(json(preview));
    vi.stubGlobal('fetch', fetchMock);
    await beginDeleteFlag('xsecurity{delete}', normalPrompt);
    const result = await handleGuidedInput(no);
    expect(result.output).toBe('Deletion cancelled.');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reprompts unknown confirmation and redacts preview/errors', async () => {
    const secret = 'xsecurity{delete}';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ ...preview, title: `Challenge ${secret}` }))
      .mockResolvedValueOnce(json({ detail: `cannot delete ${secret}` }, 409));
    vi.stubGlobal('fetch', fetchMock);
    const started = await beginDeleteFlag(secret, normalPrompt);
    expect(started.output).not.toContain(secret);
    expect((await handleGuidedInput('perhaps')).prompt).toBe('Are you sure? [y/N]: ');
    const failed = await handleGuidedInput('yes');
    expect(failed.output).toBe('cannot delete [redacted]');
    expect(hasGuidedSession()).toBe(false);
  });
});

describe('import_challenges guided state', () => {
  it('masks the extra hard plaintext and imports only after confirmation', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ puzzles: [{
        slug: 'crack-the-hash-extra-hard', title: 'Crack The Hash: Extra Hard', points: 750,
      }], terminal: [] }))
      .mockResolvedValueOnce(json({ created: 1, unchanged: 3 }));
    vi.stubGlobal('fetch', fetchMock);
    expect((await beginImportChallenges(normalPrompt)).output).toContain('Crack The Hash: Extra Hard — 750 pts');
    expect((await handleGuidedInput('yes')).prompt).toBe('Extra hard original word (masked): ');
    expect(isGuidedSecretInput()).toBe(true);
    setGuidedSecretInput('synthetic-extra-hard-answer');
    const staged = await handleGuidedInput(guidedInputValue('masked'));
    expect(staged.display).toBe('[redacted]');
    expect(staged.output).not.toContain('synthetic-extra-hard-answer');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await handleGuidedInput('yes')).output).toContain('1 created');
    expect(sentJson(fetchMock, 1)).toEqual({
      'extra-hard': 'synthetic-extra-hard-answer', terminal_missing: [],
    });
    expect(hasGuidedSession()).toBe(false);
  });

  it('previews, masks all three words, confirms, and posts once', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ puzzles: ['easy', 'medium', 'hard'].map((name, i) => ({
        slug: `crack-the-hash-${name}`, title: `Crack The Hash: ${name[0]?.toUpperCase()}${name.slice(1)}`, points: [50, 150, 400][i],
      })), terminal: [] }))
       .mockResolvedValueOnce(json({ created: 3, unchanged: 7 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(getAutocompleteSuggestions('import_hash', true)).toEqual([]);
    expect(getAutocompleteSuggestions('import_terminal', true)).toEqual([]);
    expect(getAutocompleteSuggestions('import_challenges')).toEqual([]);
    expect(getAutocompleteSuggestions('import_challenges', true)).toEqual(['import_challenges']);
    const previewResult = await beginImportChallenges(normalPrompt);
    expect(previewResult.output).toContain('Crack The Hash: Easy — 50 pts');
    expect(previewResult.output).toContain('Crack The Hash: Medium — 150 pts');
    expect(previewResult.output).toContain('Crack The Hash: Hard — 400 pts');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await handleGuidedInput('yes')).prompt).toBe('Easy original word (masked): ');
    for (const [name, next] of [
      ['easy', 'Medium original word (masked): '],
      ['medium', 'Hard original word (masked): '],
      ['hard', 'Import missing challenges now? [y/N]: '],
    ]) {
      expect(isGuidedSecretInput()).toBe(true);
      setGuidedSecretInput(`offline-only-${name}`);
      expect(getGuidedSecretMask()).toBe('•'.repeat(`offline-only-${name}`.length));
      const result = await handleGuidedInput(guidedInputValue('masked'));
      expect(result.display).toBe('[redacted]');
      expect(result.prompt).toBe(next);
      expect(result.output).not.toContain(`offline-only-${name}`);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const result = await handleGuidedInput('yes');
    expect(result).toEqual(expect.objectContaining({ done: true, refresh: true }));
    expect(result.output).toContain('3 created, 7 existing unchanged');
    expect(sentJson(fetchMock, 1)).toEqual({
      easy: 'offline-only-easy', medium: 'offline-only-medium', hard: 'offline-only-hard',
      terminal_missing: [],
    });
    expect(hasGuidedSession()).toBe(false);
  });

  it('cancels before POST and clears state on denied and expired access', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(json({ puzzles: ['easy', 'medium', 'hard'].map(
      (name, i) => ({ slug: `crack-the-hash-${name}`, title: name, points: [50, 150, 400][i], missing: true }),
    ), terminal: [] })));
    vi.stubGlobal('fetch', fetchMock);
    await beginImportChallenges(normalPrompt);
    expect((await handleGuidedInput('no')).output).toBe('Import cancelled.');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await beginImportChallenges(normalPrompt);
    await handleGuidedInput('yes');
    setGuidedSecretInput('offline-only-never-post');
    expect(cancelGuidedSession()?.output).toBe('Cancelled.');
    expect(guidedInputValue('visible')).toBe('visible');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ detail: 'Permission denied' }, 403)));
    expect((await beginImportChallenges(normalPrompt)).output).toBe('Permission denied');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({}, 401)));
    expect((await beginImportChallenges(normalPrompt)).authLost).toBe(true);
    expect(hasGuidedSession()).toBe(false);
  });

  it('asks only for missing words and skips the import when all already exist', async () => {
    const puzzles = ['easy', 'medium', 'hard'].map((name, i) => ({
      slug: `crack-the-hash-${name}`, title: `Crack The Hash: ${name[0]?.toUpperCase()}${name.slice(1)}`, points: [50, 150, 400][i],
    })).filter(p => p.slug.endsWith('medium'));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ puzzles, terminal: [] }))
       .mockResolvedValueOnce(json({ created: 1, unchanged: 9 }))
      .mockResolvedValueOnce(json({ puzzles: [], terminal: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const start = await beginImportChallenges(normalPrompt);
    expect(start.output).toContain('Crack The Hash: Medium — 150 pts (Gold track / Cracking; missing)');
    expect((await handleGuidedInput('yes')).prompt).toBe('Medium original word (masked): ');
    expect((await handleGuidedInput('offline-medium')).prompt).toBe('Import missing challenges now? [y/N]: ');
    expect((await handleGuidedInput('yes')).output).toContain('1 created, 9 existing unchanged');
    expect(sentJson(fetchMock, 1)).toEqual({
      medium: 'offline-medium', terminal_missing: [],
    });
    expect((await beginImportChallenges(normalPrompt)).done).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('imports OWASP discoveries through the same command when all hashes already exist', async () => {
    const terminal = [{ slug: 'shell-backups', title: 'Find sensitive data in common files on system',
      points: 50, missing: true }];
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ puzzles: [], terminal }))
      .mockResolvedValueOnce(json({ created: 1, unchanged: 9 }));
    vi.stubGlobal('fetch', fetchMock);
    const start = await beginImportChallenges(normalPrompt);
    expect(start.output).toContain('Find sensitive data in common files on system');
    expect(start.done).toBe(false);
    expect(isGuidedSecretInput()).toBe(false);
    expect(start.prompt).toBe('Import missing Gold track challenges? [y/N]: ');
    const result = await handleGuidedInput('yes');
    expect(result.output).toContain('1 created, 9 existing unchanged');
    expect(result.refresh).toBe(true);
    expect(sentJson(fetchMock, 1)).toEqual({
      terminal_missing: ['shell-backups'],
    });
  });

  it('posts missing hash and terminal challenges together after one final confirmation', async () => {
    const puzzles = [{ slug: 'crack-the-hash-medium', title: 'Crack The Hash: Medium', points: 150 }];
    const terminal = [{ slug: 'shell-backups', title: 'Find sensitive data in common files on system',
      points: 50, missing: true }];
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ puzzles, terminal }))
      .mockResolvedValueOnce(json({ created: 2, unchanged: 8 }));
    vi.stubGlobal('fetch', fetchMock);
    await beginImportChallenges(normalPrompt);
    expect((await handleGuidedInput('yes')).prompt).toBe('Medium original word (masked): ');
    expect((await handleGuidedInput('offline-medium')).prompt).toBe('Import missing challenges now? [y/N]: ');
    expect((await handleGuidedInput('yes')).output).toContain('2 created, 8 existing unchanged');
    expect(sentJson(fetchMock, 1)).toEqual({
      medium: 'offline-medium', terminal_missing: ['shell-backups'],
    });
  });
});

describe('gold challenge board', () => {
  it('fetches fresh challenges, filters gold, and renders backend-masked hidden titles', async () => {
    const challenges = [
      {
        id: 41,
        slug: 'random-gold',
        title: '<hidden>',
        category: 'gold',
        description: 'masked',
        points: 90,
        solved: false,
        solve_count: 0,
      },
      {
        id: 42,
        slug: 'ordinary-other',
        title: 'Not gold',
        category: 'standard',
        description: 'other',
        points: 10,
        solved: false,
        solve_count: 0,
      },
    ];
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(json(challenges)));
    vi.stubGlobal('fetch', fetchMock);

    const first = await processCommand('challenges gold');
    const second = await processCommand('challenges gold');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(first).toMatch(/\|\s+id\s+\|\s+category\s+\|\s+title\s+\|\s+points\s+\|/);
    expect(first).toContain('<hidden>');
    expect(first).toContain('challenge-id:41');
    expect(first).not.toContain('random-gold');
    expect(first).not.toContain('Not gold');
    expect(second).toContain('<hidden>');
  });
});

describe('terminal secret input and history', () => {
  class FakeElement {
    dataset: Record<string, string> = {};
    hidden = false;
    contentEditable = 'true';
    innerText = '';
    textContent = '';
    style: Record<string, string> = {};
    children: FakeElement[] = [];

    appendChild(child: FakeElement): FakeElement {
      this.children.push(child);
      this.textContent += child.textContent;
      return child;
    }
    focus(): void {}
  }

  function keyboard(key: string, target: FakeElement, extra = {}): KeyboardEvent {
    return {
      key,
      target,
      preventDefault: vi.fn(),
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      ...extra,
    } as unknown as KeyboardEvent;
  }

  it('masks guided flag keystrokes and recalls only a redacted delete command', async () => {
    vi.stubGlobal('Audio', class {
      volume = 0;
      cloneNode() { return this; }
      play() { return Promise.resolve(); }
    });
    const { handleInput } = await import('../src/js/handlers/inputHandler.js');
    const output = new FakeElement();
    const input = new FakeElement();
    const wrapper = new FakeElement();
    const prefix = new FakeElement();
    prefix.textContent = normalPrompt;
    const elements = {
      'terminal-output': output,
      'terminal-input': input,
      'terminal-input-wrapper': wrapper,
      'input-prefix': prefix,
    };
    vi.stubGlobal('window', { getSelection: vi.fn().mockReturnValue(null) });
    const doc = Object.assign(new EventTarget(), {
      getElementById: (id: keyof typeof elements) => elements[id] ?? null,
      createElement: () => new FakeElement(),
      createTextNode: (text: string) => Object.assign(new FakeElement(), { textContent: text }),
      querySelector: () => null,
    });
    vi.stubGlobal('document', doc);
    const submitted = vi.fn<(event: Event) => void>();
    doc.addEventListener('terminal:command-submitted', submitted);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ allowed: true })));
    await beginCreateFlag(normalPrompt);
    await handleGuidedInput('Title');
    await handleGuidedInput('Description');
    await handleInput(keyboard('s', input));
    await handleInput(keyboard('e', input));
    expect(input.innerText).toBe('••');
    expect(input.innerText).not.toContain('se');
    expect(guidedInputValue(input.innerText)).toBe('se');
    expect(submitted).not.toHaveBeenCalled();
    cancelGuidedSession();
    expect(guidedInputValue('')).toBe('');

    const deleteSecret = 'xsecurity{history-secret}';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(preview)));
    input.innerText = `delete_flag ${deleteSecret}`;
    await handleInput(keyboard('Enter', input));
    expect(input.innerText).toBe('');
    expect(output.children[0]?.textContent).toContain(`${normalPrompt}delete_flag [redacted]`);
    expect(output.children.some((child) => child.textContent.includes(deleteSecret))).toBe(false);

    input.innerText = 'no';
    await handleInput(keyboard('Enter', input));
    expect(output.children[1]?.textContent).toContain('Are you sure? [y/N]: no');
    await handleInput(keyboard('ArrowUp', input));
    expect(input.innerText).toBe('delete_flag [redacted]');
    expect(input.innerText).not.toContain(deleteSecret);
    expect(submitted).toHaveBeenCalledTimes(2);
    for (const [event] of submitted.mock.calls) {
      expect(event).toBeInstanceOf(Event);
      expect(event.type).toBe('terminal:command-submitted');
      expect(event).not.toHaveProperty('detail');
    }
  });
});