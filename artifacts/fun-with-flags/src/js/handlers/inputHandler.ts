import {
  processCommand,
  animateText,
  appendTerminalText,
  redactSensitiveCommand,
} from '../terminal/terminal.js';
import { ChallengePager } from '../terminal/pager.js';
import { flushChallengeMailNotice, isChallengeModalOpen } from '../terminal/challengeModal.js';
import { scrollToBottom } from './utils.js';
import { insertPlainPaste } from '../terminal/clipboard.js';
import { getAutocompleteSuggestions } from './commands.js';
import { getCurrentUser, isAuthenticated } from '../services/authService.js';
import { recordCommandActivity } from '../services/activityService.js';
import { hasAdventure } from '../terminal/games.js';
import {
  cancelGuidedSession,
  getGuidedSecretMask,
  guidedInputValue,
  hasGuidedSession,
  isGuidedSecretInput,
  setGuidedSecretInput,
} from '../terminal/flagAdminState.js';
import { setPrompt } from '../terminal/terminal.js';
import { captureTerminalOwnership } from '../terminal/lifecycle.js';

// Preload the sound
const keySound = new Audio('/sounds/keypress.mp3');
keySound.volume = 0.4;

const commandHistory: string[] = [];
let commandIndex = -1;
let activeCommandOwns: (() => boolean) | undefined;
let allowTypeAhead = false;

function commandBusy(): boolean {
  return activeCommandOwns?.() ?? false;
}

function isChallengeCommand(value: string): boolean {
  return /^challenges?(?:\s|$)/i.test(value.trim());
}

/**
 * Replace the input text and park the caret at the end. Setting innerText alone leaves the
 * caret at offset 0 in a contenteditable, so Backspace and typing appear to do nothing.
 */
