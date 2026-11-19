#!/usr/bin/env node
'use strict'

// Offline tests for the unified collector: fake opencode/claude/codex and
// secret-tool binaries, a temporary HOME, and OpenRouter answered by
// scripts/test-https-stub.js. No network and no real credential: the keys
// below are invented.

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
const emptyBot = path.join(tmp, 'no-bot')
fs.mkdirSync(path.join(home, '.local/state/omarchy/agents/usage'), { recursive: true })
fs.mkdirSync(path.join(home, '.config'), { recursive: true })
fs.mkdirSync(bin, { recursive: true })
fs.mkdirSync(grokHome, { recursive: true })
fs.mkdirSync(emptyBot, { recursive: true })

const MGMT = 'sk-or-v1-demo-management-key-9999'
const INFERENCE = 'sk-or-v1-demo-inference-key-01b2'
const FULL_LABEL = 'sk-or-v1-0e6...1c96'
const NOW = Date.UTC(2026, 10, 19, 12) // Thursday 2026-11-19 12:00 UTC
const API = 'https://openrouter.ai/api/v1'
const KEYS0 = 'GET ' + API + '/keys?offset=0'
const CREDITS = 'GET ' + API + '/credits'
const META = 'GET ' + API + '/analytics/meta'
const QUERY = 'POST ' + API + '/analytics/query'
const KEY = 'GET ' + API + '/key'

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

const codex = script('codex', `
cat <<'JSON'
{"tierLabel":"Plus","usageStatusText":"","authHelpText":"Run \`codex login\` to authenticate.","todayPrompts":1,"todayTotalTokens":400,
 "limits":[{"label":"5h window","percent":0.25,"resetsAt":"2026-11-15T20:00:00Z"},
           {"label":"Weekly (7-day)","percent":0.5,"resetsAt":"2026-11-20T00:00:00Z"},
           {"label":"Code review","percent":0.1,"resetsAt":"2026-11-20T00:00:00Z"},
           {"label":"o3 Weekly","title":"o3 Weekly","percent":0.08,"resetsAt":"2026-11-20T00:00:00Z"}]}
JSON`)

const claude = script('claude', `
cat <<'JSON'
{"tierLabel":"Max 5x","usageStatusText":"","todayPrompts":3,"todayTotalTokens":1200,"totalPrompts":9,
 "limits":[{"label":"Session (5-hour)","percent":0.12,"resetsAt":"2026-11-15T18:00:00Z"},
           {"label":"Weekly (7-day)","percent":0.45,"resetsAt":"2026-11-20T00:00:00Z"},
           {"label":"Fable Weekly","percent":0.08,"resetsAt":"2026-11-20T00:00:00Z"}]}
JSON`)

// A fake Secret Service client: logs its argv and stdin, answers by mode.
const secretLog = path.join(tmp, 'secret-tool.log')
script('secret-tool', `
printf '%s\\n' "$*" >> "${secretLog}"
case "$1" in
  lookup)
    case "$FAKE_SECRET_MODE" in
      key) printf '%s\\n' "$FAKE_SECRET_VALUE"; exit 0 ;;
      hang) sleep 10; exit 0 ;;
      *) exit 1 ;;
    esac ;;
  store) cat > "${path.join(tmp, 'secret-store.stdin')}"; exit "\${FAKE_STORE_STATUS:-0}" ;;
  clear) exit 0 ;;
esac
exit 1`)
// The helper wraps secret-tool in coreutils timeout; macOS has none.
script('timeout', 'shift; exec "$@"')

const baseEnv = Object.assign({}, process.env, {
  HOME: home,
  XDG_STATE_HOME: path.join(home, '.local/state'),
  XDG_CONFIG_HOME: path.join(home, '.config'),
  XDG_DATA_HOME: path.join(home, '.local/share'),
  PATH: bin + ':/usr/bin:/bin'
})
for (const name of ['OPENROUTER_API_KEY', 'OPENROUTER_AUTH_FILE', 'OPENROUTER_MANAGEMENT_KEY', 'GROK_HOME', 'GROK_BOT_HOME',
  'FAKE_SECRET_MODE', 'FAKE_SECRET_VALUE', 'STUB_ROUTES', 'STUB_LOG', 'STUB_NOW']) {
  delete baseEnv[name]
}

let runCount = 0
function run(options) {
  const opts = options || {}
  runCount += 1
  const routesFile = path.join(tmp, 'routes-' + runCount + '.json')
  const logFile = path.join(tmp, 'calls-' + runCount + '.log')
  fs.writeFileSync(routesFile, JSON.stringify(opts.routes || {}))
  fs.writeFileSync(logFile, '')
  fs.writeFileSync(secretLog, '')
  const env = Object.assign({}, baseEnv, opts.env || {}, {
    STUB_ROUTES: routesFile,
    STUB_LOG: logFile,
    STUB_NOW: String(opts.now || NOW)
  })
  const args = ['-r', path.join(repo, 'scripts/test-https-stub.js'), path.join(repo, 'scripts/collect.js'),
    '--opencode', opencode, '--claude', claude, '--codex', codex,
    '--grok-home', opts.grokHome || grokHome, '--bot-home', opts.botHome || emptyBot].concat(opts.args || [])
  const output = execFileSync(process.execPath, args, { encoding: 'utf8', env: env, timeout: 30000 })
  const doc = JSON.parse(output)
  const byId = {}
  for (const provider of doc.providers) byId[provider.id] = provider
  const calls = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(function(line) { return JSON.parse(line) })
  const secretCalls = fs.readFileSync(secretLog, 'utf8').split('\n').filter(Boolean)
  return { output: output, doc: doc, byId: byId, or: byId.openrouter, calls: calls, secretCalls: secretCalls }
}

