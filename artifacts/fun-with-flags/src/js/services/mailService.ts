import { apiFetch } from './api.js';
import { getCurrentUser } from './authService.js';

interface GoldEvent {
  id: number;
  outcome: 'correct' | 'incorrect' | 'already_solved';
  points: number;
  time: string;
  challenge_id: number | null;
}
interface EventPage {
  gold_cursor: number;
  gold_more: boolean;
  gold: GoldEvent[];
}
interface Cursor { gold: number }

const key = (accountId: string): string => `fwf-mail-cursor-v1-account-${accountId}`;
/** Retain a committed attempt if initial mailbox bootstrap previously failed. */
export function primeGoldMail(accountId: string, eventId: number): void {
  if (getCurrentUser()?.account_id !== accountId || !Number.isSafeInteger(eventId)
    || eventId < 1 || readCursor(accountId)) return;
  writeCursor(accountId, { gold: eventId - 1 });
}
function readCursor(accountId: string): Cursor | null {
  const value = localStorage.getItem(key(accountId));
  if (!value) return null;
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object') throw new Error('Invalid mail delivery cursor');
  // Cursors saved by earlier releases carry extra fields; only `gold` is kept.
  const { gold } = parsed as Cursor;
  if (!Number.isSafeInteger(gold) || gold < 0) {
    throw new Error('Invalid mail delivery cursor');
  }
  return { gold };
}
function writeCursor(accountId: string, cursor: Cursor): void {
  localStorage.setItem(key(accountId), JSON.stringify(cursor));
}
function safeLine(value: string): string {
  // eslint-disable-next-line no-control-regex -- stripping control characters is the purpose
  return value.replace(/[\r\n\x00-\x1f\x7f]/g, ' ').slice(0, 100);
}
function formatGold(event: GoldEvent): string {
  const outcome = event.outcome === 'correct' ? 'Correct'
    : event.outcome === 'already_solved' ? 'Already solved' : 'Incorrect';
  return `From: CTF scoring\nSubject: Flag submission ${outcome}\nDate: ${safeLine(event.time)}\n\n`
    + `Outcome: ${outcome}\nPoints awarded: ${event.points}\n`
    + `Challenge ID: ${event.challenge_id ?? 'unresolved'}\n\n`;
}

let queue: Promise<unknown> = Promise.resolve();
const warned = new Set<string>();
/** A request-owned check; no polling, score inference or submitted flag content. */
export function checkMail(
  accountId: string,
): Promise<{ delivered: number; warning: string | null }> {
  const run = async (): Promise<{ delivered: number; warning: string | null }> => {
    if (getCurrentUser()?.account_id !== accountId) return { delivered: 0, warning: null };
    let delivered = 0;
    const perform = async (): Promise<{ delivered: number; warning: string | null }> => {
      const { deliverShellMail } = await import('../shell/hpux.js');
      let cursor = readCursor(accountId);
      if (!cursor) {
        const baseline = await apiFetch<EventPage>('/challenges/notifications?initialize=true');
        if (getCurrentUser()?.account_id !== accountId) return { delivered: 0, warning: null };
        cursor = { gold: baseline.gold_cursor };
        writeCursor(accountId, cursor);
        return { delivered: 0, warning: null };
      }
      for (let pageNumber = 0; pageNumber < 1000; pageNumber++) {
        const page = await apiFetch<EventPage>(
          `/challenges/notifications?gold_after=${cursor.gold}`,
        );
        if (getCurrentUser()?.account_id !== accountId) return { delivered, warning: null };
        for (const event of page.gold) {
          if (event.id <= cursor.gold) continue;
          if (!await deliverShellMail(accountId, formatGold(event))) {
            return { delivered, warning: null };
          }
          cursor.gold = event.id;
          writeCursor(accountId, cursor);
          delivered++;
        }
        cursor.gold = Math.max(cursor.gold, page.gold_cursor);
        writeCursor(accountId, cursor);
        if (!page.gold_more) return { delivered, warning: null };
      }
      throw new Error('Mail retrieval exceeded the page limit; retry later');
    };
    try {
      // Serialize shared cursor updates between browser tabs. Within one tab the
      // promise queue also protects filesystem appends from simultaneous requests.
      if (typeof navigator !== 'undefined' && navigator.locks) {
        return await navigator.locks.request(key(accountId), perform);
      }
      return await perform();
    } catch {
      return { delivered, warning: 'Mail retrieval unavailable; scoring result is unchanged. Retry mail check later.' };
    }
  };
  const next = queue.then(run, run).then((result) => {
    if (!result.warning) warned.delete(accountId);
    else if (warned.has(accountId)) return { ...result, warning: null };
    else warned.add(accountId);
    return result;
  });
  queue = next;
  return next;
}