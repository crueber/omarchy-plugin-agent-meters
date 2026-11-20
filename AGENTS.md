# AGENTS.md

Agent Meters — one Omarchy shell bar widget for the AI agents a machine
actually uses (OpenRouter, OpenCode, Grok, Codex, Claude). It reuses the
collectors and marks of the three single-agent plugins it replaces, adds
Codex and Claude, and keeps agents with no plan, key or usage out of the bar.

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
- `scripts/grok.js` — Grok log/session/Bot reader, ported from the Grok
  plugin; it also reports a Grok Bot reading when there is no CLI snapshot
  (`source: "grok-bot"`).
- `scripts/set-management-key.sh` — stores/removes the OpenRouter management
  key (Secret Service, or the 0600 file); reads it from stdin/tty only.
- `scripts/test-model.js`, `scripts/test-collect.js` — offline tests;
  `scripts/test-https-stub.js` is the `node -r` preload that answers
  OpenRouter requests in tests (never shipped).
- `scripts/install.sh`, `scripts/validate.sh`.

## Data sources

| Provider | Source |
| --- | --- |
| Claude | `omarchy-agent-usage-claude --limits-only`, falling back to `~/.local/state/omarchy/agents/usage/claude.json` |
| Codex | `omarchy-agent-usage-codex --limits-only`, falling back to `~/.local/state/omarchy/agents/usage/codex.json` |
| Grok | `scripts/grok.js` over `~/.grok`; falls back to the Omarchy `grok.json` record |
| OpenCode | `opencode api GET /api/experimental/usage/limits` (retries `--standalone`) |
| OpenRouter | Management key (`OPENROUTER_MANAGEMENT_KEY` → `secret-tool lookup service agent-meters account openrouter-management` → `$XDG_DATA_HOME/agent-meters/openrouter-management-key`, 0600 in 0700, no symlinks): `/api/v1/keys`, `/api/v1/credits`, `/api/v1/analytics/meta`, `POST /api/v1/analytics/query`. Else `OPENROUTER_API_KEY`, `auth.json`, or `opencode auth export`, then `/api/v1/key` + `/api/v1/credits` |

Claude's three windows arrive as percentages of 1 in Omarchy's record, so the
collector scales a payload whose values are all ≤ 1.5 by 100. The labels map
to keys `session`, `weekly`, `fable`, `monthly`; the Fable row is the scoped
allowance that only Fable spends against.

Codex comes from its app-server RPC: general windows are `5h window` and
`Weekly (7-day)`, a Business seat can report `Spend limit`, and a model's own
allowance carries its name in `title` (`o3 Weekly`), which maps to a
`scoped-` key. `CODEX_BASE_ORDER` sorts general session/weekly/review before
the scoped windows. An API-key sign-in has no plan limits and stays hidden.

## Invariants

1. Never print, cache, or pass a key on a command line. OpenRouter keys are
   used only in the HTTPS header. The management key additionally never goes
   into settings, manifest defaults, IPC output, the collector's JSON or error
   text (`scrub`); `collect.js` deletes `OPENROUTER_MANAGEMENT_KEY` from its
   environment before spawning anything. The one input for it is the panel's
   masked field: it lives only in `keyDraft`/`keyProc.pending`, goes to
   `scripts/set-management-key.sh` on stdin, and is cleared on submit, Esc and
   process exit. Never put it in a `setting()` key (that flows into
   `shell.json`), an IPC payload, a command line, the cache or the logs. Do not
   add a configurable API host or base URL (that would redirect where the key
   is sent). Tests stub HTTPS with `node -r scripts/test-https-stub.js`, never
   with a production override.
2. `available` decides the bar. Do not add a provider that has neither a
   plan/limits nor a detected credential.
3. Limits are clamped 0–100 and resets are epoch milliseconds.
4. OpenRouter history keeps one current and up to 12 completed cycles (most
   recent first, `previous` = the first) and a `scope` (`key` or `account`);
   a completed cycle is only kept when observed within six hours of its end,
   and a change of scope starts a new series. 1.1 caches (`previous` only)
   migrate in `normalizeHistory`; do not bump `CACHE_VERSION` for this.
5. Failed provider reads keep their last good numbers and gain `error`.
6. Any text from a file or network goes through `plain()` before display.
7. `availableProviders` is every available agent in `providerOrder` order;
   `panelProviders` appends OpenRouter when it has no key, because its panel
   section is where setting up a management key is explained; `visibleProviders`
   removes the ones whose `show<Agent>` setting is false from
   `availableProviders`. The panel lists `panelProviders` (so a hidden agent
   can be switched back on) and the bar lists `visibleProviders`, so the
   setup-only OpenRouter never reaches the bar. The per-agent switches live in
   the panel's settings view (`settingsOpen`, the hero gear), not in the agent
   rows, and call
   `omarchy bar set crueber.agent-meters show<Agent> true|false --json`.
8. A missing cache must fetch once leadership settles; do not leave the first
   read to the five-minute poll. `Component.onCompleted` and the five-second
   election timer both ask for the read when no provider is loaded.
9. Bar order is the widget's `providerOrder` setting (comma-separated ids).
   The panel's drag handle reports a drop index in section coordinates;
   `Model.reorderInsert` returns the full order (keeping hidden agents in
   place) and the panel persists it through
   `omarchy bar set crueber.agent-meters providerOrder ...`. `orderedProviders`
   appends any unnamed agent in the default order, so new providers appear
   without a settings edit.
10. A management key takes precedence over the inference key, and a failing
   or unreadable one (HTTP error, refused key file, Secret Service timeout)
   reports its error with no fallback. Account-wide money has
   `scope: "account"`; its rows are `limits` (`credits`, then `key-…`, value
   rows carry `amount`). The collector always returns up to 12 key rows;
   `openrouterKeyRows` is applied in `Model.windowsFor` only. The bar shows the
   credits figure and only the month meter (`barWindows`).
11. The analytics baseline is `money.baseline` `{ month, months, average,
   checkedAt }` (average 0 = unavailable). The widget passes it back with
   `--openrouter-baseline` so analytics is asked at most once per (month, N)
   (failures: once a day); `openrouterAverageMonths` 0 makes no analytics
   call. A setting change goes through `requestFetch("auto")`, never
   `spawnFetch`. The baseline is used only for the month of
   `money.resetsAt - 1` and the current N; otherwise the account-scoped
   history is averaged.

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
