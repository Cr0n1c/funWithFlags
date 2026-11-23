import { apiFetch } from './api.js';

export async function runTraining(input: string): Promise<string> {
  const match = /^\s*(invoice|profile|file)\s+([\s\S]+)$/.exec(input);
  if (!match) return [
    'Isolated OWASP training lab — fictional data only.',
    'lab invoice 1042                GET /api/training/invoices/1042',
    'lab profile {"display_name":"learner"}   POST /api/training/profile',
    'lab file welcome.txt            GET /api/training/files?path=welcome.txt',
    'Recovered flags can be claimed with submit <flag>.',
  ].join('\n');
  const [, action, argument = ''] = match;
  let result: unknown;
  if (action === 'invoice') {
    if (!/^\d{1,9}$/.test(argument)) return 'Expected a numeric invoice ID.';
    result = await apiFetch(`/training/invoices/${argument}`);
  } else if (action === 'file') {
    result = await apiFetch(`/training/files?path=${encodeURIComponent(argument)}`);
  } else {
    let body: unknown;
    try { body = JSON.parse(argument); } catch { return 'Expected a JSON object, without outer shell quotes.'; }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Expected a JSON object.';
    result = await apiFetch('/training/profile', { method: 'POST', body: JSON.stringify(body) });
  }
  return JSON.stringify(result, null, 2);
}
