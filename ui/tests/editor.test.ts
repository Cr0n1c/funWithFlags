import { describe, expect, it } from 'vitest';
import { editorInput, openEditor } from '../src/js/shell/editor.js';

describe('line editor', () => {
  it('opens a new file and appends lines', () => {
    const { session, output } = openEditor('/tmp/x.txt', null, true, null);
    expect(output).toContain('[New file]');
    expect(editorInput(session, 'hello').done).toBe(false);
    editorInput(session, 'world');
    expect(session.lines).toEqual(['hello', 'world']);
    expect(session.dirty).toBe(true);
    const step = editorInput(session, ':wq');
    expect(step).toMatchObject({ done: true, save: 'hello\nworld\n' });
    expect(step.output).toContain('2 lines, 12 characters written');
  });

  it('shows existing content and supports delete/insert/change', () => {
    const { session, output } = openEditor('/home/operator/notes.txt', 'a\nb\nc\n', true, null);
    expect(output).toContain('3 lines, 6 characters');
    expect(editorInput(session, ':p').output).toBe('    1  a\n    2  b\n    3  c');
    editorInput(session, ':2d');
    editorInput(session, ':1i zero');
    editorInput(session, ':3c C');
    expect(session.lines).toEqual(['zero', 'a', 'C']);
    expect(editorInput(session, ':%d').output).toContain('3 line(s) deleted');
    expect(editorInput(session, ':p').output).toContain('(empty buffer)');
  });

  it('refuses :q with unsaved changes and honours :q!', () => {
    const { session } = openEditor('/tmp/y', null, true, null);
    editorInput(session, 'x');
    expect(editorInput(session, ':q')).toMatchObject({ done: false });
    expect(editorInput(session, ':q!')).toMatchObject({ done: true });
    expect(editorInput(session, 'ZZ').save).toBeDefined();
  });

  it('cannot write a read-only file', () => {
    const { session, output } = openEditor('/etc/passwd', 'root:x\n', false, '"/etc/passwd" Permission denied');
    expect(output).toContain('[Read only]');
    editorInput(session, 'evil');
    const step = editorInput(session, ':wq');
    expect(step.done).toBe(false);
    expect(step.save).toBeUndefined();
    expect(step.output).toContain('Permission denied');
  });

  it('reports unknown colon commands', () => {
    const { session } = openEditor('/tmp/z', null, true, null);
    expect(editorInput(session, ':bogus').output).toContain('Not an editor command');
    expect(editorInput(session, ':help').output).toContain(':wq');
  });
});
