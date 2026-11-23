import { apiFetch } from './api.js';

export interface UserPointsResult {
  user_id: number;
  display_name: string;
  challenge: string;
  title: string;
  points: number;
  points_awarded: number;
  already_awarded: boolean;
  preview: boolean;
}

export function importUserPoints(
  user: string, challenge: string, preview: boolean,
): Promise<UserPointsResult> {
  return apiFetch<UserPointsResult>('/admin/user-points/import', {
    method: 'POST', body: JSON.stringify({ user, challenge, preview }),
  });
}

export interface UserStats {
  people_logged_in: number;
  people_with_points: number;
  average_daily_logins: number;
  window_days: number;
  window_start: string;
  window_end: string;
  timezone: string;
}

export function getUserStats(): Promise<UserStats> {
  return apiFetch<UserStats>('/admin/user-stats');
}
