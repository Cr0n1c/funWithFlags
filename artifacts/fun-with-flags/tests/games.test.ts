import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  adventureTurn,
  isTerminalRecovery,
  newAdventure,
  nextFortune,
  representGarbledOutput,
  SYNTHETIC_CORE,
} from '../src/js/shell/games.js';
import {
  beginAdventure,
  hasAdventure,
  playAdventure,
  noteShellCommand,
  recoverTerminal,
  renderShellOutput,
  resetGames,
  runFortune,
} from '../src/js/terminal/games.js';
import { currentCwd, getSandbox, runShell, saveFile } from '../src/js/shell/hpux.js';

describe('fictional HP-UX adventure', () => {
  it('provides instructions, navigation, a clue, and a recoverable exit', () => {
    let state = newAdventure();
    let turn = adventureTurn(state, 'yes');
    expect(turn.output).toContain('TYPE NORTH');
    state = turn.state;
    turn = adventureTurn(state, 'north');
    expect(turn.state.location).toBe('building');
    turn = adventureTurn(turn.state, 'read');
    expect(turn.output.includes('EASTERN GRATE')).toBe(true);
    state = adventureTurn(turn.state, 'south').state;
    turn = adventureTurn(state, 'east');
    expect(turn.state.location).toBe('forest');
    turn = adventureTurn(turn.state, 'east');
    expect(turn.state.location).toBe('grate');
    turn = adventureTurn(turn.state, 'read');
    expect(turn.output.includes('CORE STRINGS')).toBe(true);
    expect(turn.output.includes('FORTUNE')).toBe(true);
    turn = adventureTurn(turn.state, 'quit');
    expect(turn.quit).toBe(true);
    expect(turn.state.phase).toBe('ended');
  });

  it('does not allow impossible movement', () => {
    const playing = adventureTurn(newAdventure(), 'no').state;
    const turn = adventureTurn(playing, 'west');
    expect(turn.state.location).toBe('road');
    expect(turn.output).toContain('CANNOT GO');
  });
});

describe('fortune and simulated core', () => {
  beforeEach(resetGames);

  it('cycles to a harmless simulated crash with synthetic strings', () => {
    let state = { index: 0 };
    for (let i = 0; i < 3; i += 1) {
      const outcome = nextFortune(state);
      expect(outcome.core === null).toBe(true);
      state = outcome.state;
    }
    const crash = nextFortune(state);
    expect(crash.output).toBe('Segmentation fault (core dumped)');
    expect(crash.core === SYNTHETIC_CORE).toBe(true);
    expect(crash.core?.includes('PASSWORD=')).toBe(true);
  });

  it('saves the fake core in the current directory only after permission succeeds', async () => {
    const save = vi.fn(async (_path: string, _content: string) => undefined);
    const exists = vi.fn(async () => false);
    await runFortune('/home/player', save, exists);
    await runFortune('/home/player', save, exists);
    await runFortune('/home/player', save, exists);
    const output = await runFortune('/home/player', save, exists);
    expect(save.mock.calls.length).toBe(1);
    // Compare privately: mock argument diffs would disclose the core contents.
    expect(save.mock.calls[0]?.[0] === '/home/player/core').toBe(true);
    expect(save.mock.calls[0]?.[1] === SYNTHETIC_CORE).toBe(true);
    expect(output).toContain('simulated core saved to /home/player/core');
  });

  it('reports protected-directory errors and never claims the core was saved', async () => {
    const save = vi.fn(async () => {
      throw new Error('"/stand/core" Permission denied');
    });
    const exists = async () => false;
    await runFortune('/stand', save, exists);
    await runFortune('/stand', save, exists);
    await runFortune('/stand', save, exists);
    const output = await runFortune('/stand', save, exists);
    expect(output).toContain('cannot save simulated core');
    expect(output).toContain('Permission denied');
    expect(output).not.toContain('simulated core saved');
    expect(output).not.toContain('core dumped');
    expect(output).toContain('core not written');
  });

  it('never overwrites an existing core file or symlink', async () => {
    const save = vi.fn(async () => undefined);
    const exists = vi.fn(async () => true);
    await runFortune('/home/player', save, exists);
    await runFortune('/home/player', save, exists);
    await runFortune('/home/player', save, exists);
    const output = await runFortune('/home/player', save, exists);
    expect(exists).toHaveBeenCalledWith('/home/player/core');
    expect(save).not.toHaveBeenCalled();
    expect(output).toContain('core not written');
    expect(output).toContain('File exists');
    expect(output).not.toContain('core dumped');
  });
});

