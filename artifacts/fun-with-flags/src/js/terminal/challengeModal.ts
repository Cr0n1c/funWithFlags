import { AuthRequiredError, describeError } from '../services/api.js';
import { getChallengeById, submitChallengeFlag } from '../services/ctfService.js';
import { invalidateAuthentication, refreshCurrentUser } from '../services/authService.js';
import { getCurrentUser } from '../services/authService.js';
import { checkMail } from '../services/mailService.js';

type ChallengeDialog = HTMLDialogElement & { trigger?: HTMLElement };

let active: ChallengeDialog | null = null;
let requestVersion = 0;
let pendingMailAccount: string | null = null;

/** Only print at a usable prompt, without touching an editor, pager or live draft. */
export function flushChallengeMailNotice(): void {
  if (pendingMailAccount && pendingMailAccount !== getCurrentUser()?.account_id) {
    pendingMailAccount = null;
  }
  if (!pendingMailAccount || active?.open
    || document.getElementById('terminal-input-wrapper')?.hidden) return;
  const output = document.getElementById('terminal-output');
  if (!output) return;
  const line = document.createElement('div');
  line.textContent = '\nYou have new mail.\n\n';
  output.appendChild(line);
  pendingMailAccount = null;
}

export function isChallengeModalOpen(): boolean {
  return active !== null && active.open;
}

/** Closing also invalidates any in-flight detail request. */
export function closeChallengeModal(restoreFocus = true): void {
  requestVersion++;
  const dialog = active;
  if (!dialog) return;
  active = null;
  if (dialog.open) dialog.close();
  dialog.remove();
  flushChallengeMailNotice();
  if (restoreFocus) {
    const input = document.getElementById('terminal-input');
    if (input?.isConnected && input.getAttribute('contenteditable') !== 'false') input.focus();
    else if (dialog.trigger?.isConnected) dialog.trigger.focus();
  }
}

