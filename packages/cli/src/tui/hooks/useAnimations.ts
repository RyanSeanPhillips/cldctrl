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

export function useSpinner(active: boolean, ms = 80): string {
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
