import { afterEach, describe, expect, it, vi } from 'vitest';
import { activityCommandName, recordCommandActivity } from '../src/js/services/activityService.js';

afterEach(() => vi.unstubAllGlobals());

describe('command activity metadata', () => {
  it('reports only allowlisted command names, never arguments or source', () => {
    expect(activityCommandName('scoreboard groups')).toBe('scoreboard');
    expect(activityCommandName('submit FLAG{private}')).toBe('submit');
    expect(activityCommandName('echo private | curl https://example.com')).toBe('shell command');
    expect(activityCommandName('/tmp/private-executable --token private')).toBe('shell command');
    expect(activityCommandName('secret_alias password=private')).toBe('shell command');
    expect(activityCommandName('echo $(private)')).toBe('shell command');
    expect(activityCommandName(' \n ')).toBeNull();
  });

  it('POSTs only a command name and tolerates a failed telemetry request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    await recordCommandActivity('scoreboard groups --private-flag');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/activity/command');
    expect(options.method).toBe('POST');
    expect(options.credentials).toBe('same-origin');
    expect(JSON.parse(options.body as string)).toEqual({ command: 'scoreboard' });
    expect(options.body).not.toContain('private-flag');
    await recordCommandActivity('curl http://169.254.169.254/latest/meta-data/iam/security-credentials/');
    const curlBody = JSON.parse((fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string);
    expect(curlBody).toEqual({ command: 'shell command' });
    fetchMock.mockRejectedValue(new Error('offline'));
    await expect(recordCommandActivity('submit FLAG{private}')).resolves.toBeUndefined();
    expect(JSON.parse((fetchMock.mock.calls[2] as [string, RequestInit])[1].body as string))
      .toEqual({ command: 'submit' });
  });
});