/**
 * Matrix glitch Easter egg: brief cascade of green characters
 * overlaid on the existing UI — as if the app is accidentally
 * revealing it's part of the Matrix.
 * Triggers randomly every 5–20 minutes, lasts ~2 seconds.
 */

import React, { useState, useEffect, useRef } from 'react';
import { Box, Text } from 'ink';

// Half-width katakana + digits + symbols — the Matrix look
const MATRIX_CHARS = 'ｦｱｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾅﾆﾇﾈﾊﾋﾎﾏﾐﾑﾒﾓﾔﾕﾗﾘﾜ0123456789@#$%&*=+<>';

function randomChar(): string {
  return MATRIX_CHARS[Math.floor(Math.random() * MATRIX_CHARS.length)];
}

interface Drop {
  x: number;
  row: number;
  char: string;
  brightness: number; // 1=dim, 2=bright, 3=white head
}

interface Column {
  x: number;
  head: number;
  speed: number;
  length: number;
}

interface MatrixGlitchProps {
  width: number;
  height: number;
  active: boolean;
}

export function MatrixGlitch({ width, height, active }: MatrixGlitchProps) {
  const [drops, setDrops] = useState<Drop[]>([]);
  const columnsRef = useRef<Column[]>([]);

  useEffect(() => {
    if (!active) {
      setDrops([]);
      return;
    }

    // Initialize 3–6 random columns
    const numCols = 3 + Math.floor(Math.random() * 4);
    const usedX = new Set<number>();
    const cols: Column[] = [];
    for (let i = 0; i < numCols; i++) {
      let x: number;
      do { x = Math.floor(Math.random() * width); } while (usedX.has(x));
      usedX.add(x);
      cols.push({
        x,
        head: -Math.floor(Math.random() * 5),
        speed: 1 + Math.random() * 0.5,
        length: 4 + Math.floor(Math.random() * 8),
      });
    }
    columnsRef.current = cols;

    const timer = setInterval(() => {
      const visible: Drop[] = [];

      for (const col of columnsRef.current) {
        col.head += col.speed;
        const headRow = Math.floor(col.head);

        for (let i = 0; i < col.length; i++) {
          const row = headRow - i;
          if (row >= 0 && row < height) {
            visible.push({
              x: col.x,
              row,
              char: randomChar(),
              brightness: i === 0 ? 3 : i < 3 ? 2 : 1,
            });
          }
        }
      }

      setDrops(visible);
    }, 80);

    return () => clearInterval(timer);
  }, [active, width, height]);

  if (!active || drops.length === 0) return null;

  // Render each drop as its own absolutely-positioned single character
  return (
    <>
      {drops.map((drop, i) => (
        <Box
          key={`${drop.x}-${drop.row}-${i}`}
          position="absolute"
          marginLeft={drop.x}
          marginTop={drop.row}
        >
          <Text
            color={drop.brightness === 3 ? '#ffffff' : drop.brightness === 2 ? '#00ff41' : '#005a15'}
            bold={drop.brightness === 3}
          >
            {drop.char}
          </Text>
        </Box>
      ))}
    </>
  );
}

/**
 * Hook: triggers the glitch effect randomly.
 * Returns whether the glitch is currently active.
 */
export function useMatrixGlitch(): boolean {
  const [active, setActive] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    function scheduleNext() {
      // Random delay: 5–20 minutes
      const delay = (5 + Math.random() * 15) * 60_000;
      timeoutRef.current = setTimeout(() => {
        setActive(true);
        // Glitch lasts 2–3 seconds
        const duration = 2000 + Math.random() * 1000;
        setTimeout(() => {
          setActive(false);
          scheduleNext();
        }, duration);
      }, delay);
    }

    scheduleNext();

    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  return active;
}
