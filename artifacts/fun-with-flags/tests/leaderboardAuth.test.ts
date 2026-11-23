import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  getCurrentUser,
  initializeAuth,
  logout,
  refreshCurrentUser,
  requireAuthentication,
  type CurrentUser,
} from '../src/js/services/authService.js';
import { processCommand } from '../src/js/terminal/terminal.js';
import { replaceTerminalLifecycle } from '../src/js/terminal/lifecycle.js';

class FakeElement {
  dataset: Record<string, string> = {};
  hidden = false;
  contentEditable = 'true';
  innerText = '';
  textContent = '';
  type = '';
  style: Record<string, string> = {};
  children: FakeElement[] = [];
  listeners = new Map<string, () => void>();
  focused = false;

  replaceChildren(...children: FakeElement[]): void {
    this.children = children;
  }
  append(...children: FakeElement[]): void {
    this.children.push(...children);
  }
  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }
  addEventListener(name: string, listener: () => void): void {
    this.listeners.set(name, listener);
  }
  click(): void {
    this.listeners.get('click')?.();
  }
  focus(): void {
    this.focused = true;
  }
}

const user: CurrentUser = {
  account_id: '7',
  home: '/home/jane-doe-7',
  username: 'jane',
  full_name: 'Jane Doe',
  email: 'jane@example.test',
  first_name: 'Jane',
  last_name: 'Doe',
  department_parent: 'Technology',
  department_leaf: 'Security',
  level: 'L4',
  groups: [],
  is_admin: false,
  score: 100,
  solves: 1,
};

let handleInput: typeof import('../src/js/handlers/inputHandler.js').handleInput;

function installDom() {
  const elements = {
    'terminal-output': new FakeElement(),
    'terminal-input': new FakeElement(),
    'terminal-input-wrapper': new FakeElement(),
    'input-prefix': new FakeElement(),
  };
  elements['input-prefix'].textContent = 'jane@hpux01:/home/jane$ ';
  const dispatched: Event[] = [];
  const assignLocation = vi.fn();
  const dispatchDocumentEvent = vi.fn(() => true);
  vi.stubGlobal('window', {
    location: { search: '', pathname: '/', assign: assignLocation },
    history: { replaceState: vi.fn() },
    dispatchEvent: vi.fn((event: Event) => {
      dispatched.push(event);
      return true;
    }),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    getSelection: vi.fn().mockReturnValue(null),
  });
  vi.stubGlobal('document', {
    title: 'Fun With Flags',
    getElementById: (id: keyof typeof elements) => elements[id] ?? null,
    querySelector: () => null,
    createElement: () => new FakeElement(),
    createTextNode: (text: string) => Object.assign(new FakeElement(), { textContent: text }),
    dispatchEvent: dispatchDocumentEvent,
  });
  return { elements, dispatched, assignLocation, dispatchDocumentEvent };
}

async function setSession(status: number, body: unknown): Promise<void> {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), { status }),
  ));
  await initializeAuth();
}

