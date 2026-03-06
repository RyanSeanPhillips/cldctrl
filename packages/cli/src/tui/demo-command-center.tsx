/**
 * Demo renderer: final command center design.
 * Usage: npx tsx src/tui/demo-command-center.tsx
 */

import React from 'react';
import { Box, Text, render } from 'ink';
import { INK_COLORS, VERSION } from '../constants.js';

// ── Reusable visual components ───────────────────────────

const HEAT_CHARS = ' ░▒▓█';
const HEAT_COLORS = [INK_COLORS.border, '#1a4d1a', '#2d7a2d', '#3daa3d', '#4ddd4d'];
const DAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

function CalendarHeatmap({ title, data, width }: {
  title: string;
  data: number[][]; // weeks × 7 days, values 0-4
  width: number;
}) {
  return (
    <Box flexDirection="column">
      <Text bold color={INK_COLORS.accent}>{title}</Text>
      <Box>
        <Text color={INK_COLORS.textDim}>     </Text>
        {DAYS.map((d, i) => (
          <Text key={i} color={INK_COLORS.textDim}>{d}  </Text>
        ))}
      </Box>
      {data.map((week, wi) => (
        <Box key={wi}>
          <Text color={INK_COLORS.textDim}>{'W' + (wi + 1) + '   '}</Text>
          {week.map((v, di) => (
            <Text key={di} color={v === 0 ? INK_COLORS.border : HEAT_COLORS[v]}>
              {HEAT_CHARS[v]}{'  '}
            </Text>
          ))}
        </Box>
      ))}
      <Box>
        <Text color={INK_COLORS.textDim}>     </Text>
        <Text color={INK_COLORS.border}>░</Text>
        <Text color={INK_COLORS.textDim}> low  </Text>
        <Text color="#3daa3d">▓</Text>
        <Text color={INK_COLORS.textDim}> med  </Text>
        <Text color="#4ddd4d">█</Text>
        <Text color={INK_COLORS.textDim}> high</Text>
      </Box>
    </Box>
  );
}

function ProgressBar({ percent, width }: { percent: number; width: number }) {
  const barW = Math.max(4, width - 8);
  const filled = Math.round(barW * percent / 100);
  const empty = barW - filled;
  return (
    <Text>
      <Text color={INK_COLORS.accent}>{'█'.repeat(filled)}</Text>
      <Text color={INK_COLORS.border}>{'░'.repeat(empty)}</Text>
      <Text color={INK_COLORS.textDim}> {percent}%</Text>
    </Text>
  );
}

function ActivityTrace({ data, labels, color }: {
  data: number[];
  labels: string[];
  color: string;
}) {
  const max = Math.max(...data, 1);
  const bars = '░▁▂▃▄▅▆▇█';
  const line = data.map((v) =>
    bars[Math.min(bars.length - 1, Math.round((v / max) * (bars.length - 1)))]
  ).join('');
  return (
    <Box flexDirection="column">
      <Text color={color}>{line}</Text>
      <Text color={INK_COLORS.textDim}>{labels.join('')}</Text>
    </Box>
  );
}

function Header({ width }: { width: number }) {
  return (
    <Box width={width} paddingX={1} justifyContent="space-between">
      <Text>
        <Text color={INK_COLORS.accent}>▄</Text>
        <Text color="#e6963c">█</Text>
        <Text color={INK_COLORS.blue}>●</Text>
        <Text color="#e6963c">█</Text>
        <Text color={INK_COLORS.accent}>▄</Text>
        {'  '}
        <Text bold color={INK_COLORS.accent}>CLD</Text>
        <Text bold color={INK_COLORS.accentLight}> CTRL</Text>
      </Text>
      <Text>
        <Text color={INK_COLORS.green}>● 2 active</Text>
        <Text color={INK_COLORS.textDim}>  v{VERSION}</Text>
      </Text>
    </Box>
  );
}

function Sep({ width, label }: { width: number; label?: string }) {
  if (label) {
    const totalDash = Math.max(2, width - label.length - 6);
    const left = Math.floor(totalDash / 2);
    const right = totalDash - left;
    return (
      <Box paddingX={1}>
        <Text color={INK_COLORS.textDim}>{'─'.repeat(left)} </Text>
        <Text color={INK_COLORS.textDim}>{label}</Text>
        <Text color={INK_COLORS.textDim}> {'─'.repeat(right)}</Text>
      </Box>
    );
  }
  return (
    <Box paddingX={1}>
      <Text color={INK_COLORS.textDim}>{'─'.repeat(Math.max(1, width - 4))}</Text>
    </Box>
  );
}

