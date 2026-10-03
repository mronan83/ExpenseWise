import type { Page } from '@playwright/test';

/** One thing wrong with how a screen is laid out, in words a person can act on. */
export interface LayoutProblem {
  readonly check: string;
  readonly what: string;
  readonly detail?: string;
}

/**
 * Runs in the page. Finds what a person would see as broken at this width: the page wider
 * than the screen, something off the screen or out of its card, controls on top of each
 * other, a date or number cut off in its field, a target too small to tap, and a date field
 * still drawn natively, which iOS Safari widens past its column. Long names cut off with an
 * ellipsis are meant, and the tab bar stays at the bottom while the page scrolls under it.
 */
function findProblems(): LayoutProblem[] {
  const out: LayoutProblem[] = [];
  const width = document.documentElement.clientWidth;
  const name = (el: Element) => {
    const input = el as HTMLInputElement;
    const text = (
      el.getAttribute('aria-label') ??
      input.labels?.[0]?.textContent ??
      el.textContent ??
      ''
    )
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 40);
    return `${el.tagName.toLowerCase()}${input.type ? `[${input.type}]` : ''}${text ? ` "${text}"` : ''}`;
  };
  const shown = (el: Element) => {
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    // Screen-reader-only text is 1px and clipped on purpose.
    return (
      box.width > 1 && box.height > 1 && style.visibility !== 'hidden' && style.display !== 'none'
    );
  };
  const insideScroller = (el: Element) => {
    for (let a = el.parentElement; a; a = a.parentElement) {
      const overflow = getComputedStyle(a).overflowX;
      if (overflow !== 'visible') return true;
    }
    return false;
  };
  const boxed = (el: Element) => {
    const style = getComputedStyle(el);
    const background = style.backgroundColor;
    return (
      parseFloat(style.borderLeftWidth) > 0 ||
      parseFloat(style.borderRightWidth) > 0 ||
      (background !== 'rgba(0, 0, 0, 0)' && background !== 'transparent')
    );
  };
  const inTabBar = (el: Element) => el.closest('nav[aria-label="Main"]') !== null;

  if (document.documentElement.scrollWidth > width + 1) {
    out.push({
      check: 'page wider than the screen',
      what: `${document.documentElement.scrollWidth - width}px`,
    });
  }
  const all = [...document.body.querySelectorAll('*')].filter(shown);
  for (const el of all) {
    const box = el.getBoundingClientRect();
    if (!insideScroller(el) && (box.right > width + 1 || box.left < -1)) {
      out.push({
        check: 'off the screen',
        what: name(el),
        detail: `${Math.round(box.left)}–${Math.round(box.right)} of ${width}`,
      });
    }
  }
  const leaves = all.filter((el) =>
    el.matches('input,select,textarea,button,a,img,h1,h2,h3,p,dd,dt,td,th,li,label'),
  );
  for (const el of leaves) {
    const box = el.getBoundingClientRect();
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      if (!boxed(a)) continue;
      const card = a.getBoundingClientRect();
      if (box.right > card.right + 1 || box.left < card.left - 1) {
        out.push({ check: 'out of its card', what: name(el), detail: name(a) });
      }
      break;
    }
  }
  const controls = all.filter(
    (el) => el.matches('input:not([type=hidden]),select,textarea,button,a[href]') && !inTabBar(el),
  );
  for (let i = 0; i < controls.length; i++) {
    for (let j = i + 1; j < controls.length; j++) {
      const a = controls[i]!;
      const b = controls[j]!;
      if (a.contains(b) || b.contains(a)) continue;
      const p = a.getBoundingClientRect();
      const q = b.getBoundingClientRect();
      const across = Math.min(p.right, q.right) - Math.max(p.left, q.left);
      const down = Math.min(p.bottom, q.bottom) - Math.max(p.top, q.top);
      if (across > 1 && down > 1) {
        out.push({
          check: 'controls overlap',
          what: `${name(a)} and ${name(b)}`,
          detail: `${Math.round(across)}×${Math.round(down)}px`,
        });
      }
    }
  }
  for (const el of all.filter((e) =>
    e.matches('input[type=date],input[type=time],input[type=number],select'),
  )) {
    const field = el as HTMLInputElement;
    if (field.value && field.scrollWidth > field.clientWidth + 1) {
      out.push({
        check: 'value cut off',
        what: name(el),
        detail: `${field.scrollWidth} in ${field.clientWidth}`,
      });
    }
  }
  for (const el of all.filter((e) =>
    e.matches('input[type=date],input[type=time],input[type=datetime-local]'),
  )) {
    if (getComputedStyle(el).appearance !== 'none') {
      out.push({
        check: 'date field drawn natively, which iOS widens past its column',
        what: name(el),
      });
    }
  }
  for (const el of controls) {
    const box = el.getBoundingClientRect();
    const inline =
      el.matches('a') &&
      el.closest('p,li,dd,td') !== null &&
      getComputedStyle(el).display === 'inline';
    const label = el.matches('input[type=radio],input[type=checkbox]') ? el.closest('label') : null;
    const throughLabel = label !== null && label.getBoundingClientRect().height >= 24;
    // A .tap link or button has a 44-point touch area drawn by its ::after.
    const height = el.classList.contains('tap') ? Math.max(box.height, 44) : box.height;
    if (!inline && !throughLabel && (height < 24 || box.width < 24)) {
      out.push({
        check: 'too small to tap',
        what: name(el),
        detail: `${Math.round(box.width)}×${Math.round(box.height)}`,
      });
    }
  }
  return out;
}

export function layoutProblems(page: Page): Promise<LayoutProblem[]> {
  return page.evaluate(findProblems);
}
