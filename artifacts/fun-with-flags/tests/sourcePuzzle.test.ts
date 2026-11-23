import { expect, it, vi } from 'vitest';
import { createSourcePuzzle, blockPageContextMenu, blockSourceShortcut, SOURCE_PUZZLE_MESSAGE } from '../src/js/terminal/sourcePuzzle.js';

it('queues the source clue until sign-in and boot finish, then delivers once', () => {
  let account: string | null = null;
  const print = vi.fn();
  const puzzle = createSourcePuzzle(() => account, print);
  puzzle.trigger();
  puzzle.bootComplete();
  expect(print).not.toHaveBeenCalled();
  account = 'player';
  puzzle.trigger();
  expect(print).not.toHaveBeenCalled();
  puzzle.bootComplete();
  puzzle.trigger();
  expect(print).toHaveBeenCalledExactlyOnceWith(SOURCE_PUZZLE_MESSAGE);
  expect(SOURCE_PUZZLE_MESSAGE).toContain('{everything_1$_fair_game}');
  expect(SOURCE_PUZZLE_MESSAGE).toContain('no browser extension was detected or blocked');
});

it('waits for a new account to finish booting and does not reveal while signed out', () => {
  let account: string | null = 'one';
  const print = vi.fn();
  const puzzle = createSourcePuzzle(() => account, print);
  puzzle.bootComplete();
  account = null;
  puzzle.trigger();
  expect(print).not.toHaveBeenCalled();
  account = 'two';
  puzzle.trigger();
  expect(print).not.toHaveBeenCalled();
  puzzle.bootComplete();
  expect(print).toHaveBeenCalledTimes(1);
});

it('blocks page context menus for non-admins and signed-out visitors', () => {
  const event = { preventDefault: vi.fn() };
  blockPageContextMenu(event, undefined);
  blockPageContextMenu(event, []);
  blockPageContextMenu(event, ['funwithflags-admins-extra']);
  expect(event.preventDefault).toHaveBeenCalledTimes(3);
  blockPageContextMenu(event, ['funwithflags-admins']);
  expect(event.preventDefault).toHaveBeenCalledTimes(3);
});

it('deters common source/tool shortcuts but preserves editing keys and the admin exception', () => {
  const blocked = [
    { key: 'F12' }, { key: 'u', ctrlKey: true },
    { key: 'u', metaKey: true, altKey: true },
    ...['i', 'j', 'c', 'k'].flatMap(key => [
      { key, ctrlKey: true, shiftKey: true }, { key, metaKey: true, altKey: true },
    ]),
  ];
  for (const keys of blocked) {
    const event = {
      ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...keys,
      preventDefault: vi.fn(), stopImmediatePropagation: vi.fn(),
    };
    blockSourceShortcut(event, ['funwithflags-admins']);
    expect(event.preventDefault).not.toHaveBeenCalled();
    blockSourceShortcut(event, []);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopImmediatePropagation).toHaveBeenCalledOnce();
  }
  for (const key of ['c', 'v', 'x', 'a', 'z', 'Escape', 'Enter', 'Tab']) {
    for (const modifiers of [{ ctrlKey: true }, { metaKey: true }, {}]) {
      const event = {
        key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...modifiers,
        preventDefault: vi.fn(), stopImmediatePropagation: vi.fn(),
      };
      blockSourceShortcut(event, undefined);
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
  }
});
