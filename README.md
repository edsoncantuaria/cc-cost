# cc-cost

[Português](README.pt-BR.md)

A minimal Claude Code mod that shows a status band above the prompt with what your session is really spending against your **subscription usage windows** (5h / 7d), not API dollars.

```
243k tokens  ↑ 202k  ↓ 41k  cache 83%  hoje 243k  5h 62%  ▁▃▅█
```

## What it shows
- **New tokens in the session** (input + cache writes + output). Cache reads are left out, because they resend the same context on every request and would count the conversation many times; they appear as a cache percentage instead.
- **Today's total**, summed across all sessions (kept locally for 7 days).
- **Usage limits** from Claude Code: 5h, 7d and spend limit, colored as they rise.
- **Current context** size against the auto-compact window, turning yellow and then red before autocompact kicks in.
- **Sparkline** of new tokens per turn.
- **Compact button** that picks the cheaper option: `/compact micro` (needs the micro-compaction plugin) when file reads are 40%+ of the context, otherwise the native `/compact` with a focused summary prompt.

## Why not ccusage?
ccusage estimates API cost in dollars from past logs. On a Pro/Max subscription that number isn't what you pay; the limit that matters is the 5h window, live. cc-cost shows that, inside the session.

## Requirements
- Claude Code **2.1.287+** with mods (function hooks, early access).
- Optional: the micro-compaction plugin for the `micro` compaction mode.

## Install
Copy the folder into `~/.claude/mods/` (user scope only):
```bash
git clone https://github.com/edsoncantuaria/cc-cost ~/.claude/mods/cc-cost
claude plugin validate ~/.claude/mods/cc-cost
```

## Test
```bash
claude plugin test ~/.claude/mods/cc-cost
```

## Privacy
No network, no telemetry. It only reads the session usage Claude Code provides and stores daily counters in the mod's local store.

## License
MIT
