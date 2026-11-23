import { expect } from 'vitest';
import type { Locator, Page } from 'playwright';

// Desktop mouse/keyboard contexts only. Reduced CSS viewports are equivalent
// reflow checks, not evidence of operating a native browser zoom menu.
export const pagerDesktopLayouts = [
  { name: 'standard desktop', width: 1280, height: 900, textScale: 1 },
  { name: '200% desktop reflow', width: 640, height: 450, textScale: 1 },
  { name: '400% desktop reflow', width: 320, height: 225, textScale: 1 },
  { name: '200% desktop text enlargement', width: 1280, height: 900, textScale: 2 },
];

async function exposedText(target: Locator) {
  return target.evaluate(element => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const rects: DOMRect[] = [];
    let node: Node | null;
    while ((node = walker.nextNode())) {
      // Glyphs, not trailing whitespace: the shell draws a separate block
      // cursor adjacent to the editable input.
      for (let index = 0; index < (node.textContent?.length ?? 0); index++) {
        if (!node.textContent!.charAt(index).trim()) continue;
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + 1);
        rects.push(...range.getClientRects());
      }
    }
    const clipped = rects.filter(rect => rect.width > 0 && rect.height > 0).filter(rect => !(
      rect.left >= 0 && rect.right <= innerWidth &&
      rect.top >= 0 && rect.bottom <= innerHeight &&
      element.contains(document.elementFromPoint(
        (rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2))));
    return rects.length > 0 && clipped.length === 0 ? true : {
      rects: clipped.map(rect => ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })),
      covering: clipped.map(rect => document.elementFromPoint(
        (rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2,
      )?.className),
    };
  });
}

