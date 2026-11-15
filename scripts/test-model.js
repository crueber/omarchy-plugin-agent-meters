#!/usr/bin/env node
'use strict'

// Round-trip the Agent Meters model helpers without network or QML.

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const repo = path.resolve(__dirname, '..')
const source = fs.readFileSync(path.join(repo, 'Model.js'), 'utf8')
  .replace(/^\.pragma library\s*$/m, '')
const context = {
  console, Date, JSON, Math, String, Number, Array, Object, isFinite, RegExp
}
vm.createContext(context)
vm.runInContext(source, context)

const M = context
const now = Date.UTC(2026, 10, 15, 12, 0, 0)
const cycleEnd = Date.UTC(2026, 11, 1, 0, 0, 0)

function provider(overrides) {
  return Object.assign({
    id: 'claude',
    name: 'Claude',
    available: true,
    tier: 'Max 5x',
    status: '',
    error: '',
    source: 'test',
    limits: [],
    activity: { period: 'today', prompts: 0, tokens: 0, totalPrompts: 0, accounts: 0 },
    money: null,
    budgets: []
  }, overrides || {})
}

function limit(key, percent, resetsAt, extra) {
  return Object.assign({
    key: key,
    label: key,
    short: key === 'session' ? '5h' : key === 'weekly' ? '7d' : key,
    detail: key,
    percent: percent,
    resetsAt: resetsAt || 0,
    stale: false
  }, extra || {})
}

function result(providers) {
  return JSON.stringify({ ok: true, fetchedAt: now, providers: providers })
}

function test(name, fn) {
  fn()
  process.stdout.write('ok — ' + name + '\n')
}

test('parses and sanitises a collector result', function() {
  const parsed = M.parseResult(result([
    provider({
      id: 'claude',
      limits: [limit('session', 12, cycleEnd), limit('weekly', 45, cycleEnd), limit('fable', 8, cycleEnd)],
      tier: '<b>Max</b>'
    }),
    { id: 'nope' },
    provider({ id: 'opencode', limits: [limit('session', 1, cycleEnd)] })
  ]))
  assert.strictEqual(parsed.ok, true)
  assert.strictEqual(parsed.providers.length, 2)
  assert.strictEqual(parsed.providers[0].tier, '\u2039b\u203aMax\u2039/b\u203a')
  assert.strictEqual(parsed.providers[0].limits.length, 3)
  assert.strictEqual(parsed.providers[0].limits[2].key, 'fable')
})

test('rejects an unreadable or failed result', function() {
  assert.strictEqual(M.parseResult('not json'), null)
  assert.strictEqual(M.parseResult(JSON.stringify({ ok: false, error: 'boom' })).ok, false)
})

test('orders and filters the visible providers', function() {
  const list = [
    provider({ id: 'openrouter' }),
    provider({ id: 'opencode' }),
    provider({ id: 'grok' }),
    provider({ id: 'claude' }),
    provider({ id: 'grok', available: false })
  ]
  const order = M.visibleProviders(list, {}).map(function(p) { return p.id }).join(',')
  assert.strictEqual(order, 'claude,grok,opencode,openrouter')
  const hidden = M.visibleProviders(list, { claude: false, openrouter: false }).map(function(p) { return p.id }).join(',')
  assert.strictEqual(hidden, 'grok,opencode')
})

test('honours a saved agent order and moves within it', function() {
  const list = [
    provider({ id: 'openrouter' }),
    provider({ id: 'opencode' }),
    provider({ id: 'grok' }),
    provider({ id: 'claude' })
  ]
  const ordered = M.orderedProviders(list, {}, 'grok,claude').map(function(p) { return p.id }).join(',')
  assert.strictEqual(ordered, 'grok,claude,opencode,openrouter')
  assert.strictEqual(M.parseOrder('grok, bogus, grok, claude').join(','), 'grok,claude')
  assert.strictEqual(M.moveOrder('grok,claude,opencode,openrouter', 'claude', -1).join(','), 'claude,grok,opencode,openrouter')
  assert.strictEqual(M.moveOrder('claude,grok', 'claude', -1).join(','), 'claude,grok')
  assert.strictEqual(M.moveOrder('claude,grok', 'claude', 1).join(','), 'grok,claude')
})

test('computes a drag-and-drop insertion order', function() {
  const all = ['claude', 'grok', 'opencode', 'openrouter']
  assert.strictEqual(M.reorderInsert('', all, 'openrouter', 0).join(','), 'openrouter,claude,grok,opencode')
  assert.strictEqual(M.reorderInsert('', all, 'claude', 3).join(','), 'grok,opencode,openrouter,claude')
  assert.strictEqual(M.reorderInsert('', all, 'grok', 1).join(','), 'claude,grok,opencode,openrouter')
  // A hidden agent keeps its slot when two visible agents swap around it.
  assert.strictEqual(M.reorderInsert('claude,grok,opencode', ['claude', 'opencode'], 'opencode', 0).join(','), 'opencode,claude,grok,openrouter')
  assert.strictEqual(M.reorderInsert('', all, 'claude', 99).join(','), 'grok,opencode,openrouter,claude')
  assert.strictEqual(M.reorderInsert('', all, 'claude', -5).join(','), 'claude,grok,opencode,openrouter')
})

