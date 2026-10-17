<div align="center">

# cc-cost

**What your Claude Code session is really spending — live, above the prompt.**

Tokens, context and your subscription's **5h / 7d windows**, not API dollars.

[![Claude Code](https://img.shields.io/badge/Claude_Code-2.1.287%2B-d97757)](https://claude.com/claude-code)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![No telemetry](https://img.shields.io/badge/network-none-success)](#privacy)

[Português](README.pt-BR.md)

![cc-cost band above the Claude Code prompt](docs/band.png)

</div>

---

## Install

At the prompt of a Claude Code session:

```
/plugin install cc-cost --marketplace edsoncantuaria/cc-cost
```

Answer `y` to add the marketplace, then pick a scope. The band shows up on the next turn.

## Reading the band

| Segment | Meaning |
| --- | --- |
| `111k tokens` | New tokens in the session: input + cache writes + output |
| `↑ 111k  ↓ 73` | Input / output split |
| `cache 0%` | Share of input served from cache reads (left out of the total, since they resend the same context every request) |
| `hoje 111k` | Today's total across every session, kept locally for 7 days |
| `5h 6%  7d 9%` | Subscription usage windows (and spend limit, when set), green → yellow → red |
| `ctx 111k/1,0M` | Current context against the auto-compact window; turns yellow, then red before autocompact |
| `▁▃▅█` | Sparkline of new tokens per turn |
| `[ compact ]` | One-key (`c`) compaction, picking the cheaper mode |
| subagents | Count and largest subagent context while they run; their tokens count toward today, not the session |

### Smart compaction

The **compact** button picks what costs less:

- **`/compact micro`** when file reads are 40%+ of the context (needs the micro-compaction plugin);
- otherwise the native **`/compact`** with a focused summary prompt.

When the context turns red, a toast tells you which mode the button will use and how much it frees.

## Why not ccusage?

ccusage estimates **API cost in dollars** from past logs. On a Pro/Max subscription that isn't what you pay — the limit that matters is the **5h window, live**. cc-cost shows that, inside the session.

## Requirements

- Claude Code **2.1.287+** with mods (function hooks, early access).
- Optional: the micro-compaction plugin for `micro` mode.

## Development

```bash
git clone https://github.com/edsoncantuaria/cc-cost ~/.claude/mods/cc-cost
claude plugin validate ~/.claude/mods/cc-cost
claude plugin test ~/.claude/mods/cc-cost
claude --plugin-dir ~/.claude/mods/cc-cost
```

To load the clone in every session, set `CLAUDE_CODE_PLUGIN_DIRS` to its folder in the `env` block of `~/.claude/settings.json` and restart Claude Code. Copying the folder alone doesn't load it. Don't combine this with the marketplace install, or the band is drawn twice.

## Privacy

No network, no telemetry. It only reads the session usage Claude Code provides and keeps daily counters in the mod's local store.

## License

[MIT](LICENSE)
