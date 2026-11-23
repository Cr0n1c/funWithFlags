import { isChallengeModalOpen } from './challengeModal.js';

export const PAGER_MESSAGE = '--More--  Enter: next row  Space: next page  Left/Right: scroll  Q/Esc: quit';
export type PagerAction = 'row' | 'page' | 'quit' | 'ignore';

export function pagerActionForKey(key: string): PagerAction {
  const normalized = key.toLowerCase();
  if (normalized === 'enter') return 'row';
  if (normalized === ' ' || normalized === 'spacebar') return 'page';
  if (normalized === 'q' || normalized === 'escape') return 'quit';
  return 'ignore';
}

export interface PageMetrics {
  pageRows: number;
  totalRows: number;
}

/** Convert measured CSS pixels into terminal rows. Kept pure for regression tests. */
export function calculatePageMetrics(
  availableHeight: number,
  statusHeight: number,
  contentHeight: number,
  lineHeight: number,
  reservedHeight = 0,
): PageMetrics {
  const rowHeight = lineHeight > 0 ? lineHeight : 20;
  return {
    pageRows: Math.max(
      1,
      Math.floor(Math.max(0, availableHeight - statusHeight - reservedHeight) / rowHeight),
    ),
    totalRows: Math.max(1, Math.ceil(Math.max(0, contentHeight) / rowHeight)),
  };
}

export class PageCursor {
  offset = 0;

  constructor(
    public pageRows: number,
    public totalRows: number,
  ) {}

  get needsPaging(): boolean {
    return this.totalRows > this.pageRows;
  }

  resize(pageRows: number, totalRows: number): void {
    this.pageRows = Math.max(1, pageRows);
    this.totalRows = Math.max(1, totalRows);
    this.offset = Math.min(this.offset, Math.max(0, this.totalRows - this.pageRows));
  }

  advance(rows: number): boolean {
    this.offset = Math.min(
      this.offset + Math.max(1, rows),
      Math.max(0, this.totalRows - this.pageRows),
    );
    return this.offset + this.pageRows >= this.totalRows;
  }
}

interface ChallengePagerOptions {
  output: HTMLElement;
  input: HTMLElement;
  render: (element: HTMLElement) => void;
  onFinish: (quit: boolean) => void;
}

let activePager: ChallengePager | null = null;

/** Drop a paged view before replacing the terminal with the sign-in gate. */
export function cancelActiveChallengePager(): void {
  activePager?.cancelForAuth();
}

/**
 * A small, screen-sized `more` pager. The complete output is rendered once, so anchors remain
 * real DOM nodes; paging only clips/translates it by measured rendered rows.
 */
export class ChallengePager {
  private root: HTMLDivElement;
  private viewport: HTMLDivElement;
  private content: HTMLDivElement;
  private status: HTMLDivElement;
  private cursor = new PageCursor(1, 1);
  private lineHeight = 20;
  private resizeObserver: ResizeObserver | null = null;
  private previousChildren: Array<{ element: HTMLElement; hidden: boolean }> = [];
  private finished = false;

  constructor(private options: ChallengePagerOptions) {
    this.root = document.createElement('div');
    this.root.className = 'terminal-pager';
    this.viewport = document.createElement('div');
    this.viewport.className = 'terminal-pager__viewport';
    this.viewport.tabIndex = 0;
    this.viewport.setAttribute('role', 'region');
    this.viewport.setAttribute('aria-label', 'Paged output. Left and right arrows scroll horizontally.');
    this.content = document.createElement('div');
    this.content.className = 'terminal-pager__content';
    this.status = document.createElement('div');
    this.status.className = 'terminal-pager__status';
    this.status.textContent = PAGER_MESSAGE;
    this.viewport.appendChild(this.content);
    this.root.append(this.viewport, this.status);
  }