const playerPath = '/api/leaderboard?limit=10';
const rankPath = '/api/leaderboard/me';
const groupPath = '/api/leaderboard/groups?limit=100';
const ranking = {
  rank: 1, username: 'jane', full_name: 'Jane Doe', score: 100,
  solves: 1, failed_attempts: 0, last_solve_at: null,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

// Route by URL rather than call position: a removed/added refresh must never
// shift an auth failure or ranking payload onto the wrong endpoint.
function mockRankingRequests(routes: Record<string, Response | Promise<Response>>) {
  const fetch = vi.fn(async (url: string) => {
    if (!Object.hasOwn(routes, url)) throw new Error(`Unexpected request: ${url}`);
    return routes[url]!;
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

function expectRankingRequests(fetch: ReturnType<typeof mockRankingRequests>, paths: string[]) {
  expect(fetch.mock.calls.map(([url]) => url)).toEqual(paths);
  for (const call of fetch.mock.calls) {
    expect(call).toEqual([expect.any(String), expect.objectContaining({
      credentials: 'same-origin',
      redirect: 'manual',
    })]);
  }
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Response>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const delayedRankingCases = [
  { heldPath: playerPath, command: 'scoreboard users' },
  { heldPath: rankPath, command: 'top' },
  { heldPath: groupPath, command: 'leaderboard groups' },
].flatMap(test => ['logout', 'switch', 'sign back in'].flatMap(transition =>
  [200, 401, 503].map(status => ({ ...test, transition, status })),
));

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
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('authenticated leaderboard gate', () => {
  it.each(delayedRankingCases)(
    'discards late $status from $heldPath after $transition',
    async ({ heldPath, command, transition, status }) => {
      const { elements, assignLocation } = installDom();
      await setSession(200, user);
      const delayed = deferredResponse();
      // Freeze the old account's data before changing identity.
      const oldBody = heldPath === groupPath
        ? [{ rank: 1, group_name: 'Old synthetic group', score: 100, solves: 1, last_solve_at: null }]
        : heldPath === playerPath ? [ranking] : { entry: ranking, total_players: 1 };
      const oldResponse = jsonResponse(status === 200 ? oldBody : { detail: 'old session failure' }, status);
      const nextUser = transition === 'switch'
        ? { ...user, account_id: 'synthetic-next-account', username: 'next', full_name: 'Next Player' }
        : user;
      const otherResponse = jsonResponse(heldPath === playerPath
        ? { entry: ranking, total_players: 1 } : [ranking]);
      const paths = heldPath === groupPath ? [groupPath] : [playerPath, rankPath];
      const fetch = mockRankingRequests({
        [playerPath]: otherResponse,
        [rankPath]: otherResponse,
        [heldPath]: delayed.promise,
        '/api/auth/logout': new Response(null, { status: 204 }),
        '/api/auth/me': jsonResponse(nextUser),
        '/api/activity/command': new Response(null, { status: 204 }),
      });
      const input = elements['terminal-input'];
      input.innerText = command;
      const pending = handleInput({
        key: 'Enter', target: input, preventDefault: vi.fn(),
      } as unknown as KeyboardEvent);
      const settled = vi.fn();
      void pending.then(settled, settled);
      try {
        await vi.waitFor(() => expectRankingRequests(fetch, paths));
        if (heldPath !== groupPath) {
          await vi.waitFor(() => expect(otherResponse.bodyUsed).toBe(true));
        }
        expect(settled).not.toHaveBeenCalled();
        if (transition !== 'switch') {
          expect(await logout()).toBe('Successfully logged out');
          expect(getCurrentUser()).toBeNull();
          paths.push('/api/auth/logout');
        }
        if (transition !== 'logout') {
          if (transition === 'switch') await refreshCurrentUser();
          else await initializeAuth();
          paths.push('/api/auth/me');
          expect(getCurrentUser()).toEqual(nextUser);
          // Model the real bootShell/resumeTerminal presentation boundary:
          // a retired handler must not be responsible for enabling the new input.
          replaceTerminalLifecycle();
          elements['terminal-input-wrapper'].hidden = false;
          input.contentEditable = 'true';
          const marker = new FakeElement();
          marker.textContent = `Current identity: ${nextUser.account_id}`;
          elements['terminal-output'].replaceChildren(marker);
          elements['input-prefix'].textContent = 'next-session$ ';
        }
        const retainedChildren = [...elements['terminal-output'].children];
        const retainedPrompt = elements['input-prefix'].textContent;
        delayed.resolve(oldResponse);
        await pending;

        expect(getCurrentUser()).toEqual(transition === 'logout' ? null : nextUser);
        expect(elements['terminal-output'].children).toEqual(retainedChildren);
        retainedChildren.forEach((child, index) => {
          expect(elements['terminal-output'].children[index]).toBe(child);
        });
        expect(elements['input-prefix'].textContent).toBe(retainedPrompt);
        expect(elements['terminal-input-wrapper'].hidden).toBe(transition === 'logout');
        expect(input.contentEditable).toBe(transition === 'logout' ? 'false' : 'true');
        expect(input.dataset.commandBusy).toBe('false');
        if (transition === 'logout') {
          expect(retainedChildren.map(child => child.textContent)).toEqual([
            'You have signed out.', 'Sign in with Okta',
          ]);
          expect(retainedChildren[1]?.type).toBe('button');
        }
        expectRankingRequests(fetch, paths);
        expect(assignLocation).not.toHaveBeenCalled();
      } finally {
        delayed.resolve(oldResponse);
        await pending;
      }
    },
  );

  it.each([
    { command: 'scoreboard', heldPath: playerPath, expected: '> Jane Doe' },
    { command: 'top users', heldPath: rankPath, expected: 'You are ranked #1' },
    { command: 'scoreboard groups', heldPath: groupPath, expected: 'Current synthetic group' },
  ] as const)('keeps $command active across a same-account profile refresh', async ({ command, heldPath, expected }) => {
    installDom();
    await setSession(200, user);
    const delayed = deferredResponse();
    const bodies = {
      [playerPath]: [ranking],
      [rankPath]: { entry: ranking, total_players: 1 },
      [groupPath]: [{ rank: 1, group_name: 'Current synthetic group', score: 100, solves: 1, last_solve_at: null }],
    };
    const updatedUser = { ...user, score: 200 };
    const fetch = mockRankingRequests({
      [playerPath]: jsonResponse(bodies[playerPath]),
      [rankPath]: jsonResponse(bodies[rankPath]),
      [groupPath]: jsonResponse(bodies[groupPath]),
      [heldPath]: delayed.promise,
      '/api/auth/me': jsonResponse(updatedUser),
    });
    const pending = processCommand(command);
    try {
      const paths = heldPath === groupPath ? [groupPath] : [playerPath, rankPath];
      await vi.waitFor(() => expectRankingRequests(fetch, paths));
      await refreshCurrentUser();
      delayed.resolve(jsonResponse(bodies[heldPath]));
      const output = await pending;
      expect(output).toContain(expected);
      expect(output).not.toContain('WARNING:');
      expect(getCurrentUser()).toEqual(updatedUser);
      expectRankingRequests(fetch, [...paths, '/api/auth/me']);
    } finally {
      delayed.resolve(jsonResponse(bodies[heldPath]));
      await pending;
    }
  });

  for (const alias of ['leaderboard', 'scoreboard', 'top']) {
    it(`${alias} opens the interactive gate for an anonymous player`, async () => {
      const { elements } = installDom();
      await setSession(401, {});
      const fetch = vi.mocked(globalThis.fetch);

      expect(await processCommand(alias)).toBe('');
      expect(fetch).toHaveBeenCalledOnce();
      expect(elements['terminal-input-wrapper'].hidden).toBe(true);
      expect(elements['terminal-input'].contentEditable).toBe('false');
      expect(elements['terminal-output'].children[1]?.type).toBe('button');
      expect(elements['terminal-output'].children[1]?.textContent).toBe('Sign in with Okta');
    });
  }

  it.each(['leaderboard', 'scoreboard', 'top'].flatMap((alias) =>
    [[401, 200], [200, 401], [401, 401]].map(([board, mine]) => ({
      alias, board: board!, mine: mine!,
    })),
  ))('$alias invalidates stale auth (players=$board, mine=$mine)', async ({ alias, board, mine }) => {
    const { elements } = installDom();
    await setSession(200, user);
    const fetch = mockRankingRequests({
      [playerPath]: jsonResponse(board === 200 ? [ranking] : {}, board),
      [rankPath]: jsonResponse(mine === 200 ? { entry: ranking, total_players: 1 } : {}, mine),
    });

    expect(await processCommand(alias)).toBe('');
    expect(getCurrentUser()).toBeNull();
    expectRankingRequests(fetch, [playerPath, rankPath]);
    expect(elements['terminal-input-wrapper'].hidden).toBe(true);
    expect(elements['terminal-input'].contentEditable).toBe('false');
    expect(elements['terminal-output'].children).toHaveLength(2);
    expect(elements['terminal-output'].children[1]?.type).toBe('button');
    expect(elements['terminal-output'].children[1]?.textContent).toBe('Sign in with Okta');
  });

  it.each(['leaderboard', 'scoreboard', 'top'].flatMap((alias) =>
    [playerPath, rankPath].flatMap((authPath) =>
      ['503', 'rejected fetch'].flatMap((failure) =>
        ['non-auth first', '401 first'].map((order) => ({ alias, authPath, failure, order })),
      ),
    ),
  ))('$alias prioritizes 401 from $authPath over $failure ($order)', async ({
    alias, authPath, failure, order,
  }) => {
    const { elements } = installDom();
    await setSession(200, user);
    const auth = deferredResponse();
    const other = deferredResponse();
    const otherPath = authPath === playerPath ? rankPath : playerPath;
    const fetch = mockRankingRequests({
      [authPath]: auth.promise,
      [otherPath]: other.promise,
    });
    let output: string | undefined;
    const command = processCommand(alias).then((result) => { output = result; return result; });
    const expire = () => auth.resolve(jsonResponse({}, 401));
    const fail = () => {
      if (failure === '503') other.resolve(jsonResponse({ detail: 'temporarily unavailable' }, 503));
      else other.reject(new TypeError('Synthetic network failure'));
    };
    try {
      await vi.waitFor(() => expectRankingRequests(fetch, [playerPath, rankPath]));
      if (order === 'non-auth first') fail();
      else expire();
      // Drain the response parsing and command microtasks while the peer is held.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(output ?? '').not.toContain('WARNING:');
      expect(output ?? '').not.toContain('PLAYER');
      expect(output ?? '').not.toContain('You are ranked');
      if (order === 'non-auth first') {
        expect(output).toBeUndefined();
        expect(getCurrentUser()).toEqual(user);
      } else {
        // The peer remains held: a 401 cannot wait for it to finish.
        await vi.waitFor(() => expect(output).toBe(''));
        expect(getCurrentUser()).toBeNull();
        expect(elements['terminal-output'].children[1]?.textContent).toBe('Sign in with Okta');
      }

      if (order === 'non-auth first') expire();
      else fail();
      expect(await command).toBe('');
      expect(getCurrentUser()).toBeNull();
      expect(elements['terminal-input-wrapper'].hidden).toBe(true);
      expect(elements['terminal-input'].contentEditable).toBe('false');
      const children = elements['terminal-output'].children;
      expect(children).toHaveLength(2);
      expect(children[0]?.textContent).toContain(
        'Your session has expired. Sign in again to view the scoreboard.',
      );
      expect(children[1]?.type).toBe('button');
      expect(children[1]?.textContent).toBe('Sign in with Okta');
      expectRankingRequests(fetch, [playerPath, rankPath]);
    } finally {
      // Even a failed intermediate assertion must not leave a request pending.
      expire();
      fail();
      await command;
    }
  });

  it.each(['leaderboard', 'scoreboard', 'top'])('%s renders successful rankings', async (alias) => {
    installDom();
    await setSession(200, user);
    const entry = {
      rank: 1, username: 'jane', full_name: 'Jane Doe', score: 100, solves: 1, failed_attempts: 3, last_solve_at: null,
    };
    const fetch = mockRankingRequests({
      [playerPath]: jsonResponse([entry]),
      [rankPath]: jsonResponse({ entry, total_players: 1 }),
    });

    const output = await processCommand(alias);
    expectRankingRequests(fetch, [playerPath, rankPath]);
    expect(output).not.toContain('WARNING:');
    expect(output).toContain(`${alias}\n`);
    expect(output).toContain('1st');
    expect(output).toContain('> Jane Doe');
    expect(output).not.toContain('USERNAME');
    expect(output).not.toContain('jane');
    expect(output).toContain('SCORE');
    expect(output).toContain('SOLVES');
    expect(output).toContain('Failed Attempts');
    expect(output).toMatch(/\|\s*1st\s*\|\s*> Jane Doe\s*\|\s*100\s*\|\s*1\s*\|\s*3\s*\|/);
    expect(output).toContain('You are ranked #1');
  });

  it.each(['scoreboard', 'scoreboard users'])('%s requests the player scoreboard', async (command) => {
    installDom();
    await setSession(200, user);
    const entry = {
      rank: 1, username: 'jane', full_name: 'Jane Doe', score: 100, solves: 1, failed_attempts: 0, last_solve_at: null,
    };
    const fetch = mockRankingRequests({
      [playerPath]: jsonResponse([entry]),
      [rankPath]: jsonResponse({ entry, total_players: 1 }),
    });

    const output = await processCommand(command);
    expect(output).toContain('PLAYER');
    expect(output).toContain('Failed Attempts');
    expect(output).toMatch(/\|\s*1st\s*\|\s*> Jane Doe\s*\|\s*100\s*\|\s*1\s*\|\s*0\s*\|/);
    expectRankingRequests(fetch, [playerPath, rankPath]);
  });

  it('scoreboard groups requests and renders only the group scoreboard', async () => {
    installDom();
    await setSession(200, user);
    const fetch = mockRankingRequests({
      [groupPath]: jsonResponse([{
        rank: 1,
        group_name: 'Security Engineering\x1b[31m — International',
        score: 250,
        solves: 3,
        last_solve_at: null,
      }]),
    });

    const output = await processCommand('scoreboard groups');
    expect(output).toContain('RANK');
    expect(output).toContain('GROUP');
    expect(output).toContain('Security Engineering [31m — International');
    expect(output).toContain('250');
    expect(output).toContain('3');
    expect(output).not.toContain('\x1b');
    expect(output).not.toContain('WARNING:');
    expectRankingRequests(fetch, [groupPath]);
  });

  it('scoreboard groups has a clear empty state', async () => {
    installDom();
    await setSession(200, user);
    const fetch = mockRankingRequests({ [groupPath]: jsonResponse([]) });

    expect(await processCommand('scoreboard groups')).toContain(
      'No groups have scored yet. Be the first!',
    );
    expectRankingRequests(fetch, [groupPath]);
  });

  it.each(['players', 'mine'])(
    'reads saved rankings concurrently without a refresh request (%s finishes first)',
    async (first) => {
      installDom();
      await setSession(200, user);
      const players = deferredResponse();
      const mine = deferredResponse();
      const fetch = mockRankingRequests({
        [playerPath]: players.promise,
        [rankPath]: mine.promise,
      });
      const command = processCommand('scoreboard');
      const settled = vi.fn();
      void command.then(settled);
      const playerResponse = jsonResponse([ranking]);
      const rankResponse = jsonResponse({ entry: ranking, total_players: 1 });
      const firstResponse = first === 'players' ? playerResponse : rankResponse;
      const parsed = vi.spyOn(firstResponse, 'json');
      try {
        await vi.waitFor(() => expectRankingRequests(fetch, [playerPath, rankPath]));
        (first === 'players' ? players : mine).resolve(firstResponse);
        // Observe body parsing, not just delivery, while the other read is held.
        await vi.waitFor(() => expect(firstResponse.bodyUsed).toBe(true));
        await parsed.mock.results[0]!.value;
        expect(settled).not.toHaveBeenCalled();
      } finally {
        players.resolve(playerResponse);
        mine.resolve(rankResponse);
        await command;
      }
      const output = await command;
      expectRankingRequests(fetch, [playerPath, rankPath]);
      expect(output).toContain('> Jane Doe');
      expect(output).toContain('You are ranked #1');
      expect(output).not.toContain('WARNING:');
    },
  );

  it.each(['scoreboard teams', 'scoreboard users extra', 'scoreboard groups extra'])(
    '%s rejects invalid arguments without a ranking request',
    async (command) => {
      installDom();
      await setSession(200, user);
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);

      expect(await processCommand(command)).toContain('Usage: scoreboard [users|groups]');
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('scoreboard groups invalidates stale authentication on 401', async () => {
    const { elements } = installDom();
    await setSession(200, user);
    const fetch = mockRankingRequests({ [groupPath]: jsonResponse({}, 401) });

    expect(await processCommand('scoreboard groups')).toBe('');
    expectRankingRequests(fetch, [groupPath]);
    expect(getCurrentUser()).toBeNull();
    expect(elements['terminal-input-wrapper'].hidden).toBe(true);
    expect(elements['terminal-input'].contentEditable).toBe('false');
    expect(elements['terminal-output'].children[1]?.type).toBe('button');
    expect(elements['terminal-output'].children[1]?.textContent).toBe('Sign in with Okta');
  });

  it.each([playerPath, rankPath])('warns without rendering partial scores when %s fails', async (failedPath) => {
    installDom();
    await setSession(200, user);
    const fetch = mockRankingRequests({
      [playerPath]: jsonResponse([ranking]),
      [rankPath]: jsonResponse({ entry: ranking, total_players: 1 }),
      [failedPath]: jsonResponse({ detail: 'still in progress' }, 503),
    });
    const output = await processCommand('scoreboard');
    expect(output).toContain('WARNING: Scores may be stale; previous scores remain unchanged.');
    expect(output).toContain('still in progress');
    expect(output).not.toContain('> Jane Doe');
    expect(output).not.toContain('You are ranked');
    expect(output).not.toContain('PLAYER');
    expect(getCurrentUser()).toEqual(user);
    expectRankingRequests(fetch, [playerPath, rankPath]);
  });

  it('warns without clearing prior terminal output when the group read fails', async () => {
    const { elements } = installDom();
    await setSession(200, user);
    const priorOutput = new FakeElement();
    priorOutput.textContent = 'Security | 250 | 3';
    elements['terminal-output'].appendChild(priorOutput);
    const fetch = mockRankingRequests({
      [groupPath]: jsonResponse({ detail: 'pending' }, 503),
    });
    const output = await processCommand('scoreboard groups');
    expect(output).toContain('WARNING: Scores may be stale; previous scores remain unchanged.');
    expect(output).toContain('pending');
    expect(output).not.toContain('GROUP');
    expect(output).not.toContain('No groups have scored');
    expect(elements['terminal-output'].children).toContain(priorOutput);
    expect(priorOutput.textContent).toBe('Security | 250 | 3');
    expect(getCurrentUser()).toEqual(user);
    expectRankingRequests(fetch, [groupPath]);
  });

  it('preserves the auth prompt when an actual Enter key renders an anonymous alias', async () => {
    const { elements, dispatchDocumentEvent } = installDom();
    await setSession(401, {});
    const input = elements['terminal-input'];
    input.innerText = 'scoreboard';

    await handleInput({
      key: 'Enter',
      target: input,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent);

    expect(elements['terminal-output'].children).toHaveLength(2);
    expect(elements['terminal-output'].children[1]?.textContent).toBe('Sign in with Okta');
    expect(elements['terminal-input-wrapper'].hidden).toBe(true);
    expect(input.contentEditable).toBe('false');
    expect(input.dataset.commandBusy).toBe('false');
    expect(dispatchDocumentEvent).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ type: 'terminal:command-submitted' }),
    );
  });

  it('starts same-window sign-in only when the explicit button is selected', async () => {
    const { elements, assignLocation } = installDom();
    await setSession(401, {});
    requireAuthentication('Session expired.');

    expect(assignLocation).not.toHaveBeenCalled();
    elements['terminal-output'].children[1]?.click();

    expect(assignLocation).toHaveBeenCalledExactlyOnceWith('/api/auth/login');
    expect(fetch).toHaveBeenCalledOnce();
  });
});

describe('status freshness', () => {
  it('refreshes the profile before rendering status', async () => {
    installDom();
    await setSession(200, { ...user, score: 0, solves: 0 });
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ...user, score: 15, solves: 2,
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);

    const output = await processCommand('status');

    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith('/api/auth/me', expect.objectContaining({
      credentials: 'same-origin',
    }));
    expect(output).toContain('15 pts (2 solved)');
    expect(output).not.toContain('0 pts (0 solved)');
    expect(getCurrentUser()?.score).toBe(15);
  });

  it('invalidates stale authentication when the status refresh expires', async () => {
    const { elements } = installDom();
    await setSession(200, user);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 401 })));

    expect(await processCommand('status')).toBe('');
    expect(getCurrentUser()).toBeNull();
    expect(elements['terminal-output'].children[1]?.textContent).toBe('Sign in with Okta');
  });
});