const STORAGE_KEY = 'fwf-auto-copy-v1';
export const AUTO_COPY_CHANGED = 'fwf-auto-copy-changed';
let enabled: boolean | undefined;
let storageUnavailable = false;

/** A browser preference only. No clipboard data is read or persisted here. */
export function isAutoCopyEnabled(): boolean {
  if (enabled === undefined) {
    enabled = true;
    try {
      enabled = window.localStorage.getItem(STORAGE_KEY) !== 'false';
    } catch {
      storageUnavailable = true;
    }
  }
  return enabled;
}

export function autoCopyStatus(): string {
  return `Auto-copy: ${isAutoCopyEnabled() ? 'ON (autocopy off to pause)' : 'OFF (autocopy on to resume)'}.`
    + (storageUnavailable ? ' Preference not saved; applies to this tab only.' : '');
}

export function autoCopyCommand(args: string[]): string {
  if (args.length > 1 || (args.length === 1 && !['on', 'off'].includes(args[0]!))) {
    return 'Usage: autocopy [on|off]\n' + autoCopyStatus();
  }
  if (args.length === 1) {
    enabled = args[0] === 'on';
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(enabled));
      storageUnavailable = false;
    } catch {
      storageUnavailable = true;
    }
    document.dispatchEvent(new Event(AUTO_COPY_CHANGED));
  }
  return autoCopyStatus();
}
