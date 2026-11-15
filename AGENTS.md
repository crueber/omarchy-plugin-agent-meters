# AGENTS.md

Agent Meters — one Omarchy shell bar widget for the AI agents a machine
actually uses (Claude, Grok, OpenCode, OpenRouter). It reuses the collectors
and marks of the three single-agent plugins it replaces, adds Claude, and
keeps agents with no plan, key or usage out of the bar.

## Layout

- `manifest.json` — plugin id `crueber.agent-meters`, bar-widget entry, settings.
- `Panel.qml` — bar chips and the unified panel; fetch/cache lifecycle.
- `ProviderMark.qml` — resolves and themes `marks/<Provider>Mark.qml`.
- `Model.js` — pure helpers: parsing, window/state computation, OpenRouter
  cycle history, cache, poll coordination.
- `marks/` — monochrome vector marks, each taking `markSize` and `color`.
- `scripts/collect.js` — the single collector. Calls each provider source,
  normalizes to `{ id, name, available, tier, status, error, limits[],
  activity, money, budgets[] }`.
- `scripts/grok.js` — Grok log/session/Bot reader, ported unchanged from the
  Grok plugin.
- `scripts/test-model.js`, `scripts/test-collect.js` — offline tests.
- `scripts/install.sh`, `scripts/validate.sh`.

## Data sources

| Provider | Source |
| --- | --- |
| Claude | `omarchy-agent-usage-claude --limits-only`, falling back to `~/.local/state/omarchy/agents/usage/claude.json` |
| Grok | `scripts/grok.js` over `~/.grok`; falls back to the Omarchy `grok.json` record |
| OpenCode | `opencode api GET /api/experimental/usage/limits` (retries `--standalone`) |
| OpenRouter | `OPENROUTER_API_KEY`, `auth.json`, or `opencode auth export`, then `/api/v1/key` + `/api/v1/credits` |

Claude's three windows arrive as percentages of 1 in Omarchy's record, so the
collector scales a payload whose values are all ≤ 1.5 by 100. The labels map
to keys `session`, `weekly`, `fable`, `monthly`; the Fable row is the scoped
allowance that only Fable spends against.

## Invariants

1. Never print, cache, or pass a key on a command line. OpenRouter keys are
   used only in the HTTPS header.
2. `available` decides the bar. Do not add a provider that has neither a
   plan/limits nor a detected credential.
3. Limits are clamped 0–100 and resets are epoch milliseconds.
4. OpenRouter keeps one current and one previous completed cycle; a previous
   cycle is only used when observed near its end.
5. Failed provider reads keep their last good numbers and gain `error`.
6. Any text from a file or network goes through `plain()` before display.
7. Bar order is the widget's `providerOrder` setting (comma-separated ids).
   The panel's drag handle reports a drop index in section coordinates;
   `Model.reorderInsert` returns the full order (keeping hidden agents in
   place) and the panel persists it through
   `omarchy bar set crueber.agent-meters providerOrder ...`. `orderedProviders`
   appends any unnamed agent in the default order, so new providers appear
   without a settings edit.

## Testing

```bash
./scripts/validate.sh
node scripts/test-model.js
node scripts/test-collect.js
omarchy plugin validate ~/.config/omarchy/plugins/crueber.agent-meters
omarchy-shell shell rescanPlugins
omarchy-shell agent-meters text
```

Cache: `~/.cache/agent-meters/usage.json`; it must contain no key material.
Logs: `journalctl --user -t omarchy-shell --since "-2 min" | grep -i agent-meters`.
