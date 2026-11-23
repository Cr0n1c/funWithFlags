import { apiFetch } from './api.js';
import { getCurrentUser } from './authService.js';
import { primeGoldMail } from './mailService.js';

export interface Challenge {
  id: number;
  slug: string;
  title: string;
  category: string;
  description: string;
  points: number;
  solved: boolean;
  solve_count: number;
}

export interface SubmitResult {
  correct: boolean;
  already_solved: boolean;
  points_awarded: number;
  total_score: number;
  message: string;
  event_id: number;
}

export interface LeaderboardEntry {
  /** null when the player has no solves yet. */
  rank: number | null;
  username: string;
  full_name: string | null;
  score: number;
  solves: number;
  failed_attempts: number;
  last_solve_at: string | null;
}

export interface GroupLeaderboardEntry {
  rank: number;
  group_name: string;
  score: number;
  solves: number;
  last_solve_at: string | null;
}

export function listChallenges(): Promise<Challenge[]> {
  return apiFetch<Challenge[]>('/challenges');
}

const MATRIX_STATUS_TIMEOUT_MS = 10_000;

/** Private, bounded solve lookup without catalog work or transport retries. */
export async function getMatrixCompletion(signal?: AbortSignal): Promise<{ solved: boolean }> {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const cancel = () => controller.abort(signal?.reason);
  let rejectAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => {
      const reason: unknown = controller.signal.reason;
      reject(reason instanceof Error
        ? reason : new DOMException('Matrix completion request aborted', 'AbortError'));
    };
    controller.signal.addEventListener('abort', rejectAbort, { once: true });
  });
  signal?.addEventListener('abort', cancel, { once: true });
  const timeout = setTimeout(() => {
    controller.abort(new DOMException('Matrix completion request timed out', 'TimeoutError'));
  }, MATRIX_STATUS_TIMEOUT_MS);
  try {
    // Race the entire response (including JSON) so even a transport that ignores
    // abort cannot retain the caller's in-flight state indefinitely.
    const result = await Promise.race([
      apiFetch<{ solved: boolean }>('/challenges/matrix/status', {
        cache: 'no-store',
        signal: controller.signal,
      }),
      aborted,
    ]);
    if (!result || typeof result.solved !== 'boolean') {
      throw new Error('Matrix completion returned an invalid response');
    }
    return result;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', rejectAbort);
  }
}

export async function listGoldChallenges(): Promise<Challenge[]> {
  const challenges = await listChallenges();
  return challenges.filter((challenge) => ['gold', 'owasp', 'cracking', 'talks', 'intro'].includes(challenge.category.toLowerCase()));
}

export async function listCrackingChallenges(): Promise<Challenge[]> {
  const challenges = await listChallenges();
  return challenges.filter((challenge) => challenge.category.toLowerCase() === 'cracking');
}

export function getChallenge(slug: string): Promise<Challenge> {
  return apiFetch<Challenge>(`/challenges/${encodeURIComponent(slug)}`);
}

export function getChallengeById(id: number): Promise<Challenge> {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid challenge ID');
  return apiFetch<Challenge>(`/challenges/id/${id}`);
}

async function submitWithMail(path: string, flag: string): Promise<SubmitResult> {
  const accountId = getCurrentUser()?.account_id;
  const result = await apiFetch<SubmitResult>(path, {
    method: 'POST',
    body: JSON.stringify({ flag }),
  });
  if (accountId) {
    if (result.correct && typeof document !== 'undefined' && getCurrentUser()?.account_id === accountId) {
      document.dispatchEvent(new Event('ctf:solve-confirmed'));
    }
    try {
      primeGoldMail(accountId, result.event_id);
    } catch {
      // A browser storage error cannot turn a committed award into a failed submission.
      // The request-owned mail check reports delivery failure separately.
    }
  }
  return result;
}

export function submitFlag(flag: string): Promise<SubmitResult> {
  return submitWithMail('/challenges/submit', flag);
}

/** A detail dialog must never award a flag belonging to another challenge. */
export function submitChallengeFlag(slug: string, flag: string): Promise<SubmitResult> {
  return submitWithMail(`/challenges/${encodeURIComponent(slug)}/submit`, flag);
}

export interface MyRank {
  entry: LeaderboardEntry;
  total_players: number;
}

export function getLeaderboard(limit = 10): Promise<LeaderboardEntry[]> {
  return apiFetch<LeaderboardEntry[]>(`/leaderboard?limit=${limit}`);
}

export function getGroupLeaderboard(limit = 100): Promise<GroupLeaderboardEntry[]> {
  return apiFetch<GroupLeaderboardEntry[]>(`/leaderboard/groups?limit=${limit}`);
}

export function getMyRank(): Promise<MyRank> {
  return apiFetch<MyRank>('/leaderboard/me');
}

export function curlPublicUrl(url: string): Promise<{ output: string }> {
  return apiFetch('/cli/curl', { method: 'POST', body: JSON.stringify({ url }) });
}
