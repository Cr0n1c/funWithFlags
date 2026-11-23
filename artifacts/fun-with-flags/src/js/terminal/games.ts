import {
  adventureGreeting,
  adventureTurn,
  isTerminalRecovery,
  isWeirdFileCat,
  newAdventure,
  nextFortune,
  representGarbledOutput,
  type AdventureState,
  type FortuneState,
} from '../shell/games.js';

let adventure: AdventureState | null = null;
let fortune: FortuneState = { index: 0 };
let garbled = false;

export function beginAdventure(): string {
  adventure = newAdventure();
  return adventureGreeting();
}

export function hasAdventure(): boolean {
  return adventure !== null;
}

export function playAdventure(input: string): { output: string; quit: boolean } {
  if (!adventure) return { output: '', quit: false };
  const turn = adventureTurn(adventure, input);
  adventure = turn.quit ? null : turn.state;
  return { output: turn.output, quit: turn.quit };
}

export async function runFortune(
  cwd: string,
  saveFile: (path: string, content: string) => Promise<void>,
  exists: (path: string) => boolean | Promise<boolean>,
): Promise<string> {
  const outcome = nextFortune(fortune);
  fortune = outcome.state;
  if (outcome.core === null) return outcome.output;
  const path = cwd === '/' ? '/core' : `${cwd.replace(/\/$/, '')}/core`;
  try {
    if (await exists(path)) {
      return `Simulated fault (core not written)\n    fortune: ${path}: File exists`;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Simulated fault (core not written)\n    fortune: cannot inspect ${path}: ${message}`;
  }
  try {
    await saveFile(path, outcome.core);
    return `${outcome.output}\n    simulated core saved to ${path}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Simulated fault (core not written)\n    fortune: cannot save simulated core at ${path}: ${message}`;
  }
}

export function recoverTerminal(command: string): string | null {
  if (!isTerminalRecovery(command)) return null;
  garbled = false;
  return '    Terminal settings restored.';
}

export function noteShellCommand(command: string): void {
  if (isWeirdFileCat(command)) garbled = true;
}

export function renderShellOutput(output: string): string {
  return garbled ? representGarbledOutput(output) : output;
}

/** Test hook: reset only ephemeral game/terminal state, never the filesystem. */
export function resetGames(): void {
  adventure = null;
  fortune = { index: 0 };
  garbled = false;
}