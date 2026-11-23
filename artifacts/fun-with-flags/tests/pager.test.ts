import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ChallengePager,
  PageCursor,
  PAGER_MESSAGE,
  calculatePageMetrics,
  pagerActionForKey,
} from '../src/js/terminal/pager.js';
import { parseTerminalText } from '../src/js/terminal/terminal.js';

afterEach(() => vi.unstubAllGlobals());

describe('challenge output pager', () => {
  it('advances Enter by exactly one rendered row', () => {
    const cursor = new PageCursor(5, 12);
    expect(cursor.advance(1)).toBe(false);
    expect(cursor.offset).toBe(1);
  });

  it('advances Space by one page and ends at the final page', () => {
    const cursor = new PageCursor(5, 12);
    expect(cursor.advance(cursor.pageRows)).toBe(false);
    expect(cursor.offset).toBe(5);
    expect(cursor.advance(cursor.pageRows)).toBe(true);
    expect(cursor.offset).toBe(7);
  });

  it('does not page short output', () => {
    expect(new PageCursor(8, 8).needsPaging).toBe(false);
    expect(new PageCursor(8, 3).needsPaging).toBe(false);
  });

  it('recomputes responsive page size from rendered CSS pixels', () => {
    expect(calculatePageMetrics(220, 20, 600, 20)).toEqual({
      pageRows: 10,
      totalRows: 30,
    });
    expect(calculatePageMetrics(120, 20, 600, 20).pageRows).toBe(5);
    expect(calculatePageMetrics(220, 20, 600, 20, 40).pageRows).toBe(8);
  });

  it('advertises row, page, and quit controls', () => {
    expect(PAGER_MESSAGE).toContain('Enter: next row');
    expect(PAGER_MESSAGE).toContain('Space: next page');
    expect(PAGER_MESSAGE).toContain('Left/Right: scroll');
    expect(PAGER_MESSAGE).toContain('Q/Esc: quit');
  });

  it('recognizes quit and end-of-output controls without treating typing as commands', () => {
    expect(pagerActionForKey('q')).toBe('quit');
    expect(pagerActionForKey('Escape')).toBe('quit');
    expect(pagerActionForKey('x')).toBe('ignore');
    const cursor = new PageCursor(4, 5);
    expect(cursor.advance(1)).toBe(true);
    expect(cursor.offset + cursor.pageRows).toBe(cursor.totalRows);
  });

  it('keeps challenge link tokens intact and never turns URLs into links', () => {
    expect(parseTerminalText('\x1b]8;;challenge-id:7\x07Seven\x1b]8;;\x07'))
      .toEqual([{ text: 'Seven', challengeId: 7 }]);
    expect(parseTerminalText('\x1b]8;;https://example.test/x\x07label\x1b]8;;\x07'))
      .toEqual([{ text: 'label' }]);
  });
});

class PagerElement {
  hidden = false;
  contentEditable = 'true';
  textContent = '';
  className = '';
  clientHeight = 0;
  scrollHeight = 0;
  scrollTop = 99;
  scrollLeft = 0;
  tabIndex = -1;
  attributes: Record<string, string> = {};
  parentElement: PagerElement | null = null;
  terminal: PagerElement | null = null;
  children: PagerElement[] = [];
  style: Record<string, string> = {};
  focused = false;
  classList = { add: (name: string) => { this.className += ` ${name}`; } };

  append(...children: PagerElement[]): void {
    children.forEach((child) => this.appendChild(child));
  }
  appendChild(child: PagerElement): PagerElement {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  remove(): void {
    if (this.parentElement) {
      this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    }
  }
  closest(selector: string): PagerElement | null {
    return selector === '.terminal' ? this.terminal : null;
  }
  getBoundingClientRect(): { height: number; top: number } {
    return { height: this.className.includes('__status') ? 20 : this.clientHeight, top: 0 };
  }
  focus(): void {
    this.focused = true;
  }
  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }
}

