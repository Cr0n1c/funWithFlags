import { apiFetch } from './api.js';

// Deliberately public puzzle material, never an application credential.
const segments = ['62756e646c65', '6374662d6f6e6c79', '3933616336303866', '3765313962343264'] as const;
const revision = ([1, 3, 2, 0] as const).map(i =>
  segments[i].replace(/../g, octet => String.fromCharCode(parseInt(octet, 16))),
).join('.');

export async function invokeLegacyConsole(args: string[]): Promise<string> {
  if (args.length === 0) {
    return JSON.stringify(await apiFetch('/cli/commands'), null, 2);
  }
  if (args.length !== 1) return 'Expected one token argument.';
  // Puzzle-only check retains the encoded value without leaking it in discovery
  // traffic. The server independently validates it; this is not authorization.
  if (args[0] !== revision) throw new Error('Invalid challenge token');
  const result = await apiFetch<{ flag: string; message: string }>('/cli/promote_user_to_admin', {
    method: 'POST', body: JSON.stringify({ token: args[0] }),
  });
  return `${result.message}\n${result.flag}\nUse submit <flag> to claim your points.`;
}