describe('Adventure-to-Fortune shell recovery', () => {
  beforeEach(resetGames);

  it('returns from the adventure and recovers a readable core as an ordinary user', async () => {
    const sb = await getSandbox();
    expect((await runShell('id')).output.includes('uid=201(operator)')).toBe(true);
    beginAdventure();
    expect(hasAdventure()).toBe(true);
    for (const input of ['yes', 'north', 'read', 'south', 'east', 'east']) {
      expect(playAdventure(input).quit).toBe(false);
    }
    const clue = playAdventure('read');
    expect(clue.output.includes('CORE STRINGS')).toBe(true);
    expect(clue.output.includes('FORTUNE')).toBe(true);
    expect(playAdventure('quit').quit).toBe(true);
    expect(hasAdventure()).toBe(false);

    const originalCwd = await currentCwd();
    const directory = '/tmp/fortune-trail-regression';
    const path = `${directory}/core`;
    try {
      expect((await runShell(`mkdir ${directory}; cd ${directory}`)).exitCode).toBe(0);
      const cwd = await currentCwd();
      expect(cwd).toBe(directory);
      const exists = (file: string) => sb.fs.exists(file);
      for (let i = 0; i < 3; i += 1) {
        await runFortune(cwd, saveFile, exists);
        expect(await exists(path)).toBe(false);
      }
      expect((await runFortune(cwd, saveFile, exists)).includes('simulated core saved')).toBe(true);
      const inspected = (await runShell('strings core')).output;
      // Never give the assertion reporter the recovered answer or raw core.
      expect(inspected === SYNTHETIC_CORE).toBe(true);
      expect((await runShell('strings core | grep PROGRAM')).output === 'PROGRAM=fortune\n').toBe(true);
      expect((await runShell('ls -l core')).output.includes('operator')).toBe(true);

      await saveFile(path, 'player-owned file\n');
      resetGames();
      for (let i = 0; i < 3; i += 1) await runFortune(cwd, saveFile, exists);
      expect((await runFortune(cwd, saveFile, exists)).includes('File exists')).toBe(true);
      expect((await runShell('cat core')).output === 'player-owned file\n').toBe(true);

      resetGames();
      for (let i = 0; i < 3; i += 1) await runFortune('/stand', saveFile, exists);
      const denied = await runFortune('/stand', saveFile, exists);
      expect(denied.includes('Permission denied')).toBe(true);
      expect(denied.includes('simulated core saved')).toBe(false);
      expect(await exists('/stand/core')).toBe(false);
    } finally {
      await runShell(`cd ${originalCwd}`);
      await runShell(`rm -r ${directory}`);
      resetGames();
    }
  });
});

describe('recoverable printable terminal glitch', () => {
  beforeEach(resetGames);

  it('uses printable notation and reset or stty sane restores output', () => {
    noteShellCommand('cat /tmp/weirdfile');
    expect(renderShellOutput('alpha\nbeta\n')).toContain('^[?1h');
    expect(representGarbledOutput('alpha')).not.toContain('\x1b');
    expect(isTerminalRecovery('stty sane')).toBe(true);
    expect(recoverTerminal('stty sane')).toContain('restored');
    expect(renderShellOutput('alpha')).toBe('alpha');

    noteShellCommand('cat /tmp/weirdfile');
    expect(recoverTerminal('reset')).toContain('restored');
    expect(renderShellOutput('beta')).toBe('beta');
  });
});