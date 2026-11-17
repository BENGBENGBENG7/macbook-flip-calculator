/* Pure helpers for the home list gestures (swipe-to-delete + long-press
   multi-select). Kept free of React/DOM so they are unit-testable;
   App.tsx drives the touch handlers off these. */

const SWIPE_MIN_DX = 10;
const SWIPE_RATIO = 1.35;
const LONG_PRESS_MOVE = 10;

/** True once a horizontal drag is clearly a swipe, not a scroll. */
export function isSwipeIntent(dx: number, dy: number): boolean {
  return Math.abs(dx) >= SWIPE_MIN_DX && Math.abs(dx) > SWIPE_RATIO * Math.abs(dy);
}

/** True once a mostly-vertical drag is clearly a scroll. */
export function isScrollIntent(dx: number, dy: number): boolean {
  return Math.abs(dy) >= SWIPE_MIN_DX && Math.abs(dy) > Math.abs(dx);
}

/** True once the finger has moved enough that a long-press is off. */
export function movedEnough(dx: number, dy: number): boolean {
  return Math.abs(dx) > LONG_PRESS_MOVE || Math.abs(dy) > LONG_PRESS_MOVE;
}

/** Follow-the-finger offset, clamped so the row never slides past the
    revealed action width or right of its rest position. */
export function clampSwipeOffset(base: number, dx: number, maxOpen: number): number {
  return Math.max(-maxOpen, Math.min(0, base + dx));
}

/** Snap on release: past half the action width it stays open, else shut. */
export function snapSwipeOffset(offset: number, maxOpen: number): number {
  return offset < -maxOpen / 2 ? -maxOpen : 0;
}