// ── Mock data ────────────────────────────────────────────

const ALL_PROJECTS_HEAT = [
  [1, 2, 3, 4, 3, 1, 0],
  [2, 3, 4, 4, 3, 1, 0],
  [1, 3, 4, 3, 2, 0, 0],
  [2, 3, 0, 0, 0, 0, 0],
];

const PROJECT_HEAT = [
  [0, 1, 2, 3, 2, 0, 0],
  [1, 2, 3, 3, 2, 0, 0],
  [0, 2, 3, 2, 1, 0, 0],
  [1, 2, 0, 0, 0, 0, 0],
];

const COMMIT_HEAT = [
  [0, 0, 1, 2, 1, 0, 0],
  [0, 1, 2, 3, 1, 0, 0],
  [1, 1, 2, 1, 0, 0, 0],
  [0, 2, 0, 0, 0, 0, 0],
];

// Hourly trace data (24 buckets for a day, sparse — morning quiet, afternoon busy)
const HOURLY_SESSION = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 5, 8, 10, 8, 6, 3, 0, 0, 0, 0];

// ── View 1: Sessions tab selected ────────────────────────

function SessionsTabView({ width, height }: { width: number; height: number }) {
  const leftW = Math.floor(width * 0.4);
  const rightW = width - leftW;
  const bodyH = height - 3;

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Header width={width} />
      <Box flexDirection="row" height={bodyH}>
        {/* Left: Projects + global calendar */}
        <Box flexDirection="column" width={leftW} height={bodyH}
          borderStyle="single" borderColor={INK_COLORS.accent}>
          <Box paddingX={1}>
            <Text bold color={INK_COLORS.accent}>Projects</Text>
          </Box>

          <Box paddingX={1}>
            <Text color={INK_COLORS.text} backgroundColor={INK_COLORS.highlight} bold>
              › my-project [api]     main ✓
            </Text>
          </Box>
          <Box paddingX={2}>
            <Text color={INK_COLORS.green}>● auth-fix</Text>
            <Text color={INK_COLORS.textDim}> 47m 12.5k</Text>
          </Box>
          <Box paddingX={1}>
            <Text color={INK_COLORS.textDim}>  api-server            main ↑2</Text>
          </Box>
          <Box paddingX={2}>
            <Text color={INK_COLORS.green}>● navbar-fix</Text>
            <Text color={INK_COLORS.textDim}> 12m  3.2k</Text>
          </Box>
          <Box paddingX={1}>
            <Text color={INK_COLORS.textDim}>  docs-site             dev  ~3</Text>
          </Box>
          <Box paddingX={1}>
            <Text color={INK_COLORS.textDim}>  ─── Discovered ───</Text>
          </Box>
          <Box paddingX={1}>
            <Text color={INK_COLORS.textDim}>  old-project           main ✓</Text>
          </Box>

          <Box flexGrow={1} />

          <Sep width={leftW} />
          <Box paddingX={1} flexDirection="column">
            <CalendarHeatmap title="March 2026 — All Projects" data={ALL_PROJECTS_HEAT} width={leftW - 4} />
            <Box marginTop={1}>
              <Text color={INK_COLORS.text}>Today: 86 msgs · 2.1M tok · </Text>
              <Text color={INK_COLORS.green}>$5.20</Text>
            </Box>
            <ProgressBar percent={62} width={leftW - 4} />
          </Box>
        </Box>

        {/* Right: Project detail */}
        <Box flexDirection="column" width={rightW} height={bodyH}
          borderStyle="single" borderColor={INK_COLORS.border}>
          <Box paddingX={1}>
            <Text bold color={INK_COLORS.text}>my-project </Text>
            <Text color={INK_COLORS.accent}>[api] *</Text>
          </Box>
          <Box paddingX={1}>
            <Text color={INK_COLORS.green}>main ✓</Text>
            <Text color={INK_COLORS.textDim}> | </Text>
            <Text color={INK_COLORS.accent}>3 issues</Text>
            <Text color={INK_COLORS.textDim}> (</Text>
            <Text color={INK_COLORS.yellow}>⚠ 1 new</Text>
            <Text color={INK_COLORS.textDim}>)</Text>
          </Box>

          {/* Per-project calendar */}
          <Box paddingX={1}><Text> </Text></Box>
          <Box paddingX={1}>
            <CalendarHeatmap title="Usage — my-project" data={PROJECT_HEAT} width={rightW - 4} />
          </Box>

          {/* Active session */}
          <Box paddingX={1}><Text> </Text></Box>
          <Box paddingX={1} flexDirection="column">
            <Box>
              <Text color={INK_COLORS.green}>● </Text>
              <Text bold color={INK_COLORS.green}>ACTIVE</Text>
              <Text color={INK_COLORS.text}>  auth-middleware-fix</Text>
            </Box>
            <Box paddingX={2}>
              <Text color={INK_COLORS.textDim}>Editing src/middleware/auth.ts…  47m · 12.5k · 8w 3r 2bash</Text>
            </Box>
          </Box>

          {/* Tabs */}
          <Box paddingX={1}><Text> </Text></Box>
          <Box paddingX={1}>
            <Text bold color={INK_COLORS.accent}>[s] Sessions (5)</Text>
            <Text color={INK_COLORS.textDim}>  [c] Commits  [i] Issues (3)</Text>
          </Box>

          {/* Session list */}
          <Box paddingX={1}>
            <Text color={INK_COLORS.text} backgroundColor={INK_COLORS.highlight} bold>
              {'›'} auth-middleware-fix  </Text>
            <Text color={INK_COLORS.green} backgroundColor={INK_COLORS.highlight} bold>●LIVE</Text>
            <Text color={INK_COLORS.text} backgroundColor={INK_COLORS.highlight} bold>   Today    12.5k</Text>
          </Box>
          <Box paddingX={1}>
            <Text color={INK_COLORS.textDim}>  navbar-responsive                 2d ago    3.2k</Text>
          </Box>
          <Box paddingX={1}>
            <Text color={INK_COLORS.textDim}>  dark-mode-impl                    5d ago    8.1k</Text>
          </Box>

          {/* Preview: selected session + hourly trace */}
          <Box paddingX={1}><Text> </Text></Box>
          <Sep width={rightW} />
          <Box paddingX={1} flexDirection="column">
            <Box justifyContent="space-between">
              <Text bold color={INK_COLORS.text}>auth-middleware-fix</Text>
              <Text color={INK_COLORS.textDim}>Today · 47m · 12.5k tok · 47 msgs</Text>
            </Box>
            <Box paddingX={0} marginTop={0}>
              <ActivityTrace
                data={HOURLY_SESSION}
                labels={['12a       6a        12p       6p     now']}
                color={INK_COLORS.green}
              />
            </Box>
            <Text color={INK_COLORS.text} wrap="wrap">
              Implemented JWT auth middleware with refresh token rotation...
            </Text>
          </Box>
        </Box>
      </Box>

      <Box width={width} paddingX={1} justifyContent="space-between">
        <Text color={INK_COLORS.textDim}>j/k:nav  ←→:tabs  /:filter  n:new  ?:help  q:quit</Text>
        <Text color={INK_COLORS.accent}>86 msgs | 2.1M tok</Text>
      </Box>
    </Box>
  );
}

