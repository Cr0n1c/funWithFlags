import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../src/js/services/authService.js', () => ({
  checkAuthStatus: vi.fn(),
  getCurrentUser: () => null,
  invalidateAuthentication: vi.fn(),
  isAuthenticated: () => true,
  login: vi.fn(),
  logout: vi.fn(),
  refreshCurrentUser: vi.fn(),
}));

import { submitFlag } from '../src/js/services/ctfService.js';
import { processCommand } from '../src/js/terminal/terminal.js';
import { getSandbox } from '../src/js/shell/hpux.js';

const result = {
  correct: true,
  already_solved: false,
  points_awarded: 100,
  total_score: 250,
  message: 'Flag accepted.',
};

class FakeElement {
  dataset: Record<string, string> = {};
  hidden = false;
  contentEditable = 'true';
  innerText = '';
  textContent = '';
  style: Record<string, string> = {};
  children: FakeElement[] = [];

  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }
  focus(): void {}
}

function visibleText(element: FakeElement): string {
  return element.textContent + element.children.map(visibleText).join('');
}

let handleInput: typeof import('../src/js/handlers/inputHandler.js').handleInput;

beforeAll(async () => {
  vi.stubGlobal('Audio', class {
    volume = 0;
    cloneNode() { return this; }
    play() { return Promise.resolve(); }
  });
  ({ handleInput } = await import('../src/js/handlers/inputHandler.js'));
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('submit API client', () => {
  it('posts only the unnormalized flag to the global submit endpoint', async () => {
    const flag = '  xsecurity{spaces stay here}  ';
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(result), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(submitFlag(flag)).resolves.toEqual(result);
    expect(fetchMock).toHaveBeenCalledWith('/api/challenges/submit', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ flag }),
      credentials: 'same-origin',
    }));
  });
});

describe('submit terminal command', () => {
  it('renders a normal API response without echoing the flag', async () => {
    const flag = 'xsecurity{normal-secret}';
    const sandbox = await getSandbox();
    const historyPath = `${sandbox.cwd}/.bash_history`;
    const historyBefore = await sandbox.fs.readFile(historyPath);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify(result), { status: 200 }),
    ));

    const output = await processCommand(`submit ${flag}`);

    expect(output).toContain('submit [redacted]');
    expect(output).toContain('CORRECT: Flag accepted.');
    expect(output).toContain('Total score: 250 pts');
    expect(output).not.toContain(flag);
    expect(await sandbox.fs.readFile(historyPath)).toBe(historyBefore);
  });

  it('renders an already-solved response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ...result,
      already_solved: true,
      points_awarded: 0,
      message: 'You already solved this challenge.',
    }), { status: 200 })));

    const output = await processCommand('submit xsecurity{duplicate-secret}');

    expect(output).toContain('CORRECT: You already solved this challenge.');
    expect(output).toContain('Total score: 250 pts');
    expect(output).not.toContain('duplicate-secret');
  });

  it('preserves the complete flag argument and shows usage only when absent', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(result), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    expect(await processCommand('submit')).toContain('Usage: submit <flag>');
    await processCommand('submit   xsecurity{ internal spaces }  ');
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(JSON.parse(request?.body as string)).toEqual({
      flag: '  xsecurity{ internal spaces }  ',
    });
  });

  it('redacts the flag from error output, rendered display, and recalled history', async () => {
    const flag = 'xsecurity{must-never-leak}';
    const interceptedFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: `Rejected ${flag}` }), { status: 400 }),
    );
    vi.stubGlobal('fetch', interceptedFetch);
    const output = new FakeElement();
    const input = new FakeElement();
    const wrapper = new FakeElement();
    const prefix = new FakeElement();
    prefix.textContent = 'player@hpux01:$ ';
    const elements = {
      'terminal-output': output,
      'terminal-input': input,
      'terminal-input-wrapper': wrapper,
      'input-prefix': prefix,
    };
    vi.stubGlobal('window', {
      getSelection: vi.fn().mockReturnValue(null),
    });
    vi.stubGlobal('document', {
      dispatchEvent: vi.fn(),
      getElementById: (id: keyof typeof elements) => elements[id] ?? null,
      createElement: () => new FakeElement(),
      createTextNode: (text: string) => Object.assign(new FakeElement(), { textContent: text }),
      querySelector: () => null,
    });

    input.innerText = `submit ${flag}`;
    await handleInput({
      key: 'Enter',
      target: input,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent);

    expect(visibleText(output)).toContain('submit [redacted]');
    expect(visibleText(output)).toContain('Rejected [redacted]');
    expect(visibleText(output)).not.toContain(flag);
    const activityCalls = interceptedFetch.mock.calls.filter(([url]) =>
      url === '/api/activity/command');
    expect(activityCalls).toHaveLength(1);
    expect(JSON.parse((activityCalls[0]?.[1] as RequestInit).body as string))
      .toEqual({ command: 'submit' });

    await handleInput({
      key: 'ArrowUp',
      target: input,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent);
    expect(input.innerText).toBe('submit [redacted]');
    expect(input.innerText).not.toContain(flag);
  });
});