It reads your existing Claude Code session data (read-only, nothing gets modified). Each session is a JSONL conversation file that it parses for token counts, tool usage, and summaries. For active sessions it watches file modification times to detect which ones are live.

To resume a session you just press Enter on it. It launches Claude Code with --resume and the session ID. There's also a summarize command that uses Claude to generate short summaries so you can quickly tell what each session was about.

I find it pretty essential for my workflow now. Hopefully useful for others too.

Thanks for the tip on VibeCodersNest, I'll check it out.