// ── View 2: Commits tab selected ─────────────────────────

function CommitsTabView({ width, height }: { width: number; height: number }) {
  const leftW = Math.floor(width * 0.4);
  const rightW = width - leftW;
  const bodyH = height - 3;

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Header width={width} />
      <Box flexDirection="row" height={bodyH}>
        {/* Left: same project list */}
        <Box flexDirection="column" width={leftW} height={bodyH}
          borderStyle="single" borderColor={INK_COLORS.border}>
          <Box paddingX={1}>
            <Text bold color={INK_COLORS.accent}>Projects</Text>
          </Box>
          <Box paddingX={1}>
            <Text color={INK_COLORS.text} backgroundColor={INK_COLORS.highlight} bold>
              › my-project [api]     main ✓
            </Text>
          </Box>
          <Box paddingX={2}>
            <Text color={INK_COLORS.green}>● auth-fix</Text>
            <Text color={INK_COLORS.textDim}> 47m 12.5k</Text>
          </Box>
          <Box paddingX={1}>
            <Text color={INK_COLORS.textDim}>  api-server            main ↑2</Text>
          </Box>
          <Box paddingX={1}>
            <Text color={INK_COLORS.textDim}>  docs-site             dev  ~3</Text>
          </Box>
          <Box paddingX={1}>
            <Text color={INK_COLORS.textDim}>  old-project           main ✓</Text>
          </Box>

          <Box flexGrow={1} />

          <Sep width={leftW} />
          <Box paddingX={1} flexDirection="column">
            <CalendarHeatmap title="March 2026 — All Projects" data={ALL_PROJECTS_HEAT} width={leftW - 4} />
            <Box marginTop={1}>
              <Text color={INK_COLORS.text}>Today: 86 msgs · 2.1M tok · </Text>
              <Text color={INK_COLORS.green}>$5.20</Text>
            </Box>
            <ProgressBar percent={62} width={leftW - 4} />
          </Box>
        </Box>

        {/* Right: Commits tab active */}
        <Box flexDirection="column" width={rightW} height={bodyH}
          borderStyle="single" borderColor={INK_COLORS.accent}>
          <Box paddingX={1}>
            <Text bold color={INK_COLORS.text}>my-project </Text>
            <Text color={INK_COLORS.accent}>[api] *</Text>
          </Box>
          <Box paddingX={1}>
            <Text color={INK_COLORS.green}>main ✓</Text>
            <Text color={INK_COLORS.textDim}> | </Text>
            <Text color={INK_COLORS.accent}>3 issues</Text>
          </Box>

          {/* Commit calendar instead of usage calendar */}
          <Box paddingX={1}><Text> </Text></Box>
          <Box paddingX={1}>
            <CalendarHeatmap title="Commits — my-project" data={COMMIT_HEAT} width={rightW - 4} />
          </Box>

          {/* Active session (stays visible) */}
          <Box paddingX={1}><Text> </Text></Box>
          <Box paddingX={1}>
            <Text color={INK_COLORS.green}>● </Text>
            <Text bold color={INK_COLORS.green}>ACTIVE</Text>
            <Text color={INK_COLORS.textDim}>  auth-middleware-fix · Edit auth.ts… · 47m</Text>
          </Box>

          {/* Tabs — Commits active */}
          <Box paddingX={1}><Text> </Text></Box>
          <Box paddingX={1}>
            <Text color={INK_COLORS.textDim}>[s] Sessions (5)  </Text>
            <Text bold color={INK_COLORS.accent}>[c] Commits</Text>
            <Text color={INK_COLORS.textDim}>  [i] Issues (3)</Text>
          </Box>

          {/* Commit list */}
          <Box paddingX={1}>
            <Text color={INK_COLORS.text} backgroundColor={INK_COLORS.highlight} bold>
              {'›'} 2h ago  fix auth middleware          </Text>
            <Text color={INK_COLORS.green} backgroundColor={INK_COLORS.highlight} bold>+89 </Text>
            <Text color={INK_COLORS.red} backgroundColor={INK_COLORS.highlight} bold>-34</Text>
          </Box>
          <Box paddingX={1}>
            <Text color={INK_COLORS.textDim}>  5h ago  add rate limiting            </Text>
            <Text color={INK_COLORS.green}>+142</Text>
            <Text color={INK_COLORS.red}>-12</Text>
          </Box>
          <Box paddingX={1}>
            <Text color={INK_COLORS.textDim}>  1d ago  refactor user model          </Text>
            <Text color={INK_COLORS.green}>+203</Text>
            <Text color={INK_COLORS.red}>-87</Text>
          </Box>
          <Box paddingX={1}>
            <Text color={INK_COLORS.textDim}>  3d ago  add user endpoints           </Text>
            <Text color={INK_COLORS.green}>+312</Text>
            <Text color={INK_COLORS.red}>-45</Text>
          </Box>

          {/* Commit detail preview */}
          <Box paddingX={1}><Text> </Text></Box>
          <Sep width={rightW} />
          <Box paddingX={1} flexDirection="column">
            <Text bold color={INK_COLORS.text}>fix auth middleware</Text>
            <Text color={INK_COLORS.textDim}>2h ago · abc1234 · 3 files changed</Text>
            <Box marginTop={0}>
              <Text color={INK_COLORS.green}>+89 </Text>
              <Text color={INK_COLORS.red}>-34  </Text>
              <Text color={INK_COLORS.green}>{'█'.repeat(12)}</Text>
              <Text color={INK_COLORS.red}>{'█'.repeat(5)}</Text>
              <Text color={INK_COLORS.border}>{'░'.repeat(8)}</Text>
            </Box>
            <Box paddingX={1} marginTop={0} flexDirection="column">
              <Box>
                <Text color={INK_COLORS.textDim}>src/middleware/auth.ts    </Text>
                <Text color={INK_COLORS.green}>+52 </Text>
                <Text color={INK_COLORS.red}>-18</Text>
              </Box>
              <Box>
                <Text color={INK_COLORS.textDim}>src/routes/login.ts      </Text>
                <Text color={INK_COLORS.green}>+30 </Text>
                <Text color={INK_COLORS.red}>-12</Text>
              </Box>
              <Box>
                <Text color={INK_COLORS.textDim}>tests/auth.test.ts       </Text>
                <Text color={INK_COLORS.green}>+7  </Text>
                <Text color={INK_COLORS.red}>-4</Text>
              </Box>
            </Box>
          </Box>
        </Box>
      </Box>

      <Box width={width} paddingX={1} justifyContent="space-between">
        <Text color={INK_COLORS.textDim}>j/k:nav  ←→:tabs  /:filter  n:new  ?:help  q:quit</Text>
        <Text color={INK_COLORS.accent}>86 msgs | 2.1M tok</Text>
      </Box>
    </Box>
  );
}