test('filters shown agents without changing their order', function() {
  const list = [
    provider({ id: 'opencode' }),
    provider({ id: 'claude' }),
    provider({ id: 'openrouter' })
  ]
  assert.strictEqual(M.shownProviders(list, {}).map(function(p) { return p.id }).join(','), 'opencode,claude,openrouter')
  assert.strictEqual(M.shownProviders(list, { claude: false }).map(function(p) { return p.id }).join(','), 'opencode,openrouter')
  assert.strictEqual(M.shownProviders(list, { claude: false, opencode: false, openrouter: false }).length, 0)
})

test('maps percentages to states at the configured thresholds', function() {
  assert.strictEqual(M.stateOf(12, 70, 90), 'normal')
  assert.strictEqual(M.stateOf(70, 70, 90), 'warning')
  assert.strictEqual(M.stateOf(90, 70, 90), 'critical')
  assert.strictEqual(M.percentText(45.5), '45.5%')
  assert.strictEqual(M.percentText(0), '0%')
})

test('formats money, counts and resets', function() {
  assert.strictEqual(M.formatCurrency(1234.5), '$1,234.50')
  assert.strictEqual(M.formatCurrency(null), '\u2014')
  assert.strictEqual(M.formatCount(1074715), '1.1M')
  assert.strictEqual(M.formatCount(135), '135')
  assert.strictEqual(M.resetText(now + 3 * 3600000, now), 'Resets in 3h 0m')
  assert.strictEqual(M.resetText(now - 1, now), 'Reset is due')
})

test('builds a meter window for a limited OpenRouter key', function() {
  const report = provider({
    id: 'openrouter',
    money: {
      label: 'sk-or-v1-123...abc',
      limit: 20,
      spend: 10,
      resetInterval: 'monthly',
      resetsAt: cycleEnd,
      credits: { total: 50, used: 20, remaining: 30 }
    }
  })
  const window = M.openrouterWindow(report, M.emptyHistory(), 70, 90)
  assert.strictEqual(window.mode, 'meter')
  assert.strictEqual(window.percent, 50)
  assert.strictEqual(window.effectiveLimit, 20)
  assert.strictEqual(window.color, 'normal')
})

test('uses the previous cycle as the limit for an unlimited key', function() {
  const report = provider({
    id: 'openrouter',
    money: { label: 'key', limit: null, spend: 8, resetInterval: 'monthly', resetsAt: cycleEnd, credits: null }
  })
  const history = M.normalizeHistory({
    current: { key: 'c', end: cycleEnd, spend: 8, lastObservedAt: now },
    previous: { key: 'p', end: cycleEnd - 30 * 86400000, spend: 12, lastObservedAt: cycleEnd - 30 * 86400000 }
  })
  const window = M.openrouterWindow(report, history, 70, 90)
  assert.strictEqual(window.mode, 'meter')
  assert.strictEqual(window.effectiveLimit, 12)
  assert.strictEqual(window.percent, 66.66666666666666)

  const over = M.openrouterWindow(Object.assign({}, report, {
    money: Object.assign({}, report.money, { spend: 13 })
  }), history, 70, 90)
  assert.strictEqual(over.mode, 'dollars')
  assert.strictEqual(over.color, 'yellow')
})

test('advances one previous cycle only when it was observed near its end', function() {
  const first = M.advanceHistory(M.emptyHistory(), {
    label: 'key', limit: 20, spend: 3, resetInterval: 'monthly', resetsAt: cycleEnd, credits: null
  }, now)
  assert.strictEqual(first.current.end, cycleEnd)

  const same = M.advanceHistory(first, {
    label: 'key', limit: 20, spend: 5, resetInterval: 'monthly', resetsAt: cycleEnd, credits: null
  }, now + 1000)
  assert.strictEqual(same.current.spend, 5)

  const observedLate = M.advanceHistory({ current: Object.assign({}, same.current, { lastObservedAt: cycleEnd }), previous: null }, {
    label: 'key', limit: 20, spend: 0, resetInterval: 'monthly', resetsAt: cycleEnd + 30 * 86400000, credits: null
  }, cycleEnd + 1000)
  assert.ok(observedLate.previous)
  assert.strictEqual(observedLate.previous.spend, 5)
})

test('round-trips the cache with no key material', function() {
  const providerList = [
    provider({ id: 'claude', limits: [limit('session', 12, cycleEnd)] }),
    provider({
      id: 'openrouter',
      money: {
        label: 'sk-or-v1-123...abc',
        limit: 20,
        spend: 4,
        resetInterval: 'monthly',
        resetsAt: cycleEnd,
        credits: null
      }
    })
  ]
  const raw = M.serializeCache(providerList, M.emptyHistory(), now, now, 0, '')
  assert.ok(raw.length < 8000)
  assert.strictEqual(raw.indexOf('Bearer'), -1)
  const parsed = M.parseCache(raw, now)
  assert.strictEqual(parsed.providers.length, 2)
  assert.strictEqual(parsed.providers[1].money.limit, 20)
  assert.strictEqual(M.parseCache('{"version":99}', now), null)
})

test('writes compact bar text and a multi-line tooltip', function() {
  const grok = provider({
    id: 'grok',
    name: 'Grok',
    tier: 'SuperGrok',
    limits: [limit('weekly', 2, cycleEnd), limit('bot', 42, cycleEnd, { short: 'bot', stale: true })]
  })
  assert.strictEqual(M.compactText(grok, M.emptyHistory(), 70, 90), '7d 2% · bot —')
  const tip = M.providerTooltip(grok, M.emptyHistory(), now, 70, 90)
  assert.ok(tip.indexOf('Grok · SuperGrok') === 0)
  assert.ok(tip.indexOf('stale') > 0)
})

process.stdout.write('all model tests passed\n')
