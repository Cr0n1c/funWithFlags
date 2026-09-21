import { apiFetch } from './api.js';

export interface Challenge {
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
}

export interface LeaderboardEntry {
  /** null when the player has no solves yet. */
  rank: number | null;
  username: string;
  full_name: string | null;
  score: number;
  solves: number;
  last_solve_at: string | null;
}

export function listChallenges(): Promise<Challenge[]> {
  return apiFetch<Challenge[]>('/challenges');
}

export function getChallenge(slug: string): Promise<Challenge> {
  return apiFetch<Challenge>(`/challenges/${encodeURIComponent(slug)}`);
}

export function submitFlag(slug: string, flag: string): Promise<SubmitResult> {
  return apiFetch<SubmitResult>(`/challenges/${encodeURIComponent(slug)}/submit`, {
    method: 'POST',
    body: JSON.stringify({ flag }),
  });
}

export interface MyRank {
  entry: LeaderboardEntry;
  total_players: number;
}

export function getLeaderboard(limit = 10): Promise<LeaderboardEntry[]> {
  return apiFetch<LeaderboardEntry[]>(`/leaderboard?limit=${limit}`);
}

export function getMyRank(): Promise<MyRank> {
  return apiFetch<MyRank>('/leaderboard/me');
}
