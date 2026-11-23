import { describe, expect, it } from 'vitest';
import { adaptShellCommands } from '../src/js/shell/commandAdapter.js';

describe('shell command adapter', () => {
  it('rewrites only literal command-position compatibility builtins', () => {
    expect(adaptShellCommands('test -f file; [ -d "/tmp/a b" ] && cd /tmp'))
      .toBe('__hpux_test -f file; __hpux_bracket -d "/tmp/a b" ] && __hpux_cd /tmp');
    expect(adaptShellCommands('echo test [ cd; printf "%s" "cd test ["'))
      .toBe('echo test [ cd; printf "%s" "cd test ["');
  });

  it('recognizes control-flow command positions and separators', () => {
    const source = 'if test -f x\nthen cd x\nelif [ -f y ]; then ! test -e z | cd ..\nelse while test -d .; do cd ..; done\nfi';
    const expected = 'if __hpux_test -f x\nthen __hpux_cd x\nelif __hpux_bracket -f y ]; then ! __hpux_test -e z | __hpux_cd ..\nelse while __hpux_test -d .; do __hpux_cd ..; done\nfi';
    expect(adaptShellCommands(source)).toBe(expected);
    expect(adaptShellCommands('{ cd /; test -d .; }')).toBe('{ __hpux_cd /; __hpux_test -d .; }');
  });

  it('skips assignment prefixes and redirection filenames', () => {
    expect(adaptShellCommands('A="test cd" B=$(cd /tmp; test -f x) cd "$A" > cd; <test test -e x'))
      .toBe('A="test cd" B=$(__hpux_cd /tmp; __hpux_test -f x) __hpux_cd "$A" > cd; <test __hpux_test -e x');
    expect(adaptShellCommands('2>cd cd /; X=1 [ "$X" = 1 ]'))
      .toBe('2>cd __hpux_cd /; X=1 __hpux_bracket "$X" = 1 ]');
  });

  it('adapts command substitutions without changing surrounding quoting', () => {
    expect(adaptShellCommands('echo "$(test -f x && cd /)" `cd /tmp; [ -f x ]`'))
      .toBe('echo "$(__hpux_test -f x && __hpux_cd /)" `__hpux_cd /tmp; __hpux_bracket -f x ]`');
  });

  it('decodes quoted or escaped literal compatibility command names', () => {
    expect(adaptShellCommands("'test' x; \"cd\" /; \\test -f x; c\"d\" /"))
      .toBe('__hpux_test x; __hpux_cd /; __hpux_test -f x; __hpux_cd /');
    expect(adaptShellCommands('echo "test" \\cd')).toBe('echo "test" \\cd');
  });

  it('preserves case patterns and loop items while adapting their bodies', () => {
    expect(adaptShellCommands('case x in cd|test) test -f x;; "[") cd /;; esac'))
      .toBe('case x in cd|test) __hpux_test -f x;; "[") __hpux_cd /;; esac');
    expect(adaptShellCommands('case in in cd) cd /;; esac'))
      .toBe('case in in cd) __hpux_cd /;; esac');
    expect(adaptShellCommands('for x in test cd "["; do cd "$x"; test -n "$x"; done'))
      .toBe('for x in test cd "["; do __hpux_cd "$x"; __hpux_test -n "$x"; done');
    expect(adaptShellCommands('select x in cd test; do test -n "$x"; done'))
      .toBe('select x in cd test; do __hpux_test -n "$x"; done');
  });

  it('keeps ordinary function names, adapts bodies, and rejects special definitions', () => {
    expect(adaptShellCommands('helper () { cd /; test -f x; }\nfunction other { [ -d / ]; }'))
      .toBe('helper () { __hpux_cd /; __hpux_test -f x; }\nfunction other { __hpux_bracket -d / ]; }');
    expect(() => adaptShellCommands('test() { echo custom; }')).toThrow(/definitions of compatibility command/);
    expect(() => adaptShellCommands('function cd { echo custom; }')).toThrow(/definitions of compatibility command/);
  });

  it('rejects constructs it cannot safely preserve', () => {
    expect(() => adaptShellCommands('cat <<EOF\ncd /\nEOF')).toThrow(/here-documents are unsupported/);
    expect(() => adaptShellCommands('echo "$(cd /"')).toThrow(/unterminated/);
  });
});