function urls(result) {
  return result.calls.map(function(call) { return call.method + ' ' + call.url })
}

function test(name, fn) {
  fn()
  process.stdout.write('ok — ' + name + '\n')
}

function keyJSON(fields) {
  return Object.assign({
    hash: 'h', name: null, label: FULL_LABEL, disabled: false, limit: null, limit_remaining: null, limit_reset: null,
    include_byok_in_limit: false, usage: 1, usage_daily: 0.5, usage_weekly: 2, usage_monthly: 4,
    byok_usage: 0, created_at: '2026-01-01T00:00:00Z', updated_at: null, expires_at: null,
    creator_user_id: 'user_demo', workspace_id: 'ws_demo'
  }, fields)
}

const KEYS = { data: [
  keyJSON({ hash: 'f01d4a2b99c3', name: 'My Production Key', limit: 100, limit_remaining: 74.5, limit_reset: 'monthly', usage_monthly: 25.5 }),
  keyJSON({ hash: 'a1b2c3d4e5f6', name: null, label: 'sk-or-v1-abc...beef', limit: 10, limit_reset: 'weekly', usage_weekly: 9, usage_monthly: 12 }),
  keyJSON({ hash: '0000aaaa1111', name: 'Bot <b>', limit: 5, limit_remaining: 0, limit_reset: 'daily', usage_monthly: 3 }),
  keyJSON({ hash: '9999ffff', name: 'Lifetime', limit: 4, usage: 2, usage_monthly: 1, expires_at: '2027-01-01T00:00:00Z' }),
  keyJSON({ hash: 'nolimit01', name: 'Unlimited', usage_monthly: 0.25 }),
  keyJSON({ hash: 'zerouse01', name: 'Idle', limit: 10, limit_remaining: 10, limit_reset: 'monthly', usage_monthly: 0 }),
  keyJSON({ hash: 'disabled01', name: 'Old', disabled: true, limit: 1, limit_remaining: 0, usage_monthly: 50 }),
  keyJSON({ hash: 'expired001', name: 'Gone', limit: 1, limit_remaining: 0, usage_monthly: 70, expires_at: '2026-11-01T00:00:00Z' })
] }
const CREDITS_OK = { data: { total_credits: 100.5, total_usage: 25.75 } }
const META_OK = { data: { metrics: [
  { name: 'requests', display_label: 'Requests', is_rate: false, display_format: 'number' },
  { name: 'byok_cost', display_label: 'BYOK cost', is_rate: false, display_format: 'currency' },
  { name: 'cost', display_label: 'Cost', is_rate: false, display_format: 'currency' }
] } }
const QUERY_OK = { data: { data: [
  { date: '2026-09-01T00:00:00Z', cost: 60 },
  { date: '2026-10-01T00:00:00Z', cost: 62.4 }
], metadata: { row_count: 2, truncated: false } } }
const ACCOUNT_ROUTES = {}
ACCOUNT_ROUTES[KEYS0] = { status: 200, body: KEYS }
ACCOUNT_ROUTES[CREDITS] = { status: 200, body: CREDITS_OK }
ACCOUNT_ROUTES[META] = { status: 200, body: META_OK }
ACCOUNT_ROUTES[QUERY] = { status: 200, body: QUERY_OK }

function routes(extra) {
  return Object.assign({}, ACCOUNT_ROUTES, extra || {})
}

function assertNoKey(result) {
  for (const secret of [MGMT, INFERENCE, FULL_LABEL, 'sk-or-v1-from']) {
    assert.strictEqual(result.output.indexOf(secret), -1, 'collector output carries no key: ' + secret.slice(0, 8))
  }
  for (const line of result.secretCalls) assert.strictEqual(line.indexOf('sk-or'), -1, 'no key on secret-tool argv')
}

function managementDir() {
  return path.join(home, '.local/share/agent-meters')
}

function writeKeyFile(content, dirMode, fileMode) {
  const dir = managementDir()
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  fs.chmodSync(dir, dirMode)
  const file = path.join(dir, 'openrouter-management-key')
  fs.writeFileSync(file, content)
  fs.chmodSync(file, fileMode)
  return file
}

function clearKeyFile() {
  fs.rmSync(managementDir(), { recursive: true, force: true })
}

try {
  test('collects every local agent with no OpenRouter key', function() {
    const r = run()
    const byId = r.byId
    assert.strictEqual(r.doc.ok, true)
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

    assert.ok(byId.codex, 'codex provider present')
    assert.strictEqual(byId.codex.available, true)
    assert.strictEqual(byId.codex.tier, 'Plus')
    assert.strictEqual(byId.codex.limits.length, 4)
    assert.strictEqual(byId.codex.limits[0].key, 'session')
    assert.strictEqual(byId.codex.limits[0].percent, 25)
    assert.strictEqual(byId.codex.limits[1].key, 'weekly')
    assert.strictEqual(byId.codex.limits[1].percent, 50)
    assert.strictEqual(byId.codex.limits[2].key, 'review')
    assert.strictEqual(byId.codex.limits[3].key, 'scoped-weekly')
    assert.strictEqual(byId.codex.limits[3].detail, 'o3 Weekly')

    assert.ok(byId.opencode, 'opencode provider present')
    assert.strictEqual(byId.opencode.available, true)
    assert.strictEqual(byId.opencode.limits.length, 3)
    assert.strictEqual(byId.opencode.limits[1].percent, 20)
    assert.strictEqual(byId.opencode.budgets.length, 1)
    assert.strictEqual(byId.opencode.budgets[0].percent, 25)

    assert.ok(byId.grok, 'grok record present')
    assert.strictEqual(byId.grok.available, false)

    assert.ok(r.or, 'openrouter record present')
    assert.strictEqual(r.or.available, false)
    assert.strictEqual(r.or.keySource, '')
    assert.deepStrictEqual(r.calls, [], 'no request without a key')
    assert.deepStrictEqual(r.secretCalls, ['lookup service agent-meters account openrouter-management'],
      'one Secret Service lookup, attributes only')
    assert.strictEqual(r.output.indexOf('sk-or-'), -1)
  })

  test('per-key mode is unchanged without a management key', function() {
    const extra = {}
    extra[KEY] = { status: 200, body: { data: { label: 'sk-or-v1-123...01b2', limit: 20, limit_reset: 'daily', usage_daily: 5, usage_monthly: 9 } } }
    extra[CREDITS] = { status: 200, body: CREDITS_OK }
    const r = run({ env: { OPENROUTER_API_KEY: INFERENCE }, routes: extra })
    assert.deepStrictEqual(urls(r), [KEY, CREDITS])
    assert.ok(r.calls.every(function(call) { return call.authorization === 'Bearer ' + INFERENCE }))
    assert.strictEqual(r.or.source, 'openrouter-api')
    assert.strictEqual(r.or.money.scope, 'key')
    assert.strictEqual(r.or.money.label, 'key …1b2')
    assert.strictEqual(r.or.money.spend, 5, 'a daily limit reads usage_daily ("daily" has no "day")')
    assert.strictEqual(r.or.money.credits.remaining, 74.75)
    assert.strictEqual(r.or.limits.length, 0)
    assertNoKey(r)
  })

  test('a management key from the environment wins over the inference key', function() {
    const r = run({ env: { OPENROUTER_API_KEY: INFERENCE, OPENROUTER_MANAGEMENT_KEY: '  ' + MGMT + '\n' }, routes: routes() })
    assert.deepStrictEqual(urls(r), [KEYS0, CREDITS, META, QUERY], 'keys, credits, analytics; never /key')
    assert.ok(r.calls.every(function(call) { return call.authorization === 'Bearer ' + MGMT }), 'trimmed management key, header only')
    assert.deepStrictEqual(r.secretCalls, [], 'the Secret Service is not asked when the variable is set')
    const p = r.or
    assert.strictEqual(p.available, true)
    assert.strictEqual(p.error, '')
    assert.strictEqual(p.tier, 'Management key')
    assert.strictEqual(p.status, '6 keys', 'enabled, unexpired keys')
    assert.strictEqual(p.source, 'openrouter-management')
    assert.strictEqual(p.keySource, 'env')
    assert.strictEqual(p.money.scope, 'account')
    assert.strictEqual(p.money.label, 'All keys')
    assert.strictEqual(p.money.limit, null)
    assert.ok(Math.abs(p.money.spend - (25.5 + 12 + 3 + 1 + 0.25)) < 1e-9, 'sum of usage_monthly over active keys')
    assert.deepStrictEqual(p.money.credits, { remaining: 74.75 }, 'credits left only, no lifetime totals')
    assert.strictEqual(p.money.resetsAt, Date.UTC(2026, 11, 1))
    assert.deepStrictEqual(p.money.baseline, { month: '2026-11', months: 2, average: 61.2, checkedAt: NOW })

    assert.deepStrictEqual(p.limits.map(function(l) { return l.key }),
      ['credits', 'key-f01d4a2b', 'key-a1b2c3d4', 'key-0000aaaa', 'key-9999ffff', 'key-nolimit0'],
      'credits first, then keys by spend this month; idle, disabled and expired keys left out')
    const byKey = {}
    p.limits.forEach(function(l) { byKey[l.key] = l })
    assert.strictEqual(byKey.credits.amount, 74.75)
    assert.strictEqual(byKey.credits.label, 'Credits')
    assert.strictEqual(byKey['key-f01d4a2b'].amount, null, 'a limited key is a meter')
    assert.strictEqual(byKey['key-f01d4a2b'].percent, 25.5, 'from limit_remaining')
    assert.strictEqual(byKey['key-f01d4a2b'].resetsAt, Date.UTC(2026, 11, 1), 'monthly reset')
    assert.strictEqual(byKey['key-a1b2c3d4'].percent, 90, 'from usage_weekly')
    assert.strictEqual(byKey['key-a1b2c3d4'].resetsAt, Date.UTC(2026, 10, 23), 'weekly: next Monday')
    assert.strictEqual(byKey['key-a1b2c3d4'].label, 'Key …beef', 'fallback name: last four of the label')
    assert.strictEqual(byKey['key-0000aaaa'].limited, true, 'exhausted key is limited')
    assert.strictEqual(byKey['key-0000aaaa'].resetsAt, Date.UTC(2026, 10, 20), 'daily: next midnight UTC')
    assert.strictEqual(byKey['key-0000aaaa'].label, 'Bot ‹b›', 'names are sanitised')
    assert.strictEqual(byKey['key-9999ffff'].percent, 50, 'no reset: usage / limit')
    assert.strictEqual(byKey['key-9999ffff'].resetsAt, 0)
    assert.strictEqual(byKey['key-nolimit0'].amount, 0.25, 'an unlimited key: this month\'s spend')
    assert.ok(p.limits.every(function(l) { return l.label.indexOf('sk-or') < 0 }))

    const query = r.calls[3]
    assert.strictEqual(query.contentType, 'application/json')
    assert.strictEqual(query.body,
      '{"metrics":["cost"],"granularity":"month","time_range":{"start":"2026-09-01T00:00:00Z","end":"2026-11-01T00:00:00Z"}}')
    assertNoKey(r)
  })

  test('the cached baseline for this (month, N) skips analytics; N=0 never asks', function() {
    const env = { OPENROUTER_MANAGEMENT_KEY: MGMT }
    const cached = run({ env: env, routes: routes(), args: ['--openrouter-average-months', '2', '--openrouter-baseline', '2026-11:2:61.2000:' + NOW] })
    assert.deepStrictEqual(urls(cached), [KEYS0, CREDITS])
    assert.strictEqual(cached.or.money.baseline.average, 61.2)

    const otherN = run({ env: env, routes: routes(), args: ['--openrouter-average-months', '3', '--openrouter-baseline', '2026-11:2:61.2000:' + NOW] })
    assert.deepStrictEqual(urls(otherN), [KEYS0, CREDITS, META, QUERY], 'a new N asks again')
    assert.ok(otherN.calls[3].body.indexOf('"start":"2026-08-01T00:00:00Z"') > 0)
    assert.strictEqual(otherN.or.money.baseline.months, 3)
    assert.strictEqual(otherN.or.money.baseline.average, 40.8, 'complete answer with two rows: the missing month counts as 0')

    const lastMonth = run({ env: env, routes: routes(), args: ['--openrouter-baseline', '2026-10:2:50:' + (NOW - 30 * 86400000)] })
    assert.deepStrictEqual(urls(lastMonth), [KEYS0, CREDITS, META, QUERY], 'last month\'s baseline is stale')

    const off = run({ env: env, routes: routes(), args: ['--openrouter-average-months', '0'] })
    assert.deepStrictEqual(urls(off), [KEYS0, CREDITS], 'N=0: no analytics request')
    assert.strictEqual(off.or.money.baseline, null)

    const junk = run({ env: env, routes: routes(), args: ['--openrouter-average-months', 'lots', '--openrouter-baseline', '2026-11:2:x:1'] })
    assert.deepStrictEqual(urls(junk), [KEYS0, CREDITS, META, QUERY], 'malformed arguments: defaults, fresh query')
  })

  test('unavailable analytics is silent and retried at most once a day', function() {
    const env = { OPENROUTER_MANAGEMENT_KEY: MGMT }
    const cases = {}
    cases['meta 404'] = {}; cases['meta 404'][META] = { status: 404, body: {} }
    cases['no cost metric'] = {}; cases['no cost metric'][META] = { status: 200, body: { data: { metrics: [{ name: 'requests', display_format: 'number' }] } } }
    cases['query 500'] = {}; cases['query 500'][QUERY] = { status: 500, body: {} }
    cases['odd rows'] = {}; cases['odd rows'][QUERY] = { status: 200, body: { data: { data: [{ cost: 1 }, { cost: 2 }, { cost: 3 }] } } }
    cases['offline'] = {}; cases['offline'][QUERY] = { fail: 'offline' }
    for (const name of Object.keys(cases)) {
      const r = run({ env: env, routes: routes(cases[name]) })
      assert.strictEqual(r.or.error, '', name + ': not an error')
      assert.strictEqual(r.or.money.baseline.average, 0, name + ': no baseline')
      assert.strictEqual(r.or.money.baseline.checkedAt, NOW)
      assert.ok(Math.abs(r.or.money.spend - 41.75) < 1e-9, name + ': the rest still works')
    }
    const failed = '2026-11:2:0.0000:' + (NOW - 3600000)
    const soon = run({ env: env, routes: routes(), args: ['--openrouter-baseline', failed] })
    assert.deepStrictEqual(urls(soon), [KEYS0, CREDITS], 'a failed attempt is remembered for a day')
    assert.strictEqual(soon.or.money.baseline.checkedAt, NOW - 3600000)
    const later = run({ env: env, routes: routes(), args: ['--openrouter-baseline', '2026-11:2:0:' + (NOW - 25 * 3600000)] })
    assert.deepStrictEqual(urls(later), [KEYS0, CREDITS, META, QUERY], 'and retried after it')
  })

  test('management key errors: plain wording, no fallback, no key', function() {
    const env = { OPENROUTER_API_KEY: INFERENCE, OPENROUTER_MANAGEMENT_KEY: MGMT }
    const r401 = {}
    r401[KEYS0] = { status: 401, body: { error: { code: 401, message: 'API key expired ' + MGMT } } }
    const p401 = run({ env: env, routes: r401 })
    assert.deepStrictEqual(urls(p401), [KEYS0], 'no /key, no /credits after a 401')
    assert.strictEqual(p401.or.available, true)
    assert.strictEqual(p401.or.status, 'Management key expired or invalid')
    assert.ok(p401.or.error.indexOf('HTTP 401') >= 0)
    assert.ok(p401.or.error.indexOf('openrouter.ai/settings/management-keys') >= 0, 'says where to get a new key')
    assert.ok(p401.or.error.indexOf("The inference key isn't used while a management key is set.") >= 0)
    assert.strictEqual(p401.or.money, null)
    assert.deepStrictEqual(p401.or.limits, [])
    assertNoKey(p401)

    const r403 = {}
    r403[KEYS0] = { status: 403, body: { error: { message: 'Forbidden' } } }
    assert.ok(run({ env: env, routes: r403 }).or.error.indexOf("This management key isn't allowed to read the account's keys (HTTP 403).") === 0)
    const r404 = {}
    r404[KEYS0] = { status: 404, body: {} }
    const p404 = run({ env: env, routes: r404 })
    assert.ok(p404.or.error.indexOf("This management key can't list keys (personal accounts may need an organization).") === 0)
    assert.strictEqual(p404.or.status, "Management key can't list keys")
    const rNet = {}
    rNet[KEYS0] = { fail: 'connect ECONNREFUSED with Bearer ' + MGMT }
    const pNet = run({ env: env, routes: rNet })
    assert.ok(pNet.or.error.indexOf('connect ECONNREFUSED') === 0, pNet.or.error)
    assertNoKey(pNet)
    const r500 = {}
    r500[KEYS0] = { status: 500, body: { error: { message: 'boom' } } }
    assert.ok(run({ env: env, routes: r500 }).or.error.indexOf('boom (HTTP 500)') === 0)
    const rBad = {}
    rBad[KEYS0] = { status: 200, body: 'nope' }
    assert.ok(run({ env: env, routes: rBad }).or.error.indexOf('invalid JSON from OpenRouter') === 0)

    const noCredits = routes()
    noCredits[CREDITS] = { status: 404, body: {} }
    const pNoCredits = run({ env: env, routes: noCredits })
    assert.strictEqual(pNoCredits.or.error, '', 'credits 404 is tolerated')
    assert.strictEqual(pNoCredits.or.money.credits, null)
    assert.strictEqual(pNoCredits.or.limits[0].key, 'key-f01d4a2b', 'no Credits row')
    const credits401 = routes()
    credits401[CREDITS] = { status: 401, body: {} }
    const pCredits401 = run({ env: env, routes: credits401 })
    assert.strictEqual(pCredits401.or.status, 'Management key expired or invalid')
    assert.strictEqual(pCredits401.or.money, null, 'no partial numbers')
  })

  test('pagination follows full pages and stops at ten', function() {
    const env = { OPENROUTER_MANAGEMENT_KEY: MGMT }
    const page0 = { data: [] }
    for (let i = 0; i < 100; i++) page0.data.push(keyJSON({ hash: 'p0' + String(i).padStart(6, '0'), name: 'k' + i, usage_monthly: 0.01 }))
    const two = { }
    two[KEYS0] = { status: 200, body: page0 }
    two['GET ' + API + '/keys?offset=100'] = { status: 200, body: { data: [keyJSON({ hash: 'p1last', name: 'last', limit: 2, limit_remaining: 1, limit_reset: 'monthly', usage_monthly: 1 })] } }
    two[CREDITS] = { status: 200, body: CREDITS_OK }
    const p = run({ env: env, routes: two, args: ['--openrouter-average-months', '0'] })
    assert.deepStrictEqual(urls(p), [KEYS0, 'GET ' + API + '/keys?offset=100', CREDITS])
    assert.strictEqual(p.or.status, '101 keys')
    assert.strictEqual(p.or.limits.length, 13, 'credits + at most twelve keys')
    assert.strictEqual(p.or.limits[1].key, 'key-p1last', 'most spend first, across pages')

    const capped = {}
    for (let i = 0; i < 12; i++) capped['GET ' + API + '/keys?offset=' + (i * 100)] = { status: 200, body: page0 }
    capped[CREDITS] = { status: 200, body: CREDITS_OK }
    const pc = run({ env: env, routes: capped, args: ['--openrouter-average-months', '0'] })
    assert.strictEqual(pc.calls.filter(function(c) { return c.url.indexOf('/keys') >= 0 }).length, 10, 'at most ten pages')
    assert.strictEqual(pc.or.status, '1000 keys')
  })

  test('the Secret Service is used next, the file last', function() {
    const viaSecret = run({ env: { FAKE_SECRET_MODE: 'key', FAKE_SECRET_VALUE: 'sk-or-v1-from-secret-service-0001' }, routes: routes() })
    assert.strictEqual(viaSecret.or.keySource, 'secret-service')
    assert.strictEqual(viaSecret.calls[0].authorization, 'Bearer sk-or-v1-from-secret-service-0001')
    assert.deepStrictEqual(viaSecret.secretCalls, ['lookup service agent-meters account openrouter-management'])
    assertNoKey(viaSecret)

    writeKeyFile('sk-or-v1-from-file-key-00000002\n', 0o700, 0o600)
    const viaFile = run({ env: { OPENROUTER_API_KEY: INFERENCE }, routes: routes() })
    assert.strictEqual(viaFile.or.keySource, 'file')
    assert.strictEqual(viaFile.calls[0].authorization, 'Bearer sk-or-v1-from-file-key-00000002')
    assertNoKey(viaFile)

    const secretFirst = run({ env: { FAKE_SECRET_MODE: 'key', FAKE_SECRET_VALUE: 'sk-or-v1-from-secret-service-0001' }, routes: routes() })
    assert.strictEqual(secretFirst.or.keySource, 'secret-service', 'Secret Service before the file')

    const junk = run({ env: { FAKE_SECRET_MODE: 'key', FAKE_SECRET_VALUE: 'not a key' }, routes: routes() })
    assert.strictEqual(junk.or.keySource, 'file', 'a malformed Secret Service item counts as none')
    clearKeyFile()
  })

  test('an unsafe key file is refused with a clear error and no fallback', function() {
    const env = { OPENROUTER_API_KEY: INFERENCE }
    writeKeyFile(MGMT + '\n', 0o700, 0o644)
    const loose = run({ env: env, routes: routes() })
    assert.strictEqual(loose.or.available, true, 'a refused key file is shown')
    assert.strictEqual(loose.or.keySource, 'file')
    assert.ok(loose.or.error.indexOf('must be mode 0600') >= 0, loose.or.error)
    assert.ok(loose.or.error.indexOf("The inference key isn't used") >= 0)
    assert.deepStrictEqual(loose.calls, [], 'no request at all, not even with the inference key')
    assertNoKey(loose)

    writeKeyFile(MGMT + '\n', 0o755, 0o600)
    const openDir = run({ env: env, routes: routes() })
    assert.ok(openDir.or.error.indexOf('must be mode 0700') >= 0, openDir.or.error)
    assert.deepStrictEqual(openDir.calls, [])

    const target = path.join(tmp, 'elsewhere-key')
    fs.writeFileSync(target, MGMT + '\n')
    fs.chmodSync(target, 0o600)
    const file = writeKeyFile('x', 0o700, 0o600)
    fs.rmSync(file)
    fs.symlinkSync(target, file)
    const linked = run({ env: env, routes: routes() })
    assert.ok(linked.or.error.indexOf('is a symlink') >= 0, linked.or.error)
    assert.deepStrictEqual(linked.calls, [])
    assertNoKey(linked)

    clearKeyFile()
    fs.mkdirSync(path.join(home, '.local/share'), { recursive: true })
    const realDir = path.join(tmp, 'real-dir')
    fs.mkdirSync(realDir, { mode: 0o700 })
    fs.writeFileSync(path.join(realDir, 'openrouter-management-key'), MGMT, { mode: 0o600 })
    fs.symlinkSync(realDir, managementDir())
    const linkedDir = run({ env: env, routes: routes() })
    assert.ok(linkedDir.or.error.indexOf('not a plain directory') >= 0, linkedDir.or.error)
    assert.deepStrictEqual(linkedDir.calls, [])
    fs.rmSync(managementDir())

    writeKeyFile('not a key\n', 0o700, 0o600)
    const garbage = run({ env: env, routes: routes() })
    assert.ok(garbage.or.error.indexOf('does not hold a valid management key') >= 0, garbage.or.error)
    clearKeyFile()
  })

  test('a Secret Service that does not answer is an error, not "no key"', function() {
    const r = run({ env: { OPENROUTER_API_KEY: INFERENCE, FAKE_SECRET_MODE: 'hang' }, routes: routes() })
    assert.strictEqual(r.or.available, true)
    assert.strictEqual(r.or.keySource, 'secret-service')
    assert.ok(r.or.error.indexOf('did not answer') >= 0, r.or.error)
    assert.deepStrictEqual(r.calls, [], 'no fallback to the inference key')

    writeKeyFile('sk-or-v1-from-file-key-00000002\n', 0o700, 0o600)
    const withFile = run({ env: { FAKE_SECRET_MODE: 'hang' }, routes: routes() })
    assert.strictEqual(withFile.or.keySource, 'file', 'the file still serves when the keyring hangs')
    clearKeyFile()
  })

  test('Grok Bot alone shows Grok with both meters', function() {
    const botDir = path.join(tmp, 'bot')
    fs.mkdirSync(botDir, { recursive: true })
    const later = Math.max(Date.now(), NOW) + 3 * 86400000
    fs.writeFileSync(path.join(botDir, 'usage.blob'), JSON.stringify({
      value: { expiresAtMs: later, reading: { readAtMs: NOW - 60000, usage: { percentUsed: 42, nextResetMs: later, grokPlanLabel: 'SuperGrok' } } }
    }))
    const r = run({ botHome: botDir })
    const grok = r.byId.grok
    assert.strictEqual(grok.available, true)
    assert.strictEqual(grok.error, '')
    assert.strictEqual(grok.source, 'grok-bot')
    assert.strictEqual(grok.tier, 'SuperGrok', 'plan label from the Bot reading')
    assert.deepStrictEqual(grok.limits.map(function(l) { return l.key }), ['weekly', 'bot'])
    assert.strictEqual(grok.limits[0].detail, 'Weekly limit')
    assert.strictEqual(grok.limits[0].percent, 0)
    assert.strictEqual(grok.limits[0].resetsAt, 0)
    assert.strictEqual(grok.limits[0].stale, false)
    assert.strictEqual(grok.limits[1].detail, 'Grok Bot weekly')
    assert.strictEqual(grok.limits[1].percent, 42)
    assert.strictEqual(grok.limits[1].stale, false)
  })

  test('set-management-key.sh stores via stdin only and refuses arguments', function() {
    const helper = path.join(repo, 'scripts/set-management-key.sh')
    const env = Object.assign({}, baseEnv)
    const storeIn = path.join(tmp, 'secret-store.stdin')
    let out = execFileSync('bash', [helper], { input: '  ' + MGMT + '\n', env: env, encoding: 'utf8' })
    assert.ok(out.indexOf('Secret Service') >= 0)
    assert.strictEqual(out.indexOf(MGMT), -1, 'never printed')
    assert.strictEqual(fs.readFileSync(storeIn, 'utf8'), MGMT, 'the key reached secret-tool on stdin, trimmed')
    const log = fs.readFileSync(secretLog, 'utf8')
    assert.ok(log.indexOf('store --label=Agent Meters: OpenRouter management key service agent-meters account openrouter-management') >= 0, log)
    assert.strictEqual(log.indexOf(MGMT), -1, 'never on secret-tool argv')

    out = execFileSync('bash', [helper, '--file'], { input: MGMT + '\n', env: env, encoding: 'utf8' })
    const file = path.join(managementDir(), 'openrouter-management-key')
    assert.strictEqual(fs.readFileSync(file, 'utf8'), MGMT + '\n')
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600)
    assert.strictEqual(fs.statSync(managementDir()).mode & 0o777, 0o700)
    assert.strictEqual(out.indexOf(MGMT), -1)
    const collected = run({ routes: routes() })
    assert.strictEqual(collected.or.keySource, 'file', 'the collector accepts what the helper wrote')

    execFileSync('bash', [helper, '--remove'], { env: env, encoding: 'utf8' })
    assert.ok(!fs.existsSync(file), 'removed')
    assert.ok(fs.readFileSync(secretLog, 'utf8').indexOf('clear service agent-meters account openrouter-management') >= 0)

    let refused = false
    try {
      execFileSync('bash', [helper, MGMT], { env: env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      refused = e.status === 2 && String(e.stderr).indexOf(MGMT) < 0
    }
    assert.ok(refused, 'a key on the command line is refused without echoing it')
    let rejected = false
    try {
      execFileSync('bash', [helper, '--file'], { input: 'short\n', env: env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (e) {
      rejected = e.status === 1
    }
    assert.ok(rejected && !fs.existsSync(file), 'a malformed key is not stored')
    clearKeyFile()
  })
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

// Pure helpers, with explicit times.
const C = require('./collect.js')

test('reset helpers land on UTC boundaries', function() {
  const u = function(y, m, d, h, mi, s) { return Date.UTC(y, m - 1, d, h || 0, mi || 0, s || 0) }
  assert.strictEqual(C.nextDailyReset(u(2026, 11, 19, 23, 59, 59)), u(2026, 11, 20))
  assert.strictEqual(C.nextDailyReset(u(2026, 11, 20)), u(2026, 11, 21), 'exact midnight: the next one')
  assert.strictEqual(C.nextDailyReset(u(2026, 12, 31, 18)), u(2027, 1, 1))
  assert.strictEqual(C.nextWeeklyReset(u(2026, 11, 19, 12)), u(2026, 11, 23), 'Thursday: Monday')
  assert.strictEqual(C.nextWeeklyReset(u(2026, 11, 22, 23, 59)), u(2026, 11, 23), 'Sunday night: Monday')
  assert.strictEqual(C.nextWeeklyReset(u(2026, 11, 23)), u(2026, 11, 30), 'Monday 00:00: next Monday')
  assert.strictEqual(C.nextWeeklyReset(u(2026, 12, 31, 8)), u(2027, 1, 4))
  assert.strictEqual(C.nextMonthlyReset(u(2026, 11, 19, 12)), u(2026, 12, 1))
  assert.strictEqual(C.nextMonthlyReset(u(2026, 12, 1)), u(2027, 1, 1), 'exact 1st: next month')
  assert.strictEqual(C.nextMonthlyReset(u(2026, 12, 31, 23, 59, 59)), u(2027, 1, 1))
  assert.strictEqual(C.nextReset('Weekly', u(2026, 11, 19, 12)), u(2026, 11, 23))
  assert.strictEqual(C.nextReset(null, u(2026, 11, 19, 12)), 0)
  assert.strictEqual(C.nextReset('yearly', u(2026, 11, 19, 12)), 0)
})

test('analytics: metric selection, request body and strict parsing', function() {
  const metric = function(name, label, format, rate) {
    return { name: name, display_label: label || '', display_format: format || 'currency', is_rate: rate === true }
  }
  const meta = function(list) { return { data: { metrics: list } } }
  assert.strictEqual(C.pickCostMetric(meta([metric('requests', 'Requests', 'number'), metric('cost', 'Cost')])), 'cost')
  assert.strictEqual(C.pickCostMetric(meta([metric('cost_per_token', 'Cost per token', 'currency', true),
    metric('byok_cost', 'BYOK cost'), metric('total_usage', 'Usage')])), 'total_usage', 'no rates, no BYOK')
  assert.strictEqual(C.pickCostMetric(meta([metric('upstream_spend', 'Upstream spend'), metric('billed', 'Billed cost')])), 'billed')
  assert.strictEqual(C.pickCostMetric(meta([metric('latency', 'Latency', 'latency'), metric('tokens', '', 'number')])), null)
  assert.strictEqual(C.pickCostMetric(meta([metric('cost"} evil', 'Cost')])), null, 'odd names never reach a body')
  assert.strictEqual(C.pickCostMetric({ data: {} }), null)

  const at = function(y, m, d) { return Date.UTC(y, m - 1, d || 1) }
  assert.strictEqual(C.queryBody('cost', at(2027, 1, 15), 2),
    '{"metrics":["cost"],"granularity":"month","time_range":{"start":"2026-11-01T00:00:00Z","end":"2027-01-01T00:00:00Z"}}')
  assert.strictEqual(C.queryBody('cost', at(2026, 11, 19), 1),
    '{"metrics":["cost"],"granularity":"month","time_range":{"start":"2026-10-01T00:00:00Z","end":"2026-11-01T00:00:00Z"}}')
  assert.strictEqual(C.queryBody('cost', at(2026, 11, 19), 0), null)
  assert.strictEqual(C.queryBody('bad name', at(2026, 11, 19), 2), null)
  assert.strictEqual(C.monthKey(Date.UTC(2027, 0, 31, 23)), '2027-01')

  const start = at(2026, 9), end = at(2026, 11)
  const parse = function(doc) { return C.parseTotal(doc, 'cost', start, end, 2) }
  assert.strictEqual(parse({ data: { data: [{ date: '2026-09-01T00:00:00Z', cost: 60 }, { date: '2026-10-01', cost: '62.4' }], metadata: { row_count: 2, truncated: false } } }), 122.4)
  assert.strictEqual(parse({ data: { data: [{ cost: 60, x: 1 }, { cost: 62.4 }] } }), 122.4, 'two rows, no buckets')
  assert.strictEqual(parse({ data: { data: [{ month: '2026-10', cost: 50 }], metadata: { row_count: 1, truncated: false } } }), 50, 'complete answer: missing month is 0')
  assert.strictEqual(parse({ data: { data: [{ cost: 50 }], metadata: { row_count: 1, truncated: false } } }), null, 'one row without a bucket')
  assert.strictEqual(parse({ data: { data: [{ month: '2026-10', cost: 50 }] } }), null, 'one row, no metadata')
  assert.strictEqual(parse({ data: { data: [{ cost: 1 }, { cost: 2 }], metadata: { truncated: true } } }), null, 'truncated')
  assert.strictEqual(parse({ data: { data: [{ cost: 1 }, { cost: 2 }, { cost: 3 }] } }), null, 'too many rows')
  assert.strictEqual(parse({ data: { data: [{ cost: -1 }, { cost: 2 }] } }), null, 'negative')
  assert.strictEqual(parse({ data: { data: [{ spend: 1 }, { cost: 2 }] } }), null, 'metric missing')
  assert.strictEqual(parse({ data: { data: [{ date: '2026-08-01', cost: 1 }, { cost: 2 }] } }), null, 'bucket outside the range')
  assert.strictEqual(parse({ data: { data: [{ date: '2026-10-01', cost: 1 }, { date: '2026-10-15', cost: 2 }] } }), null, 'same month twice')
  assert.strictEqual(parse({ data: [] }), null)
  assert.strictEqual(parse({ data: { data: [], metadata: { row_count: 0, truncated: false } } }), 0)
  assert.strictEqual(parse({ data: { data: [{ id: '1', cost: 1 }, { cost: 2 }] } }), 3, 'a number-like string is not a date')
  assert.strictEqual(C.bucketDateMs('1'), null)
  assert.strictEqual(C.bucketDateMs('2026-13'), null)
  assert.strictEqual(C.bucketDateMs('2026-10-01 00:00:00'), Date.UTC(2026, 9, 1), 'no zone: UTC')

  assert.deepStrictEqual(C.parseBaselineArg('2026-11:2:61.2000:1794571200000'), { month: '2026-11', months: 2, average: 61.2, checkedAt: 1794571200000 })
  assert.strictEqual(C.parseBaselineArg('2026-11:13:1:1'), null)
  assert.strictEqual(C.parseBaselineArg('2026-11:2:-1:1'), null)
  assert.strictEqual(C.parseBaselineArg('$(rm -rf):2:1:1'), null)
})

test('key names never carry the full label; scrub removes keys from text', function() {
  assert.strictEqual(C.keyName({ name: '  ', label: 'sk-or-v1-abc...beef' }), 'Key …beef')
  assert.strictEqual(C.keyName({ name: null, label: '...' }), 'Key')
  const scrubbed = C.scrub('failed for sk-or-v1-0123456789abcdef with Bearer sk-or-v1-zzzzzzzzzzzz and secret-value-123456', 'secret-value-123456')
  assert.strictEqual(scrubbed.indexOf('sk-or-v1-0123'), -1)
  assert.strictEqual(scrubbed.indexOf('zzzz'), -1)
  assert.strictEqual(scrubbed.indexOf('secret-value'), -1)
  assert.strictEqual(C.normalizeManagementKey(' sk-or-v1-0123456789abcdef \n'), 'sk-or-v1-0123456789abcdef')
  assert.strictEqual(C.normalizeManagementKey('sk-or-v1 0123456789abcdef'), '')
  assert.strictEqual(C.normalizeManagementKey('short'), '')
  assert.strictEqual(C.pickMoney({ data: { label: 'x', limit: 10, limit_reset: 'daily', usage_daily: 2, usage_monthly: 9 } }).spend, 2)
})

process.stdout.write('all collector tests passed\n')
