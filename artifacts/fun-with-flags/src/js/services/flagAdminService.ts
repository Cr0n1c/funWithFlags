import { apiFetch, ApiError, AuthRequiredError } from './api.js';

export interface CreatedFlag {
  slug: string;
  title: string;
  description: string;
  points: number;
  hidden: boolean;
  category: 'gold';
}

export interface DeletePreview {
  slug: string;
  title: string;
  points: number;
  confirmation_token: string;
}

export interface DeletedFlag {
  deleted: true;
  title: string;
  points: number;
}

export function checkFlagAdminAccess(): Promise<{ allowed: true }> {
  return apiFetch<{ allowed: true }>('/flag-admin/access');
}

export interface FlagBackupPreview {
  missing: number;
  identical: number;
  conflicts: number;
}

export function previewFlagBackup(data: string): Promise<FlagBackupPreview> {
  return apiFetch<FlagBackupPreview>('/flag-admin/import-flags/preview', {
    method: 'POST', body: data,
  });
}

export function importFlagBackup(data: string): Promise<{ created: number; identical: number }> {
  return apiFetch<{ created: number; identical: number }>('/flag-admin/import-flags', {
    method: 'POST', body: data,
  });
}

export async function downloadFlagBackup(stillAuthorized: () => boolean): Promise<number> {
  const response = await fetch('/api/flag-admin/export-flags', {
    credentials: 'same-origin', headers: { Accept: 'application/json' },
  });
  if (response.status === 401) throw new AuthRequiredError();
  if (!response.ok) throw new ApiError(response.status,
    response.status === 403 ? 'Permission denied' : 'Unable to export flags');
  const count = Number(response.headers.get('X-Flag-Count'));
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid export response');
  const blob = await response.blob();
  if (!stillAuthorized()) throw new AuthRequiredError();
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = 'fun-with-flags-flags-v1.json';
    link.style.display = 'none';
    document.body.appendChild(link);
    try { link.click(); } finally { link.remove(); }
  } finally {
    // Delay revocation until the browser has consumed the navigation.
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
  return count;
}

export interface HashPuzzleStatus {
  slug: string;
  title: string;
  points: number;
  missing?: boolean;
}

export function getChallengeImportStatus(): Promise<{
  puzzles: HashPuzzleStatus[]; terminal: HashPuzzleStatus[];
}> {
  return apiFetch<{ puzzles: HashPuzzleStatus[]; terminal: HashPuzzleStatus[] }>('/flag-admin/import-challenges');
}

export function importChallenges(
  words: Partial<Record<'easy' | 'medium' | 'hard' | 'extra-hard', string>>,
  terminalMissing: string[],
): Promise<{ created: number; unchanged: number }> {
  return apiFetch<{ created: number; unchanged: number }>('/flag-admin/import-challenges', {
    method: 'POST',
    body: JSON.stringify({ ...words, terminal_missing: terminalMissing }),
  });
}

export function createFlag(body: {
  title: string;
  description: string;
  flag: string;
  points: number;
  hidden: boolean;
}): Promise<CreatedFlag> {
  return apiFetch<CreatedFlag>('/flag-admin/flags', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function previewFlagDeletion(flag: string): Promise<DeletePreview> {
  return apiFetch<DeletePreview>('/flag-admin/delete-preview', {
    method: 'POST',
    body: JSON.stringify({ flag }),
  });
}

export function deleteFlag(slug: string, confirmationToken: string): Promise<DeletedFlag> {
  return apiFetch<DeletedFlag>(`/flag-admin/flags/${encodeURIComponent(slug)}`, {
    method: 'DELETE',
    body: JSON.stringify({ confirmation_token: confirmationToken }),
  });
}