function installPagerDom() {
  const terminal = new PagerElement();
  terminal.clientHeight = 160;
  const output = new PagerElement();
  output.terminal = terminal;
  const input = new PagerElement();
  const wrapper = new PagerElement();
  wrapper.clientHeight = 20;
  const history = new PagerElement();
  const alreadyHidden = new PagerElement();
  alreadyHidden.hidden = true;
  output.append(history, alreadyHidden);
  let keydown: ((event: KeyboardEvent) => void) | null = null;

  vi.stubGlobal('window', { innerHeight: 160 });
  vi.stubGlobal('getComputedStyle', (element: PagerElement) => ({
    lineHeight: '20px',
    fontSize: '20px',
    paddingTop: element === terminal ? '10px' : '0px',
    paddingBottom: element === terminal ? '10px' : '0px',
    marginBottom: '0px',
  }));
  vi.stubGlobal('document', {
    createElement: () => new PagerElement(),
    getElementById: (id: string) => id === 'terminal-input-wrapper' ? wrapper : null,
    querySelector: () => null,
    addEventListener: (name: string, listener: (event: KeyboardEvent) => void) => {
      if (name === 'keydown') keydown = listener;
    },
    removeEventListener: () => undefined,
  });
  const dispatch = (key: string) => {
    const event = { key, preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() };
    keydown?.(event as unknown as KeyboardEvent);
    return event;
  };
  return { terminal, output, input, wrapper, history, alreadyHidden, dispatch };
}

describe('challenge pager DOM lifecycle', () => {
  it('focuses the reading area and consumes horizontal and Tab keys without advancing rows', () => {
    const dom = installPagerDom();
    const onFinish = vi.fn();
    const pager = new ChallengePager({
      output: dom.output as unknown as HTMLElement,
      input: dom.input as unknown as HTMLElement,
      render: element => { (element as unknown as PagerElement).scrollHeight = 240; },
      onFinish,
    });
    expect(pager.start()).toBe(true);
    const viewport = dom.output.children[2]!.children[0]!;
    expect(viewport.tabIndex).toBe(0);
    expect(viewport.attributes.role).toBe('region');
    expect(viewport.focused).toBe(true);
    for (const key of ['ArrowRight', 'ArrowLeft', 'Tab', 'x']) {
      const event = dom.dispatch(key);
      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(event.stopImmediatePropagation).toHaveBeenCalledOnce();
      expect(viewport.scrollLeft).toBe(key === 'ArrowRight' ? 40 : 0);
      expect(viewport.children[0]!.style.transform).toBe('translateY(-0px)');
      expect(dom.input.contentEditable).toBe('false');
    }
    expect(onFinish).not.toHaveBeenCalled();
    dom.dispatch('q');
    expect(dom.input.focused).toBe(true);
    expect(onFinish).toHaveBeenCalledWith(true);
  });

  it.each(['q', 'Escape'])('restores history and removes status on %s quit', (key) => {
    const dom = installPagerDom();
    const pager = new ChallengePager({
      output: dom.output as unknown as HTMLElement,
      input: dom.input as unknown as HTMLElement,
      render: (element) => {
        (element as unknown as PagerElement).scrollHeight = 240;
      },
      onFinish: vi.fn(),
    });

    expect(pager.start()).toBe(true);
    expect(dom.history.hidden).toBe(true);
    expect(dom.terminal.scrollTop).toBe(0);
    dom.dispatch(key);

    expect(dom.history.hidden).toBe(false);
    expect(dom.alreadyHidden.hidden).toBe(true);
    const root = dom.output.children[2]!;
    expect(root.children).toHaveLength(1);
    expect(root.children[0]?.style.height).toBe('100px');
    expect(dom.wrapper.hidden).toBe(false);
    expect(dom.input.contentEditable).toBe('true');
  });

  it('keeps only the last page visible and removes status at natural end', () => {
    const dom = installPagerDom();
    const pager = new ChallengePager({
      output: dom.output as unknown as HTMLElement,
      input: dom.input as unknown as HTMLElement,
      render: (element) => {
        (element as unknown as PagerElement).scrollHeight = 240;
      },
      onFinish: vi.fn(),
    });
    expect(pager.start()).toBe(true);
    dom.terminal.scrollTop = 80;
    dom.dispatch(' ');
    expect(dom.terminal.scrollTop).toBe(0);
    dom.dispatch(' ');

    const root = dom.output.children[2]!;
    const viewport = root.children[0]!;
    expect(root.children).toHaveLength(1);
    expect(viewport.style.height).toBe('100px');
    expect(viewport.children[0]?.style.transform).toBe('translateY(-140px)');
    expect(dom.history.hidden).toBe(false);
    expect(dom.input.focused).toBe(true);
  });
});