  start(): boolean {
    const { output, input, render } = this.options;
    this.previousChildren = Array.from(output.children).map((node) => {
      const element = node as HTMLElement;
      const hidden = element.hidden;
      element.hidden = true;
      return { element, hidden };
    });
    output.appendChild(this.root);
    render(this.content);
    input.contentEditable = 'false';
    this.resetTerminalScroll();

    this.measure();
    if (!this.cursor.needsPaging) {
      this.remove(true);
      return false;
    }

    activePager = this;
    const wrapper = document.getElementById('terminal-input-wrapper');
    if (wrapper) wrapper.hidden = true;
    this.update();
    this.viewport.focus({ preventScroll: true });
    document.addEventListener('keydown', this.handleKey, true);
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => {
        this.measure();
        if (!this.cursor.needsPaging) this.finish(false);
        else this.update();
      });
      const terminal = output.closest('.terminal') ?? output;
      this.resizeObserver.observe(terminal);
      // Text enlargement can change rows/status without changing CRT size.
      this.resizeObserver.observe(this.status);
      this.resizeObserver.observe(this.content);
    }
    return true;
  }

  private measure(): void {
    const terminal = this.options.output.closest('.terminal') as HTMLElement | null;
    const styles = getComputedStyle(this.content);
    this.lineHeight = Number.parseFloat(styles.lineHeight) ||
      Number.parseFloat(styles.fontSize) || 20;
    const terminalStyles = terminal ? getComputedStyle(terminal) : null;
    const verticalPadding = terminalStyles
      ? (Number.parseFloat(terminalStyles.paddingTop) || 0) +
        (Number.parseFloat(terminalStyles.paddingBottom) || 0)
      : 0;
    const viewportHeight = Math.max(
      this.lineHeight * 2,
      window.innerHeight - (terminal?.getBoundingClientRect().top ?? 0),
    );
    const measuredHeight = terminal?.clientHeight ||
      this.options.output.parentElement?.clientHeight ||
      viewportHeight;
    const fixedPanel = getComputedStyle(this.root).position === 'fixed';
    const availableHeight = Math.max(
      this.lineHeight,
      fixedPanel ? this.root.clientHeight : Math.min(measuredHeight, viewportHeight) - verticalPadding,
    );
    const statusHeight = this.status.getBoundingClientRect().height || this.lineHeight;
    const outputStyles = getComputedStyle(this.options.output);
    const outputMargin = Number.parseFloat(outputStyles.marginBottom) || 0;
    const inputWrapper = document.getElementById('terminal-input-wrapper');
    // display:none removes the prompt's rectangle, but not its computed CSS height.
    // Reserve the same space before and after hiding it (including on resize).
    const promptHeight = inputWrapper
      ? inputWrapper.getBoundingClientRect().height ||
        Number.parseFloat(getComputedStyle(inputWrapper).height) || this.lineHeight * 1.2
      : this.lineHeight * 1.2;
    const metrics = calculatePageMetrics(
      availableHeight,
      statusHeight,
      this.content.scrollHeight,
      this.lineHeight,
      fixedPanel ? 0 : outputMargin + promptHeight,
    );
    this.cursor.resize(metrics.pageRows, metrics.totalRows);
  }

  private update(): void {
    this.viewport.style.height =
      `${Math.min(this.cursor.pageRows, this.cursor.totalRows) * this.lineHeight}px`;
    this.content.style.transform = `translateY(-${this.cursor.offset * this.lineHeight}px)`;
    this.resetTerminalScroll();
  }

  private handleKey = (event: KeyboardEvent): void => {
    if (isChallengeModalOpen()) return;
    // Hardware controls retain native keyboard activation while a pager is open.
    if (typeof Element !== 'undefined' && event.target instanceof Element &&
        event.target.closest('#degauss-button')) return;
    // Keep focus in the reading area rather than tabbing into clipped rows or
    // the hidden shell. Handle scrolling here so no keys reach shell listeners.
    if (event.key === 'Tab' || event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.viewport.focus({ preventScroll: true });
      if (event.key !== 'Tab') {
        const direction = event.key === 'ArrowLeft' ? -1 : 1;
        this.viewport.scrollLeft += direction * this.lineHeight * 2;
      }
      return;
    }
    const action = pagerActionForKey(event.key);
    if (action === 'ignore') {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    if (action === 'quit') {
      this.finish(true);
      return;
    }
    const done = this.cursor.advance(action === 'row' ? 1 : this.cursor.pageRows);
    this.update();
    if (done) this.finish(false);
  };

  cancelForAuth(): void {
    this.finished = true;
    if (activePager === this) activePager = null;
    document.removeEventListener('keydown', this.handleKey, true);
    this.resizeObserver?.disconnect();
    this.root.remove();
  }

  private finish(quit: boolean): void {
    if (this.finished) return;
    this.finished = true;
    if (activePager === this) activePager = null;
    document.removeEventListener('keydown', this.handleKey, true);
    this.resizeObserver?.disconnect();

    // On both completion and quit, preserve exactly the page the player was viewing. Expanding the
    // content here would reveal skipped rows on quit and move the final page off screen on end.
    this.status.remove();
    this.root.classList.add('terminal-pager--finished');
    this.previousChildren.forEach(({ element, hidden }) => {
      element.hidden = hidden;
    });
    const wrapper = document.getElementById('terminal-input-wrapper');
    if (wrapper) wrapper.hidden = false;
    this.options.input.contentEditable = 'true';
    this.options.input.focus();
    this.options.onFinish(quit);
  }

  private resetTerminalScroll(): void {
    const terminal = this.options.output.closest('.terminal') as HTMLElement | null;
    if (terminal) terminal.scrollTop = 0;
  }

  private remove(restorePrevious: boolean): void {
    this.root.remove();
    if (restorePrevious) {
      this.previousChildren.forEach(({ element, hidden }) => {
        element.hidden = hidden;
      });
    }
    this.options.input.contentEditable = 'true';
  }
}