function setInputText(inputElement: HTMLElement, text: string): void {
  inputElement.innerText = text;
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(inputElement);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

async function handleEnterKey(
  terminalOutput: HTMLElement,
  inputElement: HTMLElement,
): Promise<void> {
  if (!inputElement || commandBusy()) return;
  const ownsTerminal = captureTerminalOwnership();

  const wasGuided = hasGuidedSession();
  const wasAdventure = hasAdventure();
  const submittedPrefix = document.getElementById('input-prefix')?.textContent ?? '';
  const inputText = guidedInputValue(inputElement.innerText);
  const historyText = redactSensitiveCommand(inputText);
  // Replace a submitted secret in the live command line before waiting on the network.
  if (historyText === 'submit [redacted]' || historyText === 'delete_flag [redacted]'
    || isGuidedSecretInput()) {
    inputElement.innerText = isGuidedSecretInput() ? '[redacted]' : historyText;
  }
  activeCommandOwns = ownsTerminal;
  // Signal accepted submissions only; never include command text or arguments.
  if (inputText.trim()) document.dispatchEvent(new Event('terminal:command-submitted'));
  // Editability remains true during ordinary type-ahead; expose the actual
  // submission lifecycle separately for clients waiting on command completion.
  inputElement.dataset.commandBusy = 'true';
  // Draft the next command independently of the submitted line. Guided secret
  // prompts must never collect type-ahead before their prompt is visible.
  const adminCommand = /^(?:create_flag|delete_flag|export_flags)(?:\s|$)/i.test(inputText.trim())
    || /^(?:import_flags|import_challenges|import_user_points)(?:\s|$)/i.test(inputText.trim());
  allowTypeAhead = !wasGuided && !adminCommand && !/^challenges?$/i.test(inputText.trim());
  setInputText(inputElement, '');
  inputElement.contentEditable = allowTypeAhead ? 'true' : 'false';
  let paging = false;
  const finish = () => {
    if (!ownsTerminal()) return;
    const inputWrapper = document.getElementById('terminal-input-wrapper');
    if (inputWrapper?.hidden) {
      // Editors and pagers own the selection while the shell prompt is hidden.
      inputElement.innerText = '';
    } else if (!allowTypeAhead || hasGuidedSession()) {
      setInputText(inputElement, '');
    }
    allowTypeAhead = false;
    activeCommandOwns = undefined;
    inputElement.dataset.commandBusy = 'false';
    inputElement.dataset.commandCompletions = String(
      Number(inputElement.dataset.commandCompletions ?? 0) + 1,
    );
    if (!inputWrapper?.hidden) {
      inputElement.contentEditable = 'true';
      flushChallengeMailNotice();
      inputElement.focus();
    }
  };
  try {
    const outputText = await processCommand(inputText, ownsTerminal);
    if (!ownsTerminal()) return;
    // Only the submitted top-level command is observable. Guided answers,
    // adventure input and editor keystrokes are private.
    if (!wasGuided && !wasAdventure && isAuthenticated()) {
      await recordCommandActivity(inputText);
    }
    if (!ownsTerminal()) return;

    if (outputText) {
      // One shared presentation boundary for builtins, shell errors and pagers:
      // exactly one empty line separates each result from the next prompt.
      const spacedOutput = `${outputText.replace(/\n+$/, '')}\n\n`;
      if (inputText.length > 0 && !wasGuided) {
        commandHistory.push(historyText);
        commandIndex = commandHistory.length;
      }

      if (!wasGuided && isChallengeCommand(inputText)) {
        const pager = new ChallengePager({
          output: terminalOutput,
          input: inputElement,
          render: (element) => appendTerminalText(element, `${submittedPrefix}${spacedOutput}`),
          onFinish: () => {
            if (!ownsTerminal()) return;
            finish();
            scrollToBottom();
          },
        });
        if (pager.start()) {
          paging = true;
          return;
        }
      }

      const newOutputLine = document.createElement('div');
      terminalOutput.appendChild(newOutputLine);

      // Animate only the output, never the live input. The command stays busy
      // throughout both animations while the next draft remains editable.
      if (inputText.length > 0) {
        await animateText(newOutputLine, submittedPrefix, 10, undefined, undefined, ownsTerminal);
      }
      if (!ownsTerminal()) return;
      await new Promise(resolve => setTimeout(resolve, 100));
      if (!ownsTerminal()) return;
      await animateText(newOutputLine, spacedOutput, 10, undefined, undefined, ownsTerminal);

      if (ownsTerminal()) scrollToBottom();
    }
  } catch (error) {
    // A disposed command's rejection has no current UI recipient.
    if (ownsTerminal()) throw error;
  } finally {
    // Readiness belongs to the whole command, not individual output animations.
    if (!paging) finish();
  }
}

function handleArrowUp(inputElement: HTMLElement): void {
  if (!inputElement) return;
  if (hasGuidedSession()) return;
  
  if (commandIndex > 0) {
    commandIndex--;
    setInputText(inputElement, commandHistory[commandIndex] ?? '');
  }
}

function handleArrowDown(inputElement: HTMLElement): void {
  if (!inputElement) return;
  if (hasGuidedSession()) return;

  if (commandIndex < commandHistory.length - 1) {
    commandIndex++;
    setInputText(inputElement, commandHistory[commandIndex] ?? '');
  } else if (commandIndex === commandHistory.length - 1) {
    commandIndex++;
    setInputText(inputElement, '');
  }
}

function handleEscape(inputElement: HTMLElement): void {
  const cancelled = cancelGuidedSession();
  if (cancelled) {
    setPrompt(cancelled.prompt);
    const terminalOutput = document.getElementById('terminal-output');
    if (terminalOutput) {
      const line = document.createElement('div');
      line.textContent = cancelled.output;
      terminalOutput.appendChild(line);
      scrollToBottom();
    }
  }
  setInputText(inputElement, '');
}

function handleTab(inputElement: HTMLElement): void {
  if (!inputElement) return;
  if (hasGuidedSession()) return;

  const inputText = inputElement.innerText.trim();
  const suggestions = getAutocompleteSuggestions(
    inputText, getCurrentUser()?.groups.includes('funwithflags-admins') === true,
    getCurrentUser()?.is_admin === true,
  );

  if (suggestions.length === 1) {
    setInputText(inputElement, `${suggestions[0] ?? ''} `);
  } else if (suggestions.length > 1) {
    const terminalOutput = document.getElementById('terminal-output');
    if (terminalOutput) {
      const line = document.createElement('div');
      line.textContent = suggestions.join('    ');
      terminalOutput.appendChild(line);
      scrollToBottom();
    }
  }
}

export async function handleInput(
  event: KeyboardEvent, redirectedInput?: HTMLElement,
): Promise<void> {
  if (!event?.target) return;
  if (isChallengeModalOpen()) return;

  const terminalOutput = document.getElementById('terminal-output');
  const inputElement = redirectedInput ?? event.target as HTMLElement;

  if (commandBusy()) {
    if (hasGuidedSession() && (event.key === 'Escape'
      || (event.ctrlKey && event.key.toLowerCase() === 'c'))) {
      event.preventDefault();
      handleEscape(inputElement);
      return;
    }
    // Editing the draft is safe; submitting, history and completion must wait.
    if (!allowTypeAhead || ['Enter', 'Tab', 'ArrowUp', 'ArrowDown', 'Escape'].includes(event.key)) {
      event.preventDefault();
    }
    return;
  }

  if (isGuidedSecretInput()) {
    if (event.key === 'Backspace') {
      event.preventDefault();
      const current = guidedInputValue('');
      setGuidedSecretInput(Array.from(current).slice(0, -1).join(''));
      setInputText(inputElement, getGuidedSecretMask());
      return;
    }
    if (event.key?.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      setGuidedSecretInput(`${guidedInputValue('')}${event.key}`);
      setInputText(inputElement, getGuidedSecretMask());
      return;
    }
  }

  if (hasGuidedSession() && event.ctrlKey && event.key.toLowerCase() === 'c') {
    event.preventDefault();
    handleEscape(inputElement);
    return;
  }
  
  // Play typing sound for any key that's "printable"
  if (event.key?.length === 1 || event.key === 'Backspace') {
    const soundClone = keySound.cloneNode() as HTMLAudioElement;
    soundClone.play().catch((e: unknown) => console.warn('Keypress sound blocked:', e));
  }

  switch (event.key) {
    case 'Enter':
      event.preventDefault();
      if (terminalOutput) {
        await handleEnterKey(terminalOutput, inputElement);
      }
      break;
    case 'ArrowUp':
      event.preventDefault();
      handleArrowUp(inputElement);
      break;
    case 'ArrowDown':
      event.preventDefault();
      handleArrowDown(inputElement);
      break;
    case 'Escape':
      event.preventDefault();
      handleEscape(inputElement);
      break;
    case 'Tab':
      event.preventDefault();
      handleTab(inputElement);
      break;
  }
}

export function handlePaste(event: ClipboardEvent, redirectedInput?: HTMLElement): void {
  if (commandBusy() && !allowTypeAhead) {
    event.preventDefault();
    return;
  }
  event.preventDefault();
  const pasted = event.clipboardData?.getData('text/plain') ?? '';
  const input = redirectedInput ?? event.currentTarget as HTMLElement | null;
  if (!input) return;
  if (!isGuidedSecretInput()) {
    insertPlainPaste(input, pasted);
    return;
  }
  setGuidedSecretInput(`${guidedInputValue('')}${pasted}`);
  if (input) setInputText(input, getGuidedSecretMask());
}

/** Catch mobile/IME edits which may not emit a printable keydown. */
export function handleBeforeInput(event: InputEvent): void {
  if (commandBusy()) {
    if (!allowTypeAhead || event.inputType === 'insertParagraph' || event.inputType === 'insertLineBreak') {
      event.preventDefault();
    }
    return;
  }
  if (!isGuidedSecretInput()) return;
  event.preventDefault();
  let value = guidedInputValue('');
  if (event.inputType === 'deleteContentBackward') {
    value = Array.from(value).slice(0, -1).join('');
  } else if (event.inputType.startsWith('insert') && event.data) {
    value += event.data;
  }
  setGuidedSecretInput(value);
  const input = event.currentTarget as HTMLElement | null;
  if (input) setInputText(input, getGuidedSecretMask());
}

/**
 * Any keypress outside the input refocuses the terminal so players can just start typing.
 * Registered once from init(); the per-key handling itself lives in handleInput.
 */
export function focusTerminalOnAnyKey(terminalInput: HTMLElement): void {
  document.addEventListener('keydown', (event: KeyboardEvent) => {
    if (isChallengeModalOpen()) return;
    if (event.target instanceof Element &&
        event.target.closest('button, a, input, select, textarea, [role="button"], [contenteditable="true"]')) return;
    // Modifier keydown arrives before C/V. Focusing on Control or Meta alone
    // would destroy the output selection before native Copy can use it.
    if (['Tab', 'Control', 'Meta', 'Shift', 'Alt'].includes(event.key)) return;
    // Preserve native output selection, including a collapsed caret in
    // caret-browsing mode, before the browser extends it with Shift+navigation.
    const selection = window.getSelection();
    if (selection?.anchorNode
      && document.getElementById('terminal-output')?.contains(selection.anchorNode)
      && event.shiftKey
      && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    // Do not steal the output selection before native Copy / Select All.
    if ((event.ctrlKey || event.metaKey) && (
      ['a', 'x'].includes(event.key.toLowerCase())
      || (event.key.toLowerCase() === 'c' && window.getSelection()?.toString())
    )) return;
    const wrapper = document.getElementById('terminal-input-wrapper');
    if (!wrapper || wrapper.hidden || terminalInput.contentEditable !== 'true') return;
    if (event.target !== terminalInput) {
      terminalInput.focus();
      // Focusing during keydown does not retarget that key's default text insertion
      // or the input's keydown listener. Deliver the first key as well as later ones.
      if (event.key === 'Enter' || ['ArrowUp', 'ArrowDown', 'Escape'].includes(event.key)
        || (isGuidedSecretInput() && (event.key === 'Backspace' || event.key.length === 1))) {
        void handleInput(event, terminalInput);
      } else if (!event.ctrlKey && !event.metaKey && !event.altKey) {
        if (event.key.length === 1) {
          event.preventDefault();
          setInputText(terminalInput, `${terminalInput.innerText}${event.key}`);
        } else if (event.key === 'Backspace') {
          event.preventDefault();
          setInputText(terminalInput, Array.from(terminalInput.innerText).slice(0, -1).join(''));
        }
      }
      const soundClone = keySound.cloneNode() as HTMLAudioElement;
      soundClone.play().catch((e: unknown) => console.warn('Keypress sound blocked:', e));
    }
  });
}
