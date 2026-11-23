export type AdventureLocation = 'road' | 'building' | 'forest' | 'grate';

export interface AdventureState {
  phase: 'instructions' | 'playing' | 'ended';
  location: AdventureLocation;
}

export interface AdventureTurn {
  state: AdventureState;
  output: string;
  quit: boolean;
}

const DESCRIPTIONS: Record<AdventureLocation, string> = {
  road: 'YOU ARE STANDING AT THE END OF A ROAD BEFORE A SMALL BRICK BUILDING.\nAROUND YOU IS A FOREST.',
  building: 'YOU ARE INSIDE A SMALL BRICK BUILDING. A DUSTY NOTICE IS TACKED TO THE WALL.',
  forest: 'YOU ARE IN A QUIET FOREST. A NARROW PATH LEADS EAST; THE ROAD IS SOUTH.',
  grate: 'A STEEL GRATE IS SET INTO THE GROUND. SCRATCHED LETTERS ARE VISIBLE ON ITS FRAME.',
};

const INSTRUCTIONS = [
  'TYPE NORTH, SOUTH, EAST, WEST (OR N, S, E, W) TO MOVE.',
  'TYPE LOOK, EXAMINE, OR READ TO INVESTIGATE.',
  'TYPE QUIT OR ESCAPE TO RETURN TO THE SHELL.',
].join('\n');

export function newAdventure(): AdventureState {
  return { phase: 'instructions', location: 'road' };
}

export function adventureGreeting(): string {
  return 'WELCOME TO ADVENTURE!! WOULD YOU LIKE INSTRUCTIONS?\n\n> ';
}

function playing(state: AdventureState, output: string): AdventureTurn {
  return { state, output, quit: false };
}

function move(state: AdventureState, direction: string): AdventureTurn {
  const exits: Partial<Record<AdventureLocation, Partial<Record<string, AdventureLocation>>>> = {
    road: { north: 'building', east: 'forest' },
    building: { south: 'road' },
    forest: { south: 'road', east: 'grate', west: 'road' },
    grate: { west: 'forest' },
  };
  const destination = exits[state.location]?.[direction];
  if (!destination) return playing(state, 'YOU CANNOT GO THAT WAY.');
  const next = { ...state, location: destination };
  return playing(next, DESCRIPTIONS[destination]);
}

/** Advance the deliberately tiny, entirely fictional adventure. */
export function adventureTurn(state: AdventureState, input: string): AdventureTurn {
  const command = input.trim().toLowerCase();
  if (state.phase === 'ended') return { state, output: 'THE ADVENTURE HAS ENDED.', quit: true };
  if (state.phase === 'instructions') {
    if (['quit', 'escape'].includes(command)) {
      return { state: { ...state, phase: 'ended' }, output: 'FAREWELL, ADVENTURER.', quit: true };
    }
    if (['yes', 'y'].includes(command)) {
      const next = { ...state, phase: 'playing' as const };
      return playing(next, `${INSTRUCTIONS}\n\n${DESCRIPTIONS.road}`);
    }
    if (['no', 'n'].includes(command)) {
      const next = { ...state, phase: 'playing' as const };
      return playing(next, DESCRIPTIONS.road);
    }
    return playing(state, 'PLEASE ANSWER YES OR NO.');
  }

  if (['quit', 'exit', 'escape'].includes(command)) {
    return { state: { ...state, phase: 'ended' }, output: 'YOU LEAVE THE ADVENTURE AND RETURN TO HP-UX.', quit: true };
  }
  if (['help', 'instructions'].includes(command)) return playing(state, INSTRUCTIONS);
  if (['look', 'l'].includes(command)) return playing(state, DESCRIPTIONS[state.location]);
  if (['north', 'n', 'south', 's', 'east', 'e', 'west', 'w'].includes(command)) {
    const directions: Record<string, string> = { n: 'north', s: 'south', e: 'east', w: 'west' };
    return move(state, directions[command] ?? command);
  }
  if (['examine', 'x', 'read'].includes(command)) {
    if (state.location === 'building') {
      return playing(state, 'THE NOTICE READS: "FOREST DRAINAGE INSPECTION MOVED TO THE EASTERN GRATE."');
    }
    if (state.location === 'grate') {
      return playing(state, 'THE FICTIONAL SCRATCHING READS: "CORE STRINGS REMEMBER WHAT FORTUNE FORGETS."');
    }
    return playing(state, 'YOU FIND NOTHING UNUSUAL HERE.');
  }
  if (!command) return playing(state, '');
  return playing(state, "I DON'T UNDERSTAND THAT. TYPE HELP FOR INSTRUCTIONS.");
}

export interface FortuneState {
  index: number;
}

export interface FortuneOutcome {
  state: FortuneState;
  output: string;
  core: string | null;
}

const FORTUNES = [
  'You will find what you seek in the least likely directory.',
  'Old systems reward the patient reader.',
  'The operator forgot something in /tmp.',
] as const;

export const SYNTHETIC_CORE = [
  'HP-UX fictional fortune process image',
  'signal=SIGSEGV (simulated; no process crashed)',
  'PROGRAM=fortune',
  'CLUE=CORE STRINGS REMEMBER WHAT FORTUNE FORGETS',
  'PASSWORD=FICTIONAL-NOT-A-REAL-SECRET',
  'build=adventure@hpux01.invalid',
  '',
].join('\n');

/** A deterministic cycle makes the fourth invocation the simulated crash. */
export function nextFortune(state: FortuneState): FortuneOutcome {
  const position = state.index % (FORTUNES.length + 1);
  const next = { index: state.index + 1 };
  if (position === FORTUNES.length) {
    return { state: next, output: 'Segmentation fault (core dumped)', core: SYNTHETIC_CORE };
  }
  return { state: next, output: FORTUNES[position]!, core: null };
}

export interface GlitchState {
  garbled: boolean;
}

export function isWeirdFileCat(command: string): boolean {
  return /^\s*cat\s+\/tmp\/weirdfile\s*$/.test(command);
}

export function isTerminalRecovery(command: string): boolean {
  return /^\s*(?:reset|stty\s+sane)\s*$/.test(command);
}

/** Benign printable notation: this never emits actual terminal control bytes. */
export function representGarbledOutput(output: string): string {
  if (!output) return '[terminal garble: ^[?1h ^[= (printable simulation)]';
  return output.split('\n').map((line) =>
    line ? `^[?1h ^[= ${line.replace(/[^\x20-\x7e]/g, '?')}` : line,
  ).join('\n');
}