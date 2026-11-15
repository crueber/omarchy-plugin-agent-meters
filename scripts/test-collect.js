#!/usr/bin/env node
'use strict'

// Offline test for the unified collector: fake opencode/claude binaries, an
// empty Grok home and no OpenRouter key. No network and no real credential.

const assert = require('assert')
const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const repo = path.resolve(__dirname, '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-meters-'))
const home = path.join(tmp, 'home')
const bin = path.join(tmp, 'bin')
const grokHome = path.join(tmp, 'grok')
fs.mkdirSync(path.join(home, '.local/state/omarchy/agents/usage'), { recursive: true })
fs.mkdirSync(path.join(home, '.config'), { recursive: true })
fs.mkdirSync(bin, { recursive: true })
fs.mkdirSync(grokHome, { recursive: true })

function script(name, body) {
  const file = path.join(bin, name)
  fs.writeFileSync(file, '#!/bin/sh\n' + body + '\n')
  fs.chmodSync(file, 0o755)
  return file
}

const opencode = script('opencode', `
if [ "$1" = "api" ]; then
  cat <<'JSON'
{"data":{"workspace":{"id":"w1","name":"work"},"go":{"rolling":{"percent":10,"limited":false,"resetsAt":1000},"weekly":{"percent":20,"limited":false,"resetsAt":2000},"monthly":{"percent":30,"limited":false,"resetsAt":3000}},"budgets":[{"id":"console","limit":10,"spent":2.5,"resetsAt":4000}]}}
JSON
else
  echo '[]'
fi`)

const claude = script('claude', `
cat <<'JSON'
{"tierLabel":"Max 5x","usageStatusText":"","todayPrompts":3,"todayTotalTokens":1200,"totalPrompts":9,
 "limits":[{"label":"Session (5-hour)","percent":0.12,"resetsAt":"2026-11-15T18:00:00Z"},
           {"label":"Weekly (7-day)","percent":0.45,"resetsAt":"2026-11-20T00:00:00Z"},
           {"label":"Fable Weekly","percent":0.08,"resetsAt":"2026-11-20T00:00:00Z"}]}
JSON`)

const env = Object.assign({}, process.env, {
  HOME: home,
  XDG_STATE_HOME: path.join(home, '.local/state'),
  XDG_CONFIG_HOME: path.join(home, '.config'),
  PATH: bin + ':/usr/bin:/bin'
})
delete env.OPENROUTER_API_KEY
delete env.OPENROUTER_AUTH_FILE

let output
try {
  output = execFileSync(process.execPath, [
    path.join(repo, 'scripts/collect.js'),
    '--opencode', opencode,
    '--claude', claude,
    '--grok-home', grokHome,
    '--bot-home', grokHome
  ], { encoding: 'utf8', env: env, timeout: 30000 })
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

const doc = JSON.parse(output)
assert.strictEqual(doc.ok, true)
const byId = {}
for (const provider of doc.providers) byId[provider.id] = provider

assert.ok(byId.claude, 'claude provider present')
assert.strictEqual(byId.claude.available, true)
assert.strictEqual(byId.claude.limits.length, 3)
assert.strictEqual(byId.claude.limits[0].key, 'session')
assert.strictEqual(byId.claude.limits[0].percent, 12)
assert.strictEqual(byId.claude.limits[1].key, 'weekly')
assert.strictEqual(byId.claude.limits[1].percent, 45)
assert.strictEqual(byId.claude.limits[2].key, 'fable')
assert.strictEqual(byId.claude.limits[2].percent, 8)
assert.strictEqual(byId.claude.activity.prompts, 3)
assert.strictEqual(byId.claude.activity.tokens, 1200)

assert.ok(byId.opencode, 'opencode provider present')
assert.strictEqual(byId.opencode.available, true)
assert.strictEqual(byId.opencode.limits.length, 3)
assert.strictEqual(byId.opencode.limits[1].percent, 20)
assert.strictEqual(byId.opencode.budgets.length, 1)
assert.strictEqual(byId.opencode.budgets[0].percent, 25)

assert.ok(byId.grok, 'grok record present')
assert.strictEqual(byId.grok.available, false)

assert.ok(byId.openrouter, 'openrouter record present')
assert.strictEqual(byId.openrouter.available, false)

assert.strictEqual(output.indexOf('sk-or-'), -1)

process.stdout.write('all collector tests passed\n')
