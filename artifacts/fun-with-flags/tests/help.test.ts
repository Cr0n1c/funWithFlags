import { describe, expect, it } from 'vitest';
import { getHelp } from '../src/js/config/content.js';
import { getAutocompleteSuggestions } from '../src/js/handlers/commands.js';

describe('CTF help guide', () => {
  it('offers personal point imports only to flag administrators', () => {
    expect(getHelp({ is_admin: true, groups: ['funwithflags-admins'] })).toContain('import_user_points');
    expect(getHelp({ is_admin: true, groups: [] })).not.toContain('import_user_points');
    expect(getAutocompleteSuggestions('import_user', true)).toEqual(['import_user_points']);
    expect(getAutocompleteSuggestions('import_user', false, true)).toEqual([]);
  });
  it('shows user_stats only to administrators in help and completion', () => {
    expect(getHelp({ is_admin: true, groups: [] })).toContain('user_stats');
    expect(getHelp({ is_admin: false, groups: [] })).not.toContain('user_stats');
    expect(getAutocompleteSuggestions('user_s', false, true)).toEqual(['user_stats']);
    expect(getAutocompleteSuggestions('user_s', true, false)).toEqual([]);
  });
  it('documents the CTF command set and shell exploration', () => {
    const help = getHelp({ is_admin: true, groups: ['funwithflags-admins'] });
    for (const command of [
      'challenges cracking', 'challenges gold', 'scoreboard [users|groups]',
      'leaderboard', 'top', 'status', 'whoami', 'groups', 'login', 'logout', 'autocopy [on|off]',
      'create_flag', 'delete_flag <flag>', 'import_challenges', 'reset-shell', 'clear', 'date', 'matrix_test',
    ]) expect(help).toContain(command);
    expect(help).toContain('Many Linux commands work');
    expect(help).toContain('funwithflags-admins');
    expect(help).toContain('submit hello_world');
    expect(help).toContain('Earn 5 pts for your first claim');
    expect(help).toContain('once per player and once per group');
    expect(help).not.toContain('sign-in starts automatically');
    expect(help).not.toContain('import_hash_challenges');
    expect(help).not.toContain('import_terminal_challenges');
    expect(help).toContain('List Gold track challenges');
  });
  it.each([
    null,
    { is_admin: false, groups: [] },
    { is_admin: false, groups: ['Funwithflags-admins', 'funwithflags-admins-other'] },
  ])('hides every admin command from an ordinary user: %j', (user) => {
    const help = getHelp(user);
    for (const command of ['user_stats', 'create_flag', 'delete_flag', 'import_challenges', 'funwithflags-admins']) {
      expect(help).not.toContain(command);
    }
  });
  it('keeps general-admin and flag-admin visibility separate', () => {
    const general = getHelp({ is_admin: true, groups: [] });
    expect(general).toContain('user_stats');
    expect(general).toContain('matrix_test');
    expect(general).not.toContain('create_flag');
    expect(general).not.toContain('delete_flag');
    const flags = getHelp({ is_admin: false, groups: ['funwithflags-admins'] });
    expect(flags).not.toContain('user_stats');
    expect(flags).toContain('matrix_test');
    expect(flags).toContain('after earning its points');
    expect(flags).toContain('create_flag');
    expect(flags).toContain('delete_flag');
  });
  it('offers matrix_test completion independently of admin role; execution requires a solve', () => {
    expect(getAutocompleteSuggestions('matrix_t')).toEqual(['matrix_test']);
    expect(getAutocompleteSuggestions('matrix_t', true, false)).toEqual(['matrix_test']);
    expect(getAutocompleteSuggestions('matrix_t', false, true)).toEqual(['matrix_test']);
  });
  it.each([
    null,
    { is_admin: false, groups: [] },
    { is_admin: true, groups: [] },
    { is_admin: false, groups: ['funwithflags-admins'] },
    { is_admin: true, groups: ['funwithflags-admins'] },
  ])('lists all visible commands alphabetically: %j', (user) => {
    const names = [...getHelp(user).matchAll(/^      - (\S+)/gm)].map(match => match[1]);
    expect(names).toEqual([...names].sort());
  });
});