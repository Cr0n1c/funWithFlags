import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatAllChallenges, formatChallenges, parseTerminalText, processCommand } from '../src/js/terminal/terminal.js';
import { getAutocompleteSuggestions } from '../src/js/handlers/commands.js';
import type { Challenge } from '../src/js/services/ctfService.js';

vi.mock('../src/js/services/authService.js', () => ({
  isAuthenticated: () => true,
  getCurrentUser: () => null,
  login: vi.fn(),
  logout: vi.fn(),
  checkAuthStatus: vi.fn(),
}));

const hidden: Challenge = {
  id: 24, slug: 'secret-slug', category: 'gold', title: '<hidden>',
  description: '<hidden>', points: 50, solved: false, solve_count: 2,
};

afterEach(() => vi.unstubAllGlobals());

describe('numeric challenge details', () => {
  it('renders exactly the four requested table columns and safe internal buttons', () => {
    const text = formatChallenges([hidden]);
    expect(text).toMatch(/\|\s+id\s+\|\s+category\s+\|\s+title\s+\|\s+points\s+\|/);
    expect(text).not.toContain('secret-slug');
    expect(parseTerminalText(text).filter(s => s.challengeId)).toEqual([
      { text: '24', challengeId: 24 },
      { text: '<hidden>', challengeId: 24 },
    ]);
    expect(parseTerminalText('\x1b]8;;challenge-id:1<script>\x07bad\x1b]8;;\x07'))
      .toEqual([{ text: 'bad' }]);
    const other = { ...hidden, category: 'forensics' };
    const all = formatAllChallenges([other]);
    expect(all).toContain('Other categories');
    expect(parseTerminalText(all).filter(s => s.challengeId)).toEqual([
      { text: '24', challengeId: 24 },
      { text: '<hidden>', challengeId: 24 },
    ]);
  });

  it('fetches fresh numeric detail, preserves slug lookup, and validates IDs', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(hidden)));
    vi.stubGlobal('fetch', fetchMock);
    const output = await processCommand('challenges describe 24');
    expect(fetchMock).toHaveBeenCalledWith('/api/challenges/id/24', expect.objectContaining({
      credentials: 'same-origin',
    }));
    expect(output).toContain('unique solve_count: 2');
    expect(output).not.toContain('description:');
    expect(output).toContain('<hidden>');
    await processCommand('challenges secret-slug');
    expect(fetchMock).toHaveBeenCalledWith('/api/challenges/secret-slug', expect.anything());
    const calls = fetchMock.mock.calls.length;
    expect(await processCommand('challenges describe 1x')).toContain('Usage: challenges describe <id>');
    expect(fetchMock).toHaveBeenCalledTimes(calls);
    expect(getAutocompleteSuggestions('challenges de')).toContain('challenges describe');
  });
});