// Toasts, confetti and the unlock banner. Per-move praise is throttled; big
// moments always land. Reduced motion keeps the words and drops the movement.

const GOOD_WORDS = ['Nice.', 'Good one.', 'Sharp.', 'Clean.', 'Yes.', 'Spot on.', 'Neat.', 'Right on.'];
const UNIT_NAMES = { row: 'Row', col: 'Column', box: 'Box' };
const DIGIT_WORDS = ['', '1s', '2s', '3s', '4s', '5s', '6s', '7s', '8s', '9s'];
const STREAK_WORDS = { 5: 'on fire', 10: 'unstoppable', 15: 'in the zone' };

const MOVE_TOAST_GAP_MS = 6000;
const MOVE_TOAST_CHANCE = 0.35;
const TOAST_MS = 2200;
const MAX_TOASTS = 3;

export class Praise {
  constructor({ toasts, confetti, banner, bannerText, bannerPlay, bannerClose }) {
    this.toastsEl = toasts;
    this.confettiEl = confetti;
    this.bannerEl = banner;
    this.bannerText = bannerText;
    this.bannerPlay = bannerPlay;
    this.lastMoveToast = 0;
    this.bannerTimer = null;
    this.onBannerPlay = null;
    this.motionQuery = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');

    bannerPlay.addEventListener('click', () => {
      const play = this.onBannerPlay;
      this.hideBanner();
      play?.();
    });
    bannerClose.addEventListener('click', () => this.hideBanner());
  }

  get reducedMotion() { return Boolean(this.motionQuery?.matches); }

  toast(text, { kind = 'info' } = {}) {
    const el = document.createElement('div');
    el.className = `toast toast-${kind}`;
    el.textContent = text;
    this.toastsEl.append(el);
    while (this.toastsEl.children.length > MAX_TOASTS) this.toastsEl.firstChild.remove();
    setTimeout(() => {
      el.classList.add('leaving');
      setTimeout(() => el.remove(), this.reducedMotion ? 0 : 300);
    }, TOAST_MS);
  }

  /** A correct digit: only sometimes worth a word. */
  goodMove() {
    const now = Date.now();
    if (now - this.lastMoveToast < MOVE_TOAST_GAP_MS || Math.random() > MOVE_TOAST_CHANCE) return;
    this.lastMoveToast = now;
    this.toast(GOOD_WORDS[Math.floor(Math.random() * GOOD_WORDS.length)], { kind: 'good' });
  }

  // Big moments reset the per-move throttle so they don't get stacked on.
  #big(text, kind = 'good') {
    this.lastMoveToast = Date.now();
    this.toast(text, { kind });
  }

  unitComplete(unit) {
    this.#big(`${UNIT_NAMES[unit.type]} ${unit.index + 1} complete.`);
  }

  digitComplete(d) {
    this.#big(`All the ${DIGIT_WORDS[d]} are home.`);
  }

  streak(count) {
    const word = STREAK_WORDS[count] ?? 'keep going';
    this.#big(`${count} in a row — ${word}.`, 'streak');
  }

  confetti() {
    if (this.reducedMotion) return;
    const colors = ['--confetti-1', '--confetti-2', '--confetti-3', '--confetti-4', '--confetti-5'];
    const frag = document.createDocumentFragment();
    for (let k = 0; k < 90; k++) {
      const p = document.createElement('i');
      p.style.setProperty('--x', `${Math.random() * 100}vw`);
      p.style.setProperty('--drift', `${(Math.random() - 0.5) * 30}vw`);
      p.style.setProperty('--spin', `${(Math.random() - 0.5) * 1440}deg`);
      p.style.setProperty('--fall', `${2 + Math.random() * 1.8}s`);
      p.style.setProperty('--wait', `${Math.random() * 0.5}s`);
      p.style.setProperty('--color', `var(${colors[k % colors.length]})`);
      frag.append(p);
    }
    this.confettiEl.replaceChildren(frag);
    setTimeout(() => this.confettiEl.replaceChildren(), 4500);
  }

  banner(text, onPlay) {
    this.bannerText.textContent = text;
    this.onBannerPlay = onPlay;
    this.bannerPlay.hidden = !onPlay;
    this.bannerEl.hidden = false;
    clearTimeout(this.bannerTimer);
    this.bannerTimer = setTimeout(() => this.hideBanner(), 12000);
  }

  hideBanner() {
    clearTimeout(this.bannerTimer);
    this.bannerEl.hidden = true;
    this.onBannerPlay = null;
  }
}
