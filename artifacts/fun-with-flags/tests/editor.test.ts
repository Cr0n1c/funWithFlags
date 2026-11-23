import { describe, expect, it } from 'vitest';
import { editorContent, editorKey, openEditor } from '../src/js/shell/editor.js';

function keys(session: ReturnType<typeof openEditor>, ...input: string[]) {
  let step = { done: false } as ReturnType<typeof editorKey>;
  for (const key of input) step = editorKey(session, key);
  return step;
}

describe('vi editor model', () => {
  it('edits in insert mode and writes with :wq', () => {
    const session = openEditor('/tmp/x.txt', null, true, null);
    keys(session, 'i', ...'hello'.split(''), 'Enter', ...'world'.split(''), 'Escape');
    expect(session.lines).toEqual(['hello', 'world']);
    expect(session.mode).toBe('normal');
    const step = keys(session, ':', 'w', 'q', 'Enter');
    expect(step).toMatchObject({ done: true, save: 'hello\nworld\n' });
    expect(step.message).toContain('2 lines, 12 characters written');
  });

  it('supports cursor motion, append, open, x and dd', () => {
    const session = openEditor('/tmp/x', 'abc\ndef\n', true, null);
    keys(session, 'l', 'x');
    expect(session.lines[0]).toBe('ac');
    keys(session, 'j', 'a', '!', 'Escape', 'o', ...'last'.split(''), 'Escape');
    expect(session.lines).toEqual(['ac', 'de!f', 'last']);
    keys(session, 'k', 'd', 'd');
    expect(session.lines).toEqual(['ac', 'last']);
    expect(editorContent(session)).toBe('ac\nlast\n');
  });

  it('refuses :q after changes and honours :q!', () => {
    const session = openEditor('/tmp/y', '', true, null);
    keys(session, 'i', 'x', 'Escape');
    expect(keys(session, ':', 'q', 'Enter').done).toBe(false);
    expect(session.message).toContain('No write');
    expect(keys(session, ':', 'q', '!', 'Enter').done).toBe(true);
  });

  it('keeps readonly buffers viewable but never produces a save', () => {
    const session = openEditor('/etc/passwd', 'root:x\n', false, 'Permission denied');
    keys(session, 'i', ...'evil'.split(''), 'Escape');
    const step = keys(session, ':', 'w', 'q', 'Enter');
    expect(step.done).toBe(false);
    expect(step.save).toBeUndefined();
    expect(session.message).toBe('Permission denied');
  });

  it('handles arrows, backspace joins and unknown commands', () => {
    const session = openEditor('/tmp/z', 'one\ntwo\n', true, null);
    keys(session, 'ArrowDown', 'i', 'Backspace');
    expect(session.lines).toEqual(['onetwo']);
    keys(session, 'Escape', ':', ...'bogus'.split(''), 'Enter');
    expect(session.message).toContain('Not an editor command');
  });
});