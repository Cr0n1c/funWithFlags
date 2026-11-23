/** Deliberate CTF hook, NOT browser-extension detection or access control. */
export const SOURCE_PUZZLE_EVENT = 'ctf:claude-source-clue';
export const SOURCE_PUZZLE_MESSAGE = [
  "That's clever, here is a flag {everything_1$_fair_game}",
  '[CTF fiction — no browser extension was detected or blocked]',
  'BTW, I have blocked Claude in Chrome from running on this site, try harder!',
].join('\n');

export function createSourcePuzzle(
  accountId: () => string | null,
  print: (message: string) => void,
) {
  let readyAccount: string | null = null;
  let pending = false;
  const delivered = new Set<string>();
  const flush = () => {
    const current = accountId();
    if (!pending || !current || current !== readyAccount || delivered.has(current)) return;
    print(SOURCE_PUZZLE_MESSAGE);
    delivered.add(current);
    pending = false;
  };
  return {
    trigger() { pending = true; flush(); },
    bootComplete() { readyAccount = accountId(); flush(); },
  };
}

export function blockPageContextMenu(
  event: { preventDefault(): void },
  groups: readonly string[] | undefined,
): void {
  // Casual deterrent only; downloaded source is never a secret.
  if (!groups?.includes('funwithflags-admins')) event.preventDefault();
}

export function blockSourceShortcut(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'
    | 'preventDefault' | 'stopImmediatePropagation'>,
  groups: readonly string[] | undefined,
): void {
  if (groups?.includes('funwithflags-admins')) return;
  const key = event.key.toLowerCase();
  const source = (event.ctrlKey && !event.altKey && key === 'u')
    || (event.metaKey && event.altKey && key === 'u');
  const tools = key === 'f12'
    || (event.ctrlKey && event.shiftKey && ['i', 'j', 'c', 'k'].includes(key))
    || (event.metaKey && event.altKey && ['i', 'j', 'c', 'k'].includes(key));
  if (source || tools) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}
