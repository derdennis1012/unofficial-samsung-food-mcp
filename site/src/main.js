// Progressive enhancement only. Every element in the HTML is already in its finished, visible
// state; this script adds motion on top. Without JS, with reduced motion, or if anything here
// fails, the page is complete.
//   ?demo=final   skip the hero animation (used for screenshots)

const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const finalOnly = new URLSearchParams(location.search).get('demo') === 'final';
const EASE = 'cubic-bezier(.2,.75,.15,1)';
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* ------------------------------------------------------------------ nav hairline */
const nav = document.querySelector('[data-nav]');
const onScroll = () => nav?.classList.toggle('!border-line', scrollY > 8);
addEventListener('scroll', onScroll, { passive: true });
onScroll();

/* ------------------------------------------------------------------ copy buttons */
for (const btn of $$('[data-copy]')) {
  btn.addEventListener('click', async () => {
    const src = btn.parentElement.querySelector('[data-copy-src]');
    try {
      await navigator.clipboard.writeText(src.innerText.trim());
      btn.textContent = 'Copied';
    } catch {
      getSelection().selectAllChildren(src);
      btn.textContent = 'Press ⌘C';
    }
    setTimeout(() => (btn.textContent = 'Copy'), 1600);
  });
}

/* ------------------------------------------------------------------ motion on enter
   The animation only runs once an element is (almost) on screen, and it animates *from* a
   hidden state *to* the normal one with fill: backwards. Outside a running animation nothing
   is ever hidden, so a missed observer callback cannot blank a section. */
function onEnter(els, fn, { margin = '0px 0px 8% 0px', threshold = 0 } = {}) {
  if (!('IntersectionObserver' in window)) return;
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        io.unobserve(e.target);
        fn(e.target);
      }
    },
    { rootMargin: margin, threshold }
  );
  els.forEach((el) => io.observe(el));
}

if (!reduce) {
  onEnter($$('[data-reveal]'), (el) => {
    // Jumped or scrolled fast past the entry point: it is already being read, do not fade it.
    if (scrollY > 0 && el.getBoundingClientRect().top < innerHeight * 0.6) return;
    const delay = parseFloat(getComputedStyle(el).getPropertyValue('--d')) || 0;
    el.animate([{ opacity: 0, transform: 'translateY(26px)' }, { opacity: 1, transform: 'none' }], { duration: 900, delay, easing: EASE, fill: 'backwards' });
  });

  onEnter($$('[data-matrix]'), (el) => {
    $$('.cell', el).forEach((c, i) =>
      c.animate([{ opacity: 0, transform: 'scale(.2)' }, { opacity: 1, transform: 'none' }], { duration: 500, delay: 250 + i * 9, easing: 'cubic-bezier(.34,1.4,.5,1)', fill: 'backwards' })
    );
  });

  onEnter($$('.tl'), (el) => {
    $$('.tl-item', el).forEach((it, i) => {
      const up = it.classList.contains('tl-up');
      it.animate([{ opacity: 0, transform: `translateY(${up ? 14 : -14}px)` }, { opacity: 1, transform: 'none' }], { duration: 700, delay: 300 + i * 140, easing: EASE, fill: 'backwards' });
    });
    const today = el.querySelector('.tl-today');
    today?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 600, delay: 150, fill: 'backwards' });
  });
}

