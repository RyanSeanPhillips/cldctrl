"""
Claude Code Context Window Analysis
====================================
Analyzes your Claude Code JSONL session files to visualize how the 1M context
window change (March 13, 2026) affects token usage, context growth, and cache behavior.

Requirements: pip install matplotlib numpy

Usage:
  python context_analysis.py                  # auto-detects Claude data dir
  python context_analysis.py /path/to/.claude # explicit path to .claude folder

The script reads ONLY token counts from JSONL files (no conversation content).
Output: context_analysis.png in the current directory.
"""

import os
import re
import sys
import platform
from datetime import datetime, timezone, timedelta
from pathlib import Path

try:
    import matplotlib.pyplot as plt
    import matplotlib.dates as mdates
    import numpy as np
except ImportError:
    print("This script requires matplotlib and numpy.")
    print("Install them with: pip install matplotlib numpy")
    sys.exit(1)

# ── Find Claude Code data directory ──
def resolve_projects_dir(path_str):
    """Try to resolve a user-provided path to the projects directory."""
    p = Path(path_str).expanduser()
    # They might point at .claude, .claude/projects, or the home dir
    for candidate in [p / '.claude' / 'projects', p / 'projects', p]:
        if candidate.exists() and any(candidate.iterdir()):
            return candidate
    return None

def find_claude_dir():
    """Auto-detect the .claude/projects directory, or ask the user."""
    # Check command-line argument first
    if len(sys.argv) > 1:
        result = resolve_projects_dir(sys.argv[1])
        if result:
            return result
        print(f"Could not find Claude Code session data at: {sys.argv[1]}")
        print()

    # Platform-specific defaults
    if platform.system() == 'Windows':
        home = Path(os.environ.get('USERPROFILE', os.path.expanduser('~')))
    else:
        home = Path.home()

    claude_dir = home / '.claude' / 'projects'
    if claude_dir.exists() and any(claude_dir.iterdir()):
        return claude_dir

    # Auto-detection failed — ask the user
    print("Could not auto-detect your Claude Code data directory.")
    print()
    print("Claude Code stores session data in ~/.claude/projects/")
    print("  Windows: C:\\Users\\<you>\\.claude\\projects\\")
    print("  macOS:   /Users/<you>/.claude/projects/")
    print("  Linux:   /home/<you>/.claude/projects/")
    print()

    while True:
        try:
            user_path = input("Enter the path to your .claude directory (or 'q' to quit): ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            sys.exit(0)

        if user_path.lower() in ('q', 'quit', 'exit'):
            sys.exit(0)

        result = resolve_projects_dir(user_path)
        if result:
            return result
        print(f"  No session data found at '{user_path}'. Please try again.")
        print()

projects_dir = find_claude_dir()
print(f"Reading sessions from: {projects_dir}")

# ── Configuration ──
# The 1M context window rolled out on March 13, 2026
LOCAL_TZ = timezone(timedelta(seconds=-datetime.now().astimezone().utcoffset().total_seconds()))
CONTEXT_1M_DATE = datetime(2026, 3, 13, tzinfo=LOCAL_TZ)
OLD_LIMIT = 200       # old context window (K tokens)
OLD_COMPACTION = 160   # old auto-compaction trigger (K tokens, ~80% of limit)
NEW_LIMIT = 1000       # new context window (K tokens)

plt.style.use('dark_background')
BG = '#0d1117'
PANEL_BG = '#161b22'
GRID_COLOR = '#30363d'
TEXT_COLOR = '#e6edf3'
SUBTLE = '#8b949e'
plt.rcParams.update({
    'figure.facecolor': BG, 'axes.facecolor': PANEL_BG,
    'axes.edgecolor': GRID_COLOR, 'axes.labelcolor': TEXT_COLOR,
    'text.color': TEXT_COLOR, 'xtick.color': SUBTLE, 'ytick.color': SUBTLE,
    'grid.color': GRID_COLOR, 'grid.alpha': 0.3,
    'legend.facecolor': '#21262d', 'legend.edgecolor': GRID_COLOR,
})

RAINBOW = [
    '#ff6b6b', '#ff9f43', '#feca57', '#48dbfb', '#0abde3',
    '#55efc4', '#a29bfe', '#fd79a8', '#6c5ce7', '#00cec9',
]


def parse_session(fp):
    turns = []
    user_prompts = []
    current_prompt_turns = []
    current_prompt_start = None
    prev_ts = None
    with open(fp, 'r', encoding='utf-8', errors='ignore') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            type_match = re.search(r'"type"\s*:\s*"(human|assistant|user)"', line)
            if not type_match:
                continue
            msg_type = type_match.group(1)
            ts_match = re.search(r'"timestamp"\s*:\s*"([^"]+)"', line)
            timestamp = None
            if ts_match:
                try:
                    ts = datetime.fromisoformat(ts_match.group(1).replace('Z', '+00:00'))
                    timestamp = ts.astimezone(LOCAL_TZ)
                except:
                    pass
            if msg_type in ('human', 'user'):
                if current_prompt_turns:
                    user_prompts.append({'turns': current_prompt_turns, 'start': current_prompt_start})
                current_prompt_turns = []
                current_prompt_start = timestamp
            elif msg_type == 'assistant':
                cache = re.search(r'"cache_read_input_tokens"\s*:\s*(\d+)', line)
                inp = re.search(r'"input_tokens"\s*:\s*(\d+)', line)
                out = re.search(r'"output_tokens"\s*:\s*(\d+)', line)
                cw = re.search(r'"cache_creation_input_tokens"\s*:\s*(\d+)', line)
                turn = {
                    'cache_read': int(cache.group(1)) if cache else 0,
                    'input': int(inp.group(1)) if inp else 0,
                    'output': int(out.group(1)) if out else 0,
                    'cache_write': int(cw.group(1)) if cw else 0,
                    'timestamp': timestamp,
                }
                turn['context_size'] = turn['cache_read'] + turn['input'] + turn['cache_write']
                turn['total_tokens'] = turn['cache_read'] + turn['input'] + turn['output'] + turn['cache_write']

                # Cache hit percentage
                if turn['context_size'] > 0:
                    turn['cache_hit_pct'] = turn['cache_read'] / turn['context_size'] * 100
                else:
                    turn['cache_hit_pct'] = 0
                turn['is_miss'] = turn['cache_hit_pct'] < 20 and turn['context_size'] > 5000

                # Gap since previous turn
                turn['gap_seconds'] = None
                if timestamp and prev_ts:
                    turn['gap_seconds'] = (timestamp - prev_ts).total_seconds()
                prev_ts = timestamp

                turns.append(turn)
                current_prompt_turns.append(turn)
    if current_prompt_turns:
        user_prompts.append({'turns': current_prompt_turns, 'start': current_prompt_start})
    return turns, user_prompts


# Parse all sessions
all_sessions = []
all_turns = []
for proj_dir in projects_dir.iterdir():
    if not proj_dir.is_dir():
        continue
    for jf in proj_dir.glob('*.jsonl'):
        turns, prompts = parse_session(jf)
        if len(prompts) > 5:
            max_ctx = max((t['context_size'] for t in turns), default=0)
            timestamps = [t['timestamp'] for t in turns if t['timestamp']]
            start = timestamps[0] if timestamps else None
            all_sessions.append({
                'name': proj_dir.name,
                'turns': turns, 'prompts': prompts, 'max_ctx': max_ctx,
                'start': start,
            })
            all_turns.extend([t for t in turns if t['timestamp'] and t['context_size'] > 5000])

all_sessions.sort(key=lambda s: s['max_ctx'], reverse=True)
all_turns.sort(key=lambda t: t['timestamp'])

pre_1m = sorted([s for s in all_sessions if s['start'] and s['start'] < CONTEXT_1M_DATE],
                key=lambda s: s['max_ctx'], reverse=True)
post_1m = sorted([s for s in all_sessions if s['start'] and s['start'] >= CONTEXT_1M_DATE],
                 key=lambda s: s['max_ctx'], reverse=True)

# y-axis max (shared for top row)
all_max_ctx = 0
for s in pre_1m[:10] + post_1m[:10]:
    for p in s['prompts']:
        ctx = max((t['context_size'] for t in p['turns']), default=0)
        if ctx > all_max_ctx:
            all_max_ctx = ctx
y_max = max(all_max_ctx / 1000 * 1.05, NEW_LIMIT * 1.05)


# ══════════════════════════════════════════════════════════════
# FIGURE: 3 rows x 2 cols
# Row 1: Pre vs Post 1M context growth
# Row 2: Scatter plots (context vs tokens per prompt)
# Row 3: Cache miss analysis
# ══════════════════════════════════════════════════════════════
fig, axes = plt.subplots(3, 2, figsize=(20, 21))
fig.suptitle('Claude Code Context Window Analysis\n%d conversations, %s API turns' % (len(all_sessions), f'{len(all_turns):,}'),
             fontsize=20, fontweight='bold', color='white', y=0.98)

# ── Row 1: Context growth curves ──

# Pre-1M
ax = axes[0, 0]
for i, sess in enumerate(pre_1m[:10]):
    contexts = [max((t['context_size'] for t in p['turns']), default=0) for p in sess['prompts']]
    ax.plot([c/1000 for c in contexts], linewidth=1.8, alpha=0.85, color=RAINBOW[i % len(RAINBOW)])
ax.axhline(y=OLD_LIMIT, color='#ff9f43', linestyle='--', linewidth=1.5, alpha=0.7,
           label=f'Context window ({OLD_LIMIT}K)')
ax.axhline(y=OLD_COMPACTION, color='#ff6b6b', linestyle='--', linewidth=2, alpha=0.7,
           label=f'Auto-compaction ({OLD_COMPACTION}K)')
ax.set_xlabel('User Prompt #', fontsize=12)
ax.set_ylabel('Context Size (K tokens)', fontsize=12)
ax.set_title(f'Pre-1M  ({len(pre_1m)} conversations)\nCompaction keeps context bounded',
             fontsize=13, color='#55efc4')
ax.legend(fontsize=9, loc='upper left')
ax.grid(alpha=0.2)
ax.set_ylim(0, y_max)

# Post-1M
ax = axes[0, 1]
for i, sess in enumerate(post_1m[:10]):
    contexts = [max((t['context_size'] for t in p['turns']), default=0) for p in sess['prompts']]
    ax.plot([c/1000 for c in contexts], linewidth=1.8, alpha=0.85, color=RAINBOW[i % len(RAINBOW)])
ax.axhline(y=NEW_LIMIT, color='#ff6b6b', linestyle='--', linewidth=2, alpha=0.6,
           label=f'New limit ({NEW_LIMIT}K)')
ax.set_xlabel('User Prompt #', fontsize=12)
ax.set_ylabel('Context Size (K tokens)', fontsize=12)
ax.set_title(f'Post-1M  ({len(post_1m)} conversations)\nContext grows unchecked past old limit',
             fontsize=13, color='#ff6b6b')
ax.legend(fontsize=9, loc='upper left')
ax.grid(alpha=0.2)
ax.set_ylim(0, y_max)
ax.axhspan(OLD_LIMIT, y_max, alpha=0.03, color='#ff6b6b')

# ── Row 2: Scatter — context vs tokens per prompt, colored by turns ──

turn_colors = {1: '#55efc4', 2: '#feca57', 3: '#ff6b6b'}

def get_prompt_stats(session):
    stats = []
    for p in session['prompts']:
        ctx = max((t['context_size'] for t in p['turns']), default=0)
        total = sum(t['total_tokens'] for t in p['turns'])
        n_turns = len(p['turns'])
        stats.append({'context': ctx, 'total': total, 'turns': n_turns})
    return stats

def scatter_with_arrows(ax, sessions, color):
    all_ctx = []
    all_total = []
    all_turns_n = []
    for sess in sessions:
        for st in get_prompt_stats(sess):
            if st['context'] > 0 and st['total'] > 0:
                all_ctx.append(st['context'] / 1000)
                all_total.append(st['total'] / 1000)
                all_turns_n.append(min(st['turns'], 5))
    if not all_ctx:
        return
    ax.scatter(all_ctx, all_total, alpha=0.12, s=8, color=color, edgecolors='none')

    max_ctx_val = max(all_ctx)
    for target_turns in [1, 2, 3]:
        band_x = [cx for cx, tr in zip(all_ctx, all_turns_n) if tr == target_turns and cx > max_ctx_val * 0.4]
        band_y = [ty for ty, tr in zip(all_total, all_turns_n) if tr == target_turns
                  and all_ctx[all_total.index(ty)] > max_ctx_val * 0.4] if band_x else []

        # Simpler: re-gather matching pairs
        band_pairs = [(cx, ty) for cx, ty, tr in zip(all_ctx, all_total, all_turns_n)
                      if tr == target_turns and cx > max_ctx_val * 0.4]
        if len(band_pairs) < 5:
            continue
        bx = [p[0] for p in band_pairs]
        by = [p[1] for p in band_pairs]
        med_x = np.median(bx)
        med_y = np.median(by)
        labels = {1: '1 turn/prompt', 2: '2 turns/prompt', 3: '3+ turns/prompt'}
        offsets = {1: (30, -20), 2: (30, -15), 3: (30, -10)}
        ax.annotate(labels[target_turns], xy=(med_x, med_y),
                    xytext=offsets[target_turns], textcoords='offset points',
                    fontsize=10, color='white', fontweight='bold',
                    arrowprops=dict(arrowstyle='->', color='white', lw=1.5),
                    bbox=dict(boxstyle='round,pad=0.3', facecolor=PANEL_BG,
                             edgecolor=color, alpha=0.9, linewidth=1.5))

# Pre-1M scatter
ax = axes[1, 0]
scatter_with_arrows(ax, pre_1m, '#48dbfb')
ax.axvline(x=OLD_COMPACTION, color='#ff6b6b', linestyle='--', linewidth=1.5, alpha=0.6,
           label=f'Auto-compaction ({OLD_COMPACTION}K)')
ax.axvline(x=OLD_LIMIT, color='#ff9f43', linestyle='--', linewidth=1.5, alpha=0.6,
           label=f'Context window ({OLD_LIMIT}K)')
ax.set_xlabel('Context Size (K tokens)', fontsize=12)
ax.set_ylabel('Total Tokens Per Prompt (K)', fontsize=12)
ax.set_title('Pre-1M: Token Cost vs Context Size\nMultiple API turns multiply the cost per prompt',
             fontsize=12, color='#48dbfb')
ax.legend(fontsize=8, loc='upper left')
ax.grid(alpha=0.2)
ax.set_xlim(0, y_max)

# Post-1M scatter
ax = axes[1, 1]
scatter_with_arrows(ax, post_1m, '#ff6b6b')
ax.axvline(x=OLD_LIMIT, color='#ff9f43', linestyle='--', linewidth=1, alpha=0.3,
           label=f'Old limit ({OLD_LIMIT}K)')
ax.set_xlabel('Context Size (K tokens)', fontsize=12)
ax.set_ylabel('Total Tokens Per Prompt (K)', fontsize=12)
ax.set_title('Post-1M: Token Cost vs Context Size\nSame prompt costs 3x+ more at high context',
             fontsize=12, color='#ff6b6b')
ax.legend(fontsize=8, loc='upper left')
ax.grid(alpha=0.2)
ax.set_xlim(0, y_max)
ax.axvspan(OLD_LIMIT, y_max, alpha=0.03, color='#ff6b6b')

# ── Row 3: Cache analysis ──

# Left: Every API turn over time (hits green, misses red)
ax = axes[2, 0]
cache_hits = [t for t in all_turns if t['cache_hit_pct'] > 80]
cache_misses = [t for t in all_turns if t['is_miss']]

hit_ts = [t['timestamp'] for t in cache_hits]
hit_ctx = [t['context_size'] / 1000 for t in cache_hits]
ax.scatter(hit_ts, hit_ctx, alpha=0.03, s=4, color='#55efc4', edgecolors='none', label='Cache hit')

miss_ts = [t['timestamp'] for t in cache_misses]
miss_ctx = [t['context_size'] / 1000 for t in cache_misses]
ax.scatter(miss_ts, miss_ctx, alpha=0.6, s=20, color='#ff6b6b', edgecolors='none', label='Cache MISS')

ax.axvline(x=CONTEXT_1M_DATE, color='#feca57', linestyle='--', linewidth=2, alpha=0.7)
ax.text(CONTEXT_1M_DATE + timedelta(hours=12), max(hit_ctx + miss_ctx) * 0.92,
        '1M context\nrollout', fontsize=9, color='#feca57', va='top')

ax.xaxis.set_major_formatter(mdates.DateFormatter('%m/%d'))
plt.setp(ax.xaxis.get_majorticklabels(), rotation=45, ha='right')
ax.set_xlabel('Date', fontsize=12)
ax.set_ylabel('Context Size (K tokens)', fontsize=12)
ax.set_title('Every API Turn Over Time\nRed = cache miss (full price), Green = cache hit (10% price)',
             fontsize=12, color='#ff6b6b')
ax.legend(fontsize=10)
ax.grid(alpha=0.2)

# Right: Daily cache miss rate over time + miss context size
ax = axes[2, 1]

daily_stats = {}
for t in all_turns:
    if not t['timestamp']:
        continue
    day = t['timestamp'].date()
    if day not in daily_stats:
        daily_stats[day] = {'misses': 0, 'total': 0, 'miss_ctx_sum': 0, 'hit_ctx_sum': 0}
    daily_stats[day]['total'] += 1
    if t['is_miss']:
        daily_stats[day]['misses'] += 1
        daily_stats[day]['miss_ctx_sum'] += t['context_size']
    else:
        daily_stats[day]['hit_ctx_sum'] += t['context_size']

days = sorted(daily_stats.keys())
miss_pct = [daily_stats[d]['misses'] / daily_stats[d]['total'] * 100
            if daily_stats[d]['total'] > 0 else 0 for d in days]
# Cost of misses: extra tokens paid (miss tokens * 0.9 = the 90% premium over cache price)
miss_cost = [daily_stats[d]['miss_ctx_sum'] * 0.9 / 1_000_000 for d in days]

ax.bar(days, miss_pct, width=0.8, color='#ff6b6b', alpha=0.6, label='Cache miss rate (%)')
ax2 = ax.twinx()
ax2.plot(days, miss_cost, 'o-', color='#feca57', linewidth=2, markersize=4,
         label='Extra tokens from misses (M)', zorder=5)
ax2.set_ylabel('Extra Tokens from Misses (M)', color='#feca57', fontsize=11)
ax2.tick_params(axis='y', colors='#feca57')

ax.axvline(x=CONTEXT_1M_DATE.date(), color='#feca57', linestyle='--', linewidth=2, alpha=0.7)
ax.text(CONTEXT_1M_DATE.date() + timedelta(days=1), max(miss_pct) * 0.9,
        '1M context\nrollout', fontsize=9, color='#feca57', va='top')

ax.xaxis.set_major_formatter(mdates.DateFormatter('%m/%d'))
plt.setp(ax.xaxis.get_majorticklabels(), rotation=45, ha='right')
ax.set_xlabel('Date', fontsize=12)
ax.set_ylabel('Cache Miss Rate (%)', fontsize=12)
ax.set_title('Cache Miss Rate & Cost Over Time\nMiss rate stable, but misses cost more post-1M',
             fontsize=12, color='#ff6b6b')
ax.legend(fontsize=9, loc='upper left')
ax2.legend(fontsize=9, loc='upper right')
ax.grid(alpha=0.2)

plt.tight_layout(rect=[0, 0, 1, 0.95])
output_path = Path.cwd() / 'context_analysis.png'
plt.savefig(str(output_path), dpi=150, bbox_inches='tight',
            facecolor=BG, edgecolor='none')
print(f"Saved: {output_path}")

print(f"\n{'='*50}")
print(f"  Your Claude Code Token Analysis")
print(f"{'='*50}")
print(f"  Conversations analyzed:  {len(all_sessions)}")
print(f"  Pre-1M (before 3/13):    {len(pre_1m)}")
print(f"  Post-1M (after 3/13):    {len(post_1m)}")
print(f"  Total API turns:         {len(all_turns):,}")
misses_final = [t for t in all_turns if t['is_miss']]
print(f"  Cache misses:            {len(misses_final)} ({len(misses_final)/len(all_turns)*100:.1f}%)")
if pre_1m:
    print(f"  Max pre-1M context:      {max(s['max_ctx'] for s in pre_1m)/1000:.0f}K")
if post_1m:
    print(f"  Max post-1M context:     {max(s['max_ctx'] for s in post_1m)/1000:.0f}K")
total_waste = sum(miss_cost)
print(f"  Extra tokens from misses: {total_waste:.1f}M")
print(f"{'='*50}")
print(f"\nShare your chart! Compare with others on r/ClaudeAI")

# Try to open the image
import subprocess
try:
    if platform.system() == 'Windows':
        os.startfile(str(output_path))
    elif platform.system() == 'Darwin':
        subprocess.run(['open', str(output_path)], check=False)
    else:
        subprocess.run(['xdg-open', str(output_path)], check=False)
except Exception:
    pass