// ── View 3: Issues tab selected ──────────────────────────

function IssuesTabView({ width, height }: { width: number; height: number }) {
  const leftW = Math.floor(width * 0.4);
  const rightW = width - leftW;
  const bodyH = height - 3;

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Header width={width} />
      <Box flexDirection="row" height={bodyH}>
        {/* Left pane */}
        <Box flexDirection="column" width={leftW} height={bodyH}
          borderStyle="single" borderColor={INK_COLORS.border}>
          <Box paddingX={1}>
            <Text bold color={INK_COLORS.accent}>Projects</Text>
          </Box>
          <Box paddingX={1}>
            <Text color={INK_COLORS.text} backgroundColor={INK_COLORS.highlight} bold>
              › my-project [api]     main ✓
            </Text>
          </Box>
          <Box paddingX={2}>
            <Text color={INK_COLORS.green}>● auth-fix</Text>
            <Text color={INK_COLORS.textDim}> 47m 12.5k</Text>
          </Box>
          <Box paddingX={1}>
            <Text color={INK_COLORS.textDim}>  api-server            main ↑2</Text>
          </Box>
          <Box paddingX={1}>
            <Text color={INK_COLORS.textDim}>  docs-site             dev  ~3</Text>
          </Box>
          <Box paddingX={1}>
            <Text color={INK_COLORS.textDim}>  old-project           main ✓</Text>
          </Box>

          <Box flexGrow={1} />

          <Sep width={leftW} />
          <Box paddingX={1} flexDirection="column">
            <CalendarHeatmap title="March 2026 — All Projects" data={ALL_PROJECTS_HEAT} width={leftW - 4} />
            <Box marginTop={1}>
              <Text color={INK_COLORS.text}>Today: 86 msgs · 2.1M tok · </Text>
              <Text color={INK_COLORS.green}>$5.20</Text>
            </Box>
            <ProgressBar percent={62} width={leftW - 4} />
          </Box>
        </Box>

        {/* Right: Issues tab */}
        <Box flexDirection="column" width={rightW} height={bodyH}
          borderStyle="single" borderColor={INK_COLORS.accent}>
          <Box paddingX={1}>
            <Text bold color={INK_COLORS.text}>my-project </Text>
            <Text color={INK_COLORS.accent}>[api] *</Text>
          </Box>
          <Box paddingX={1}>
            <Text color={INK_COLORS.green}>main ✓</Text>
            <Text color={INK_COLORS.textDim}> | </Text>
            <Text color={INK_COLORS.accent}>3 issues</Text>
            <Text color={INK_COLORS.textDim}> (</Text>
            <Text color={INK_COLORS.yellow}>⚠ 1 new</Text>
            <Text color={INK_COLORS.textDim}>)</Text>
          </Box>

          {/* Per-project usage calendar */}
          <Box paddingX={1}><Text> </Text></Box>
          <Box paddingX={1}>
            <CalendarHeatmap title="Usage — my-project" data={PROJECT_HEAT} width={rightW - 4} />
          </Box>

          {/* Active session (condensed) */}
          <Box paddingX={1}><Text> </Text></Box>
          <Box paddingX={1}>
            <Text color={INK_COLORS.green}>● </Text>
            <Text bold color={INK_COLORS.green}>ACTIVE</Text>
            <Text color={INK_COLORS.textDim}>  auth-middleware-fix · Edit auth.ts… · 47m</Text>
          </Box>

          {/* Tabs — Issues active */}
          <Box paddingX={1}><Text> </Text></Box>
          <Box paddingX={1}>
            <Text color={INK_COLORS.textDim}>[s] Sessions (5)  [c] Commits  </Text>
            <Text bold color={INK_COLORS.accent}>[i] Issues (3)</Text>
          </Box>

          {/* Issue list */}
          <Box paddingX={1}>
            <Text color={INK_COLORS.text} backgroundColor={INK_COLORS.highlight} bold>
              {'›'} </Text>
            <Text color={INK_COLORS.yellow} backgroundColor={INK_COLORS.highlight} bold>NEW </Text>
            <Text color={INK_COLORS.accent} backgroundColor={INK_COLORS.highlight} bold>#42 </Text>
            <Text color={INK_COLORS.text} backgroundColor={INK_COLORS.highlight} bold>
              Login fails on Safari with 2FA
            </Text>
          </Box>
          <Box paddingX={1}>
            <Text color={INK_COLORS.textDim}>       </Text>
            <Text color={INK_COLORS.accent}>#38 </Text>
            <Text color={INK_COLORS.textDim}>Add dark mode support</Text>
          </Box>
          <Box paddingX={1}>
            <Text color={INK_COLORS.textDim}>       </Text>
            <Text color={INK_COLORS.accent}>#35 </Text>
            <Text color={INK_COLORS.textDim}>Improve error messages for config</Text>
          </Box>

          {/* Issue detail preview */}
          <Box paddingX={1}><Text> </Text></Box>
          <Sep width={rightW} />
          <Box paddingX={1} flexDirection="column">
            <Box>
              <Text color={INK_COLORS.yellow}>NEW  </Text>
              <Text bold color={INK_COLORS.accent}>#42</Text>
            </Box>
            <Text bold color={INK_COLORS.text}>Login fails on Safari with 2FA enabled</Text>
            <Text color={INK_COLORS.text} wrap="wrap">
              Users report that 2FA login flow breaks on Safari 17+ due to
              WebAuthn API changes. The credential.get() promise never resolves...
            </Text>
            <Box marginTop={0}>
              <Text color={INK_COLORS.textDim}>Labels: </Text>
              <Text color={INK_COLORS.red}>bug</Text>
              <Text color={INK_COLORS.textDim}>, </Text>
              <Text color={INK_COLORS.yellow}>priority</Text>
            </Box>
            <Text color={INK_COLORS.textDim}>Created: Mar 1, 2026</Text>
          </Box>
        </Box>
      </Box>

      <Box width={width} paddingX={1} justifyContent="space-between">
        <Text color={INK_COLORS.textDim}>j/k:nav  ←→:tabs  Enter:fix with Claude  ?:help  q:quit</Text>
        <Text color={INK_COLORS.accent}>86 msgs | 2.1M tok</Text>
      </Box>
    </Box>
  );
}

// ── Main ─────────────────────────────────────────────────

function Demo() {
  const w = Math.min(process.stdout.columns || 120, 120);
  const h = 32;

  return (
    <Box flexDirection="column">
      <Box marginBottom={1} paddingX={1}>
        <Text bold color={INK_COLORS.accent}>═══ VIEW 1: Sessions Tab (with hourly activity trace) ═══</Text>
      </Box>
      <SessionsTabView width={w} height={h} />

      <Box marginY={1} paddingX={1}>
        <Text bold color={INK_COLORS.accent}>═══ VIEW 2: Commits Tab (with commit calendar + file diff) ═══</Text>
      </Box>
      <CommitsTabView width={w} height={h} />

      <Box marginY={1} paddingX={1}>
        <Text bold color={INK_COLORS.accent}>═══ VIEW 3: Issues Tab (with issue detail) ═══</Text>
      </Box>
      <IssuesTabView width={w} height={h} />
    </Box>
  );
}

const instance = render(<Demo />);
setTimeout(() => {
  instance.unmount();
}, 100);