/* ------------------------------------------------------------------ pausable clock */
class Clock {
  paused = false;
  wait(ms) {
    return new Promise((resolve) => {
      let left = ms;
      let last = performance.now();
      const tick = (t) => {
        if (!this.paused) left -= t - last;
        last = t;
        if (left <= 0) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }
}

/* ------------------------------------------------------------------ hero demo */
function heroDemo() {
  const root = document.querySelector('[data-demo]');
  if (!root) return;
  const clock = new Clock();
  const steps = (k) => $$(`[data-step="${k}"]`, root);
  const slots = $$('[data-slot]:not([data-slot="pre"])', root);
  const pre = root.querySelector('[data-slot="pre"]');
  const groceries = $$('[data-g]', root);
  const composer = root.querySelector('[data-composer]');
  const count = (k) => root.querySelector(`[data-count="${k}"]`);
  const userText = steps('user')[0].textContent.trim();

  // Split the final reply into words so it can "stream".
  const stream = root.querySelector('[data-stream]');
  stream.innerHTML = stream.textContent
    .trim()
    .split(/\s+/)
    .map((w) => `<span class="w">${w}</span>`)
    .join(' ');
  const words = $$('.w', stream);

  const show = (els) => els.forEach((e) => e.classList.remove('is-pending'));
  const hide = (els) => els.forEach((e) => e.classList.add('is-pending'));

  function reset() {
    hide($$('[data-step]', root));
    hide(words);
    $$('.chip', root).forEach((c) => c.classList.remove('is-running'));
    slots.forEach((s) => s.classList.add('is-empty'));
    hide(groceries);
    count('plan').textContent = '0';
    count('items').textContent = '0';
    count('list').textContent = '0';
    composer.textContent = 'Reply…';
    composer.classList.remove('text-ink', 'caret');
  }

  async function tool(chip, ms, during) {
    chip.classList.remove('is-pending');
    chip.classList.add('is-running');
    if (during) await during();
    else await clock.wait(ms);
    chip.classList.remove('is-running');
    await clock.wait(220);
  }

  async function run() {
    reset();
    await clock.wait(900);
    composer.classList.add('text-ink', 'caret');
    composer.textContent = '';
    for (const ch of userText) {
      composer.textContent += ch;
      await clock.wait(ch === ' ' ? 34 : 22);
    }
    await clock.wait(380);
    composer.textContent = 'Reply…';
    composer.classList.remove('text-ink', 'caret');
    show(steps('user'));
    await clock.wait(700);
    show(steps('a1'));
    await clock.wait(600);

    await tool(steps('c1')[0], 800);
    pre.classList.add('is-flash');
    setTimeout(() => pre.classList.remove('is-flash'), 900);
    await tool(steps('c2')[0], 700);
    await tool(steps('c3')[0], 800);
    await tool(steps('c4')[0], 0, async () => {
      for (const [i, s] of slots.entries()) {
        s.classList.remove('is-empty');
        count('plan').textContent = String(i + 1);
        await clock.wait(430);
      }
    });
    await tool(steps('c5')[0], 0, async () => {
      for (const [i, g] of groceries.entries()) {
        g.classList.remove('is-pending');
        count('items').textContent = count('list').textContent = String(i + 1);
        await clock.wait(150);
      }
    });
    show(steps('a2'));
    show(steps('tpl'));
    for (const w of words) {
      w.classList.remove('is-pending');
      await clock.wait(38);
    }
    await clock.wait(7000);
  }

  // Pause while hovered or focused, while off screen, or when the visitor pressed pause.
  const toggle = document.querySelector('[data-demo-toggle]');
  const state = { hover: false, focus: false, user: false, offscreen: true };
  const sync = () => {
    clock.paused = state.hover || state.focus || state.user || state.offscreen;
  };
  const fig = root.closest('figure');
  fig.addEventListener('mouseenter', () => ((state.hover = true), sync()));
  fig.addEventListener('mouseleave', () => ((state.hover = false), sync()));
  root.addEventListener('focusin', () => ((state.focus = true), sync()));
  root.addEventListener('focusout', () => ((state.focus = false), sync()));
  toggle?.addEventListener('click', () => {
    state.user = !state.user;
    toggle.setAttribute('aria-pressed', String(state.user));
    toggle.querySelector('[data-label]').textContent = state.user ? 'Play animation' : 'Pause animation';
    toggle.querySelector('[data-icon="pause"]').classList.toggle('hidden', state.user);
    toggle.querySelector('[data-icon="play"]').classList.toggle('hidden', !state.user);
    sync();
  });
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(([e]) => ((state.offscreen = !e.isIntersecting), sync())).observe(root);
  } else state.offscreen = false;
  sync();

  const grid = root.firstElementChild;
  (async () => {
    for (;;) {
      await run();
      await grid.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 350, easing: 'ease-in', fill: 'forwards' }).finished;
      reset();
      grid.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 350, easing: 'ease-out' });
      grid.getAnimations().forEach((a) => a.playState === 'finished' && a.cancel());
    }
  })();
}

/* ------------------------------------------------------------------ import demo
   The recipe card itself is never hidden: title, picture and meta stay put. Only the details
   (URL typing, tool chip, ingredient lines, similar recipes) replay, and only if the demo
   comes into view from below, i.e. before anyone has seen its finished state. */
function importDemo() {
  const root = document.querySelector('[data-import]');
  if (!root || !('IntersectionObserver' in window)) return;
  const url = root.querySelector('[data-url]');
  const btn = root.querySelector('[data-imp-btn]');
  const thumb = root.querySelector('[data-imp="thumb"]');
  const full = url.textContent;
  const parts = (k) => $$(`[data-imp="${k}"]`, root);
  const clock = new Clock();
  let done = false;

  const io = new IntersectionObserver(
    async ([e]) => {
      if (!e.isIntersecting || done) return;
      done = true;
      io.disconnect();
      // Already well inside the viewport (fast scroll, jump link): leave the finished state.
      if (e.boundingClientRect.top < innerHeight * 0.55) return;
      const details = ['chip', 'saved', 'ing', 'sim'].flatMap(parts);
      details.forEach((el) => el.classList.add('is-pending'));
      url.textContent = 'https://';
      url.classList.add('caret');
      await clock.wait(350);
      for (const ch of full.slice(8)) {
        url.textContent += ch;
        await clock.wait(16);
      }
      url.classList.remove('caret');
      await clock.wait(200);
      btn.style.transform = 'scale(.94)';
      await clock.wait(140);
      btn.style.transform = '';
      parts('chip').forEach((el) => el.classList.remove('is-pending'));
      thumb.animate([{ transform: 'rotate(-40deg) scale(.92)' }, { transform: 'none' }], { duration: 900, easing: 'cubic-bezier(.34,1.4,.5,1)' });
      await clock.wait(300);
      parts('saved').forEach((el) => el.classList.remove('is-pending'));
      for (const el of parts('ing')) {
        el.classList.remove('is-pending');
        await clock.wait(55);
      }
      await clock.wait(300);
      for (const el of parts('sim')) {
        el.classList.remove('is-pending');
        await clock.wait(130);
      }
    },
    { threshold: 0 }
  );
  io.observe(root);
}

if (!reduce && !finalOnly) {
  heroDemo();
  importDemo();
}