export async function pagerDesktopJourney(
  page: Page, layout: typeof pagerDesktopLayouts[number],
) {
  const input = page.locator('#terminal-input');
  const output = page.locator('#terminal-output');
  const prefix = await page.locator('#input-prefix').textContent();
  for (const exit of ['q', 'Escape', 'end']) {
    await input.focus();
    await page.keyboard.insertText('challenges gold');
    await page.keyboard.press('Enter');
    const pager = output.locator('.terminal-pager').last();
    const status = pager.locator('.terminal-pager__status');
    const viewport = pager.locator('.terminal-pager__viewport');
    const content = pager.locator('.terminal-pager__content');
    await status.waitFor();
    // Resize the live pager as well as opening subsequent pagers at that size.
    await page.setViewportSize({ width: layout.width, height: layout.height });
    // Explicitly double fixed-pixel terminal fonts too: changing only the root
    // would leave 20px text unchanged. Do it while open to check remeasurement.
    if (layout.textScale === 2 && exit === 'q') {
      await page.addStyleTag({ content: `
        html { font-size: 28px !important; }
        #terminal-output, #terminal-input, #input-prefix { font-size: 40px !important; }
      ` });
    }
    const geometry = () => viewport.evaluate(element => ({
      height: element.clientHeight,
      line: parseFloat(getComputedStyle(element).lineHeight),
      width: element.clientWidth, scrollWidth: element.scrollWidth,
    }));
    const checkStatus = async () => {
      expect(await status.textContent()).toBe('--More--  Enter: next row  Space: next page  Left/Right: scroll  Q/Esc: quit');
      await expect.poll(() => exposedText(status), {
        message: 'Every status/quit instruction must be onscreen and clear of CRT hardware',
      }).toBe(true);
      expect((await geometry()).height).toBeGreaterThanOrEqual((await geometry()).line);
      expect(await content.evaluate(el => parseFloat(getComputedStyle(el).fontSize)))
        .toBe(20 * layout.textScale);
    };
    await checkStatus();
    for (const key of ['Tab', 'Shift+Tab']) {
      await page.keyboard.press(key);
      expect(await viewport.evaluate(element => document.activeElement === element)).toBe(true);
      expect(await viewport.evaluate(element => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return element.matches(':focus-visible') && style.outlineStyle === 'solid' &&
          parseFloat(style.outlineWidth) >= 2 && style.outlineColor !== 'rgba(0, 0, 0, 0)' &&
          rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight &&
          element.contains(document.elementFromPoint(rect.left + 2, rect.top + 2)) &&
          element.contains(document.elementFromPoint(rect.right - 2, rect.bottom - 2));
      })).toBe(true);
    }
    const offset = () => content.evaluate(element =>
      -new DOMMatrixReadOnly(getComputedStyle(element).transform).m42);
    const before = await offset();
    await page.keyboard.press('Enter');
    expect(await offset()).toBeCloseTo(before + (await geometry()).line);
    const rowOffset = await offset();
    await page.keyboard.press('Space');
    expect(await offset()).toBeCloseTo(rowOffset + (await geometry()).height);
    await checkStatus();
    // Wide tables must scroll inside the reading area, never move the status
    // offscreen or shrink columns to unreadable fragments.
    expect((await geometry()).scrollWidth).toBeGreaterThan((await geometry()).width);
    const horizontalOffset = () => viewport.evaluate(el => el.scrollLeft);
    const verticalOffset = await offset();
    for (let count = 0; count < 150; count++) {
      const previous = await horizontalOffset();
      await page.keyboard.press('ArrowRight');
      if (await horizontalOffset() === previous) break;
    }
    expect(await horizontalOffset()).toBeCloseTo((await geometry()).scrollWidth - (await geometry()).width);
    expect(await offset()).toBe(verticalOffset);
    await expect.poll(() => viewport.evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
    await expect.poll(() => viewport.evaluate(element => {
      const clip = element.getBoundingClientRect();
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      // Check a visible rightmost points cell, not merely a nonzero scrollLeft.
      while ((node = walker.nextNode())) {
        for (const match of node.textContent!.matchAll(/12345/g)) {
          const range = document.createRange();
          range.setStart(node, match.index);
          range.setEnd(node, match.index + 5);
          const rect = range.getBoundingClientRect();
          const centerY = (rect.top + rect.bottom) / 2;
          if (centerY <= clip.top || centerY >= clip.bottom) continue;
          const hit = document.elementFromPoint((rect.left + rect.right) / 2, centerY);
          return rect.left >= clip.left && rect.right <= clip.right && element.contains(hit)
            ? true : { rect: rect.toJSON(), clip: clip.toJSON(), covering: hit?.className };
        }
      }
      return false;
    }), { message: 'The far-right table column must remain readable and uncovered' }).toBe(true);
    await checkStatus();
    for (let count = 0; count < 150 && await horizontalOffset() > 0; count++) {
      await page.keyboard.press('ArrowLeft');
    }
    expect(await horizontalOffset()).toBe(0);
    await page.keyboard.press('ArrowLeft');
    expect(await horizontalOffset()).toBe(0);
    expect(await offset()).toBe(verticalOffset);
    await page.keyboard.press('x');
    expect(await input.innerText()).toBe('');
    expect(await input.getAttribute('contenteditable')).toBe('false');
    const childrenBefore = await output.locator(':scope > *').count();
    if (exit === 'end') {
      for (let count = 0; count < 100 && await status.count(); count++) {
        await page.keyboard.press('Space');
      }
    } else {
      await page.keyboard.press(exit);
    }
    expect(await status.count()).toBe(0);
    expect(await input.evaluate(el => document.activeElement === el)).toBe(true);
    expect(await input.getAttribute('contenteditable')).toBe('true');
    expect(await page.getByRole('button', { name: 'Degauss', exact: true }).isVisible()).toBe(true);
    await expect.poll(() => exposedText(page.locator('#input-prefix'))).toBe(true);
    // No focus(), click(), or scrollIntoView() after exit can mask a lost
    // keyboard handoff. Type immediately and verify one complete command.
    const text = `echo zoom-${exit.toLowerCase()} | tr a-z A-Z`;
    await page.keyboard.insertText(text);
    expect(await input.innerText()).toBe(text);
    await expect.poll(() => exposedText(input), {
      message: 'Restored typed prompt must be readable, not just focused',
    }).toBe(true);
    await page.keyboard.press('Enter');
    await expect.poll(() => input.getAttribute('data-command-busy'), { timeout: 10_000 }).toBe('false');
    const lines = output.locator(`:scope > :nth-child(n+${childrenBefore + 1})`);
    expect(await lines.count()).toBe(1);
    expect((await lines.allTextContents()).join('').trim())
      .toBe(`${prefix}${text}\nZOOM-${exit.toUpperCase()}`);
  }
}
