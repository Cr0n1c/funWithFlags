import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatAllChallenges, parseTerminalText, processCommand } from '../src/js/terminal/terminal.js';
import { getAutocompleteSuggestions } from '../src/js/handlers/commands.js';
import type { Challenge } from '../src/js/services/ctfService.js';
import { beginImportChallenges, handleGuidedInput } from '../src/js/terminal/flagAdminState.js';

vi.mock('../src/js/services/authService.js', () => ({
  isAuthenticated: () => true,
  getCurrentUser: () => ({ account_id: 'offline-test-account' }),
  login: vi.fn(),
  logout: vi.fn(),
  checkAuthStatus: vi.fn(),
}));
vi.mock('../src/js/services/mailService.js', () => ({
  checkMail: vi.fn().mockResolvedValue({ delivered: false }),
}));

const challenge = (id: number, category: string): Challenge => ({
  id, category, slug: `challenge-${id}`, title: `Puzzle ${id}`,
  description: '', points: id, solved: false, solve_count: 0,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('bare challenge listing', () => {
  it('shows imported Hello World in bare and explicit Gold browsing and opens its help clue', async () => {
    const intro = {
      ...challenge(99, 'Intro'), slug: 'hello-world', title: 'Hello World', points: 5,
      description: 'Type help to find your first flag and learn how to submit it.',
    };
    let imported = false;
    const prefix = { textContent: 'hpux01$ ' };
    vi.stubGlobal('document', {
      getElementById: (id: string) => id === 'input-prefix' ? prefix : null,
    });
    const fetchMock = vi.fn().mockImplementation((url: string, options?: RequestInit) => {
      let body: unknown;
      if (url.endsWith('/flag-admin/import-challenges')) {
        if (options?.method === 'POST') {
          expect(JSON.parse(typeof options.body === 'string' ? options.body : ''))
            .toEqual({ terminal_missing: ['hello-world'] });
          imported = true;
          body = { created: 1, unchanged: 0 };
        } else {
          body = { puzzles: [], terminal: [{
            slug: intro.slug, title: intro.title, points: 5, missing: true,
          }] };
        }
      } else if (url.endsWith('/challenges/id/99')) {
        body = intro;
      } else {
        body = imported ? [intro] : [];
      }
      return Promise.resolve(new Response(JSON.stringify(body)));
    });
    vi.stubGlobal('fetch', fetchMock);
    const preview = await beginImportChallenges('hpux01$ ');
    expect(preview.output).toContain('Hello World — 5 pts (Gold track; missing)');
    expect(preview.output).not.toContain('OWASP');
    expect((await handleGuidedInput('yes')).output).toContain('1 created');
    for (const command of ['challenges gold', 'challenges']) {
      const output = await processCommand(command);
      expect(output).toContain('Hello World');
      expect(output).toContain('Intro');
      expect(output).toContain('challenge-id:99');
    }
    expect(await processCommand('challenges describe 99')).toContain(intro.description);
    const combined = formatAllChallenges([intro]);
    expect(combined).not.toContain('Other categories');
    expect(combined.match(/Hello World/g)).toHaveLength(1);
  });

  it('includes Talks in Gold and never duplicates them under Other categories', async () => {
    const rows = [
      { ...challenge(10, 'Talks'), title: 'Talk: Demo Day 10/02', points: 500 },
      challenge(11, 'talks'), challenge(12, 'misc'),
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(rows))));
    const output = await processCommand('challenges gold');
    expect(output).toContain('Talks');
    expect(output).toContain('Talk: Demo Day 10/02');
    expect(output).toContain('500');
    expect(output).toContain('Puzzle 11');
    expect(output).not.toContain('Puzzle 12');
    const combined = formatAllChallenges(rows);
    expect(combined.match(/Talk: Demo Day 10\/02/g)).toHaveLength(1);
    expect(combined.indexOf('Talk: Demo Day 10/02')).toBeLessThan(combined.indexOf('Other categories'));
    expect(combined.indexOf('Puzzle 12')).toBeGreaterThan(combined.indexOf('Other categories'));
  });
  it('marks Gold completion only from the current user solved state and refreshes each listing', async () => {
    const rows = [
      { ...challenge(1, 'gold'), solved: true },
      { ...challenge(2, 'OWASP'), solve_count: 12 },
      { ...challenge(3, 'Cracking'), solved: true },
    ];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(rows)))
      .mockResolvedValueOnce(new Response(JSON.stringify(rows.map(c => ({ ...c, solved: true })))))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(rows.map(c => ({ ...c, solved: false })))),
      );
    vi.stubGlobal('fetch', fetchMock);
    const visible = (output: string) => parseTerminalText(output).map(segment => segment.text).join('');
    const first = visible(await processCommand('challenges gold'));
    expect(first).toContain('completed');
    expect(first).toMatch(/Puzzle 1\s*\|\s*1\s*\|\s*x\s*\|/);
    expect(first).toMatch(/Puzzle 2\s*\|\s*2\s*\|\s*\|/);
    expect(first).toMatch(/Puzzle 3\s*\|\s*3\s*\|\s*x\s*\|/);
    // A later correct submission is reflected without retaining the old list.
    const afterSolve = visible(await processCommand('challenges gold'));
    expect(afterSolve).toMatch(/Puzzle 2\s*\|\s*2\s*\|\s*x\s*\|/);
    // Another user's solved flags replace, rather than inherit, completion marks.
    const otherUser = visible(await processCommand('challenges gold'));
    expect(otherUser).not.toMatch(/\|\s*x\s*\|/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('includes OWASP and Cracking in Gold without changing their categories or including others', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify([
      challenge(1, 'gold'), { ...challenge(2, 'OWASP'), title: 'Find sensitive data in common files on system' },
       challenge(3, 'cracking'), challenge(4, 'misc'),
    ]))));
    const output = await processCommand('challenges gold');
    expect(output).toContain('Find sensitive data in common files on system');
    expect(output).toContain('OWASP');
    expect(output).toContain('Puzzle 3');
    expect(output).toContain('cracking');
    expect(output).not.toContain('Puzzle 4');
  });

  it('lists only Cracking rows through the same table view as challenges gold', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([
      challenge(1, 'gold'), challenge(2, 'Cracking'), challenge(3, 'cracking'),
      challenge(4, 'misc'),
    ])));
    vi.stubGlobal('fetch', fetchMock);
    const output = await processCommand('challenges CRACKING');
    expect(output).toContain('Puzzle 2');
    expect(output).toContain('Puzzle 3');
    expect(output).not.toContain('Puzzle 1');
    expect(output).not.toContain('Puzzle 4');
    expect(parseTerminalText(output).filter(segment => segment.challengeId)
      .map(segment => segment.challengeId))
      .toEqual([2, 2, 3, 3]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/challenges', expect.anything());
    expect(getAutocompleteSuggestions('challenges cra')).toEqual(['challenges cracking']);
  });

  it('orders Gold before all other categories without dropping rows', () => {
    const rows = [
      challenge(5, 'Cracking'), challenge(3, 'forensics'), challenge(1, 'gold'), challenge(4, 'misc'),
    ];
    const output = formatAllChallenges(rows);
    const visible = parseTerminalText(output).map(segment => segment.text).join('');
    const indices = ['Puzzle 5', 'Puzzle 1', 'Other categories', 'Puzzle 3', 'Puzzle 4']
      .map(label => visible.indexOf(label));
    expect(indices.every(index => index >= 0)).toBe(true);
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
    expect(rows.map(row => row.id)).toEqual([5, 3, 1, 4]);
    expect(output).toContain('challenge-id:5');
    expect(output.match(/challenge-id:5/g)).toHaveLength(2); // one row, linked id and title
    expect(visible).toContain('Cracking');
  });

  it('lists Gold directly for a bare command, with no track prompt', async () => {
    const prefix = { textContent: 'hpux01$ ' };
    vi.stubGlobal('document', { getElementById: () => prefix });
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify(
      [challenge(1, 'gold'), challenge(2, 'misc')],
    ))));
    vi.stubGlobal('fetch', fetchMock);
    for (const command of ['challenges', 'challenge', 'challenges gold']) {
      const before = fetchMock.mock.calls.length;
      const output = await processCommand(command);
      expect(output).toContain('Puzzle 1');
      expect(output).not.toContain('Puzzle 2');
      expect(output).not.toContain('Choose a challenge track');
      expect((fetchMock.mock.calls as Array<[string]>).slice(before).map(([url]) => url))
        .toEqual(['/api/challenges']);
      expect(prefix.textContent).toBe('hpux01$ ');
    }
    expect(['c', 'g', 'd'].flatMap(letter => getAutocompleteSuggestions(`challenges ${letter}`)))
      .toEqual(['challenges cracking', 'challenges gold', 'challenges describe']);
    expect(['b', 'r'].flatMap(letter => getAutocompleteSuggestions(`challenges ${letter}`)))
      .toEqual([]);
  });
});
