/**
 * Shared animation hooks for live UI feedback.
 *
 * - usePulse: boolean that toggles on an interval (for pulsing indicators)
 * - useClock: ticking clock string
 * - useSpinner: cycling braille spinner for "thinking" state
 */

import { useState, useEffect, useRef } from 'react';

/**
 * Returns a boolean that alternates every `ms` milliseconds.
 * Use to pulse indicators between bright/dim states.
 */
export function usePulse(ms = 800): boolean {
  const [on, setOn] = useState(true);
  useEffect(() => {
    const timer = setInterval(() => setOn(v => !v), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return on;
}

/**
 * Returns a ticking clock string (HH:MM:SS), updates every second.
 */
export function useClock(): string {
  const [time, setTime] = useState(() => formatTime());
  useEffect(() => {
    const timer = setInterval(() => {
      setTime(formatTime());
    }, 1000);
    return () => clearInterval(timer);
  }, []);
  return time;
}

function formatTime(): string {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, '0');
  const m = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

/**
 * Returns cycling frames for a thinking/spinner animation.
 * Frames: ⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏
 */
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** Claude Code-style sparkle spinner: · ✻ ✽ ✶ ✳ ✢ (first/last hold longer for easing) */
const CLAUDE_SPINNER_FRAMES = ['·', '·', '✻', '✽', '✶', '✳', '✢', '✢'];

/**
 * Animated counter that smoothly counts up from previous value to target.
 * Uses ease-out curve for a natural deceleration effect.
 */
export function useAnimatedCounter(target: number, durationMs = 1200): number {
  const [display, setDisplay] = useState(0);
  const startRef = useRef({ value: 0, target: 0, startTime: 0 });
  const rafRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Skip animation for zero or same value
    if (target === startRef.current.target && display === target) return;

    const from = display;
    startRef.current = { value: from, target, startTime: Date.now() };

    const tick = () => {
      const elapsed = Date.now() - startRef.current.startTime;
      const progress = Math.min(1, elapsed / durationMs);
      // Ease-out cubic: decelerates naturally
      const eased = 1 - Math.pow(1 - progress, 3);
      const current = Math.round(from + (target - from) * eased);
      setDisplay(current);

      if (progress < 1) {
        rafRef.current = setTimeout(tick, 32); // ~30fps
      }
    };
    tick();

    return () => {
      if (rafRef.current) clearTimeout(rafRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, durationMs]);

  return display;
}

export function useSpinner(active: boolean, ms = 150): string {
  const [frame, setFrame] = useState(0);
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      if (activeRef.current) {
        setFrame(f => (f + 1) % SPINNER_FRAMES.length);
      }
    }, ms);
    return () => clearInterval(timer);
  }, [active, ms]);

  return active ? SPINNER_FRAMES[frame] : '';
}

/** Claude Code-style sparkle spinner: · ✻ ✽ ✶ ✳ ✢ with easing hold on first/last */
export function useClaudeSpinner(active: boolean, ms = 120): string {
  const [frame, setFrame] = useState(0);
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      if (activeRef.current) {
        setFrame(f => (f + 1) % CLAUDE_SPINNER_FRAMES.length);
      }
    }, ms);
    return () => clearInterval(timer);
  }, [active, ms]);

  return active ? CLAUDE_SPINNER_FRAMES[frame] : '';
}