export async function openChallengeModal(id: number, trigger: HTMLElement): Promise<void> {
  closeChallengeModal(false);
  const version = ++requestVersion;
  const dialog = document.createElement('dialog') as ChallengeDialog;
  dialog.trigger = trigger;
  dialog.className = 'challenge-dialog';
  dialog.setAttribute('aria-labelledby', 'challenge-dialog-title');
  dialog.setAttribute('aria-describedby', 'challenge-dialog-body');
  const heading = document.createElement('h2');
  heading.id = 'challenge-dialog-title';
  heading.textContent = `CHALLENGE #${id}`;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'challenge-dialog__close';
  close.textContent = 'Close';
  close.setAttribute('aria-label', 'Close challenge details');
  close.addEventListener('click', () => closeChallengeModal());
  const body = document.createElement('div');
  body.id = 'challenge-dialog-body';
  body.setAttribute('role', 'status');
  body.textContent = 'Loading challenge details…';
  dialog.append(close, heading, body);
  document.body.appendChild(dialog);
  active = dialog;
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeChallengeModal();
  });
  // Block terminal pager, shell shortcuts and global controls while the dialog is open.
  dialog.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      closeChallengeModal();
    }
  });
  dialog.showModal();
  close.focus();

  try {
    const detail = await getChallengeById(id);
    if (active !== dialog || version !== requestVersion) return;
    heading.textContent = detail.title;
    body.replaceChildren();
    const meta = document.createElement('p');
    let solveCount = detail.solve_count;
    const renderMeta = (): void => {
      meta.textContent = `ID: ${detail.id}  •  Category: ${detail.category}  •  Points: ${detail.points}  •  Unique solve_count: ${solveCount}${detail.solved ? '  •  Solved' : ''}`;
    };
    renderMeta();
    const description = document.createElement('p');
    description.className = 'challenge-dialog__description';
    // Focus lets native PageDown/Home/End scroll the surrounding dialog.
    description.tabIndex = 0;
    description.setAttribute('role', 'region');
    description.setAttribute('aria-label', 'Challenge description');
    description.addEventListener('focus', () => {
      description.scrollIntoView({ block: 'start', inline: 'nearest' });
    });
    description.textContent = detail.description;
    body.append(meta, description);
    const form = document.createElement('form');
    form.className = 'challenge-dialog__form';
    const label = document.createElement('label');
    label.htmlFor = 'challenge-dialog-flag';
    label.textContent = 'Flag';
    const input = document.createElement('input');
    input.id = 'challenge-dialog-flag';
    input.name = 'flag';
    input.type = 'text';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.required = true;
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.textContent = 'Submit';
    const feedback = document.createElement('p');
    feedback.className = 'challenge-dialog__feedback';
    feedback.setAttribute('role', 'status');
    feedback.setAttribute('aria-live', 'polite');
    feedback.tabIndex = -1;
    feedback.addEventListener('focus', () => {
      feedback.scrollIntoView({ block: 'start', inline: 'nearest' });
    });
    input.setAttribute('aria-describedby', 'challenge-dialog-feedback');
    feedback.id = 'challenge-dialog-feedback';
    form.append(label, input, submit, feedback);
    body.append(form);
    let pending = false;
    const submitFlag = async (event: SubmitEvent): Promise<void> => {
      event.preventDefault();
      if (pending || !input.value.trim() || active !== dialog || version !== requestVersion) return;
      pending = true;
      submit.disabled = true;
      input.disabled = true;
      const flag = input.value;
      input.value = '';
      feedback.textContent = 'Checking flag…';
      feedback.tabIndex = 0;
      try {
        const accountId = getCurrentUser()?.account_id;
        const result = await submitChallengeFlag(detail.slug, flag);
        let mailWarning: string | null = null;
        if (accountId) {
          const mail = await checkMail(accountId);
          if (mail.delivered) pendingMailAccount = accountId;
          mailWarning = mail.warning;
        }
        if (active !== dialog || version !== requestVersion) return;
        if (!result.correct) {
          feedback.textContent = 'Incorrect flag. Try again.';
        } else {
          // The scoped endpoint only credits this detail's challenge.
          feedback.textContent = result.already_solved
            ? 'Already solved. No additional points awarded.'
            : `Correct! +${result.points_awarded} points. Total score: ${result.total_score} pts.`;
          detail.solved = true;
          if (!result.already_solved) solveCount++;
          renderMeta();
          try {
            await refreshCurrentUser();
          } catch (error) {
            if (active !== dialog || version !== requestVersion) return;
            if (error instanceof AuthRequiredError) {
              invalidateAuthentication('Your session has expired. Sign in again to continue.');
              return;
            }
            feedback.textContent += ' Score refresh failed; sign in again or use status to retry.';
          }
        }
        if (mailWarning) feedback.textContent += ` Mail warning: ${mailWarning}`;
      } catch (error) {
        if (active !== dialog || version !== requestVersion) return;
        if (error instanceof AuthRequiredError) {
          invalidateAuthentication('Your session has expired. Sign in again to continue.');
          return;
        }
        // API error details could echo user input. Never display or retain submitted flags.
        feedback.textContent = `Unable to submit flag: ${describeError(error).split(flag).join('[redacted]')}`;
      } finally {
        if (active === dialog && version === requestVersion) {
          pending = false;
          input.disabled = false;
          submit.disabled = false;
          input.focus();
          // Keep the retry field visible. Feedback may not fit beside it at
          // high zoom, so it is also reachable via Tab and native scrolling.
        }
      }
    };
    form.addEventListener('submit', (event) => { void submitFlag(event); });
  } catch (error) {
    if (active !== dialog || version !== requestVersion) return;
    if (error instanceof AuthRequiredError) {
      invalidateAuthentication('Your session has expired. Sign in again to view challenges.');
      return;
    }
    body.textContent = `Unable to load challenge: ${describeError(error)}`;
  }
}