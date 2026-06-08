Dashboard for launching and managing Claude Code sessions across projects

---

Built a terminal dashboard to make it easier to track projects, sessions, and usage in Claude Code. Makes resuming or starting sessions much faster — arrow to a project, hit enter, done.

To install:

    npm i -g cldctrl

No config. Reads your existing ~/.claude data and auto-discovers your projects.

What it does:
- Launch or resume Claude Code sessions from a project list
- See active sessions and what they're working on
- Enter on a GitHub issue launches Claude with that issue as context
- Token usage with rate limit bars (5h/7d windows)
- Git status, session history, per-session cost estimates
- Browse project files and commits

Tested primarily on Windows. Should work on macOS and Linux but less tested — bug reports welcome.

Interactive preview: https://cld-ctrl.com
Source: https://github.com/RyanSeanPhillips/cldctrl
npm: https://www.npmjs.com/package/cldctrl
