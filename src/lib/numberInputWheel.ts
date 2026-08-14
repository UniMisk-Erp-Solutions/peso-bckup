import type { WheelEvent } from "react";

/**
 * Blurs a focused number input on wheel capture so the browser cannot
 * increment or decrement the value while the user is scrolling.
 *
 * Use as `onWheelCapture={blurFocusedNumberInputOnWheel}` on any
 * `<input type="number">` where accidental wheel changes would corrupt data.
 *
 * Rationale — why blur instead of preventDefault:
 *   Blurring removes the focused state before the browser acts on the wheel
 *   event. The wheel event continues to propagate normally, so the page still
 *   scrolls. Calling preventDefault alone would block scrolling; calling it
 *   with stopPropagation would block scrolling AND event propagation.
 *
 * Using onWheelCapture (capture phase) instead of onWheel (bubble phase)
 * means the field loses focus as early as possible in the event path.
 */
export function blurFocusedNumberInputOnWheel(
  event: WheelEvent<HTMLInputElement>,
): void {
  const input = event.currentTarget;

  if (document.activeElement === input) {
    input.blur();
  }
}
