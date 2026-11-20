# Security

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting on this repository
(Security → Report a vulnerability) instead of a public issue. Include the
plugin version, your Omarchy version, what you observed, and the smallest
reproduction you can. You should get an acknowledgement within a few days.

## Trust model

Omarchy shell plugins run as unsandboxed code inside the long-lived
`omarchy-shell` process. Install Agent Meters from this repository or the
Omarchy marketplace, and review changes like any other shell plugin.

## What this plugin reads

- `OPENROUTER_API_KEY`, the OpenCode credential file (`auth.json`), or the
  output of `opencode auth export`.
- An OpenRouter **management key**, from `OPENROUTER_MANAGEMENT_KEY`, the
  Secret Service (`secret-tool lookup service agent-meters account
  openrouter-management`), or
  `${XDG_DATA_HOME:-~/.local/share}/agent-meters/openrouter-management-key`.
- OpenCode's local API through the `opencode` CLI.
- `~/.grok` billing logs and per-turn session ledgers, and the Grok Bot app's
  small cached JSON blob. `~/.grok/auth.json` is never opened.
- Omarchy's display-ready agent records under
  `~/.local/state/omarchy/agents/usage/`, and the output of
  `omarchy-agent-usage-claude` / `omarchy-agent-usage-codex`.

No prompt text, response text, session content, or account identity is read
into the widget's cache or displayed.

## Network access

This plugin talks only to `https://openrouter.ai` (the host is fixed in the
code, not configurable):

- per-key mode: `GET /api/v1/key` and `GET /api/v1/credits` (optional);
- with a management key: `GET /api/v1/keys?offset=N` (at most 10 pages),
  `GET /api/v1/credits`, and for the usage meter's baseline
  `GET /api/v1/analytics/meta` and `POST /api/v1/analytics/query` — the latter
  two at most once per month and averaging window for a good answer, at most
  once a day after a failed one, and never when `openrouterAverageMonths` is 0.

Every request carries the key only in an HTTPS `Authorization` header, has a
15-second timeout inside an overall 45-second budget, and its response is
capped at 1 MB; request bodies are capped at 4 KB and built only from a
validated metric name and dates. Claude's OAuth usage
probe and Codex's app-server RPC are made by Omarchy's own collectors, with
their caching and rate-limit handling; the plugin only runs those commands.

There is no telemetry and no analytics.

## Secrets

- Keys are never printed, cached in the widget's cache, written to
  `shell.json`, or passed on a command line.
- The OpenRouter key is re-read at request time and dropped after the request.
- The cache at `~/.cache/agent-meters/usage.json` contains displayed numbers,
  reset times, the masked OpenRouter key label, the OpenRouter cycle history
  and analytics average, and — with a management key — each listed key's name,
  monthly spend and limit. It is created in a mode-`0700` directory.

### The OpenRouter management key

A management key can create and delete the account's API keys, so it gets the
strictest handling in the plugin.

**Storage, in the order the collector looks:**

1. `OPENROUTER_MANAGEMENT_KEY` in the collector's environment. The collector
   copies it once at start-up and deletes it from its own environment before
   it starts any other program (`opencode`, `secret-tool`, the Omarchy
   collectors, `grok.js`), so no child inherits it.
2. The freedesktop Secret Service (gnome-keyring on Omarchy), item
   `service=agent-meters account=openrouter-management`, read with
   `secret-tool lookup` (only those attributes are on its command line; the
   secret comes back on stdout; 3-second timeout, stderr discarded — the same
   pattern Omarchy's own `omarchy-agent-usage-agy` uses).
3. `${XDG_DATA_HOME:-~/.local/share}/agent-meters/openrouter-management-key`.
   The directory is checked with `lstat` (a real directory, owned by you, mode
   `0700`); the file is opened with `O_NOFOLLOW | O_NONBLOCK` and checked
   through the open descriptor (a regular file, owned by you, no group or other
   permission bits, at most 4 KB). Anything else is refused with an error and
   no other key is tried. The file sits under `~/.local/share` rather than
   `~/.config` because Omarchy treats `~/.config` as user configuration that
   people version and sync as dotfiles, and its own plans keep delete-capable
   credentials out of it.

Omarchy's default keyring is created **without a password**
(`install/user/default-keyring.sh`), so on a stock install neither option
encrypts the key at rest beyond full-disk encryption; both are readable by
processes running as you, which is the plugin's trust boundary anyway.

**Writing it.** `scripts/set-management-key.sh` reads the key from the
terminal with echo off (or from a pipe), never from its arguments (it refuses
any unknown argument without echoing it), validates its shape, and passes it
to `secret-tool store` on stdin through a shell builtin, so it never appears
in any process's argv (`/proc/<pid>/cmdline` is world-readable). With
`--file`, or when no Secret Service answers, it writes the file through a
`0600` temporary file in the `0700` directory and renames it into place. It
removes the copy in the other location so only one remains. `--remove`
deletes both.

The panel's settings view (the gear) runs the same helper. Its masked
`TextField` holds the key only in a transient QML property (never in a
`setting()` key, which is what flows into `shell.json`); on submit the property
is handed to the helper's stdin and cleared, the field is hidden, and only the
helper's exit status is read. The panel never displays or logs the key. The
settings page still has no field for it. As with any password typed into a
window, a screen recorder or a screenshot taken while the field is revealed can
capture it, which is why the field starts masked and is cleared on submit or
Esc.

**Use.** The key is sent only to `https://openrouter.ai` in the
`Authorization: Bearer` header. Error messages from the network or from
OpenRouter are scrubbed of the key (and of anything shaped like an
`sk-or-…` key or a `Bearer` value) before they reach the output.

**Never stored or shown:** not in `shell.json`, widget settings or manifest
defaults; not in the cache; not in the collector's JSON output, the logs or
stderr; not in `omarchy-shell agent-meters text|providers`; not on any
command line. The output and the panel only say where the key came from
(`env`, `Secret Service` or `file`). A failing management key keeps the last
good account-wide numbers with its error and never silently falls back to the
inference key.

## Text and inputs

All strings that come from a file or a network response are neutralised before
display, percentages are clamped to 0–100, collection sizes are bounded (at
most 1,000 listed keys and 12 key rows), and HTTP responses are size- and
time-limited. OpenRouter analytics answers are parsed strictly: an unexpected
row count, a negative or non-numeric figure, a date outside the asked range or
a truncated answer all mean "no baseline". The analytics baseline the widget
passes back to the collector on its command line is display data only
(month, months, average, time checked) and is validated by a strict pattern. Plugin settings are read through
Omarchy's widget API and never interpolated into a shell command without
quoting.

## Preview images

`preview.png` and `screenshots/bar.png` are composed offline from invented
data. No real key, account, workspace, spend, credit or usage figure appears in
them. The repository ships no demo or screenshot-capture script, so there is no
code path that copies live caches or settings into a temporary directory.

## Supported versions

Fixes land on `main` and in the latest release. The marketplace version is the
supported one; older checkouts should be updated with
`omarchy plugin update crueber.agent-meters`.
