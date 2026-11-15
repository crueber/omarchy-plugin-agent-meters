.pragma library

// Pure helpers for the Agent Meters widget: parsing the collector's provider
// list, window/state computation, OpenRouter cycle comparison, cache handling
// and the multi-monitor poll coordination. No QML imports and no I/O, so the
// whole file is unit-testable with plain Node.

var CACHE_VERSION = 1
var PROVIDER_ORDER = ["claude", "grok", "opencode", "openrouter"]
var AUTO_MIN_MS = 60000
var FORCE_MIN_MS = 30000
var FAILURE_CAP_MS = 600000

// ----------------------------------------------------------------- sanitizers

function number(value) {
  if (value === null || value === undefined || value === '') return null
  var n = Number(value)
  return isFinite(n) ? n : null
}

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value))
}

function clampInt(value, low, high, fallback) {
  var n = Number(value)
  if (!isFinite(n)) return fallback
  return Math.round(clamp(n, low, high))
}

function text(value, max) {
  if (typeof value !== "string") return ""
  return value.slice(0, max || 200)
}

// Omarchy-owned components render plain text only when told to; neutralise
// markup-shaped data at the boundary instead of trusting every sink.
function plain(value, max) {
  return text(value, max).replace(/</g, "\u2039").replace(/>/g, "\u203a")
}

function dateMs(value) {
  var n = Number(value)
  if (isFinite(n) && n > 0) return n <= 1e12 ? Math.round(n * 1000) : Math.round(n)
  var parsed = Date.parse(String(value || ""))
  return isFinite(parsed) ? parsed : 0
}

function parseJson(raw) {
  if (typeof raw !== "string") return null
  var value = raw.replace(/^\uFEFF/, "").trim()
  if (value === "" || value.length > 400000) return null
  try {
    return JSON.parse(value)
  } catch (e) {}
  var start = value.indexOf("{")
  var end = value.lastIndexOf("}")
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(value.slice(start, end + 1))
    } catch (e) {}
  }
  return null
}

function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'"
}

// --------------------------------------------------------------- window model

function percent(value, maxValue) {
  var n = number(value)
  return n === null ? 0 : clamp(n, 0, maxValue === undefined ? 100 : maxValue)
}

function stateOf(value, warnPercent, criticalPercent) {
  var n = number(value) || 0
  if (n >= criticalPercent) return "critical"
  if (n >= warnPercent) return "warning"
  return "normal"
}

function highest(list) {
  var best = null
  for (var i = 0; i < (list || []).length; i++) {
    var item = list[i]
    if (!item) continue
    if (best === null || (number(item.percent) || 0) > (number(best.percent) || 0)) best = item
  }
  return best
}

function percentText(value) {
  var n = number(value)
  if (n === null) return "\u2014"
  var rounded = Math.round(clamp(n, 0, 100) * 10) / 10
  return (rounded % 1 === 0 ? String(Math.round(rounded)) : String(rounded)) + "%"
}

function formatCurrency(value) {
  var n = number(value)
  if (n === null) return "\u2014"
  var sign = n < 0 ? "-" : ""
  var fixed = Math.abs(n).toFixed(2)
  var parts = fixed.split(".")
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",")
  return sign + "$" + parts.join(".")
}

function formatCount(value) {
  var n = number(value)
  if (n === null) return "\u2014"
  var abs = Math.abs(n)
  if (abs >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, "") + "B"
  if (abs >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M"
  if (abs >= 1e4) return Math.round(n / 1e3) + "K"
  if (abs >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K"
  return String(Math.round(n))
}

function resetText(resetsAt, nowMs) {
  var at = number(resetsAt) || 0
  if (at <= 0) return ""
  var delta = at - (Number(nowMs) || Date.now())
  if (delta <= 0) return "Reset is due"
  var minutes = Math.round(delta / 60000)
  if (minutes < 60) return "Resets in " + Math.max(1, minutes) + "m"
  var hours = Math.floor(minutes / 60)
  if (hours < 48) return "Resets in " + hours + "h " + (minutes % 60) + "m"
  var days = Math.floor(hours / 24)
  return "Resets in " + days + "d " + (hours % 24) + "h"
}

function updatedText(lastFetchMs, nowMs) {
  var at = number(lastFetchMs) || 0
  if (at <= 0) return ""
  var seconds = Math.max(0, Math.round(((Number(nowMs) || Date.now()) - at) / 1000))
  if (seconds < 15) return "Updated just now"
  if (seconds < 90) return "Updated " + seconds + "s ago"
  var minutes = Math.round(seconds / 60)
  if (minutes < 90) return "Updated " + minutes + "m ago"
  return "Updated " + Math.round(minutes / 60) + "h ago"
}

function tokensText(value) {
  var n = number(value) || 0
  if (n <= 0) return ""
  return formatCount(n) + " tokens"
}

function intervalName(value) {
  var text = String(value || "").toLowerCase()
  if (text.indexOf("week") >= 0) return "Weekly"
  if (text.indexOf("day") >= 0) return "Daily"
  if (text.indexOf("year") >= 0 || text.indexOf("annual") >= 0) return "Yearly"
  if (text === "total" || text === "lifetime" || text === "none") return "No reset"
  return "Monthly"
}

// ------------------------------------------------------------- provider model

function emptyActivity() {
  return { period: "today", prompts: 0, tokens: 0, totalPrompts: 0, accounts: 0 }
}

function normalizeActivity(value) {
  var source = value && typeof value === "object" ? value : {}
  return {
    period: source.period === "week" ? "week" : "today",
    prompts: Math.max(0, Math.round(number(source.prompts) || 0)),
    tokens: Math.max(0, Math.round(number(source.tokens) || 0)),
    totalPrompts: Math.max(0, Math.round(number(source.totalPrompts) || 0)),
    accounts: Math.max(0, Math.round(number(source.accounts) || 0))
  }
}

function normalizeLimit(value) {
  if (!value || typeof value !== "object") return null
  var key = plain(value.key, 24)
  if (key === "") return null
  return {
    key: key,
    label: plain(value.label, 40) || key,
    short: plain(value.short, 12) || key,
    detail: plain(value.detail, 80) || plain(value.label, 40) || key,
    percent: percent(value.percent),
    resetsAt: dateMs(value.resetsAt),
    stale: value.stale === true
  }
}

function normalizeMoney(value) {
  if (!value || typeof value !== "object") return null
  var credits = value.credits && typeof value.credits === "object"
    ? {
      total: Math.max(0, number(value.credits.total) || 0),
      used: Math.max(0, number(value.credits.used) || 0),
      remaining: Math.max(0, number(value.credits.remaining) || 0)
    }
    : null
  return {
    label: plain(value.label, 80),
    limit: number(value.limit) !== null && number(value.limit) > 0 ? number(value.limit) : null,
    spend: Math.max(0, number(value.spend) || 0),
    resetInterval: String(value.resetInterval || "monthly").slice(0, 24),
    resetsAt: dateMs(value.resetsAt),
    credits: credits
  }
}

function normalizeBudget(value) {
  if (!value || typeof value !== "object") return null
  var limit = Math.max(0, number(value.limit) || 0)
  if (limit <= 0) return null
  var spent = Math.max(0, number(value.spent) || 0)
  return {
    id: plain(value.id, 60) || "budget",
    limit: limit,
    spent: spent,
    percent: clamp(spent / limit * 100, 0, 100),
    resetsAt: dateMs(value.resetsAt)
  }
}

function normalizeProvider(value) {
  if (!value || typeof value !== "object") return null
  var id = plain(value.id, 24)
  if (id === "" || PROVIDER_ORDER.indexOf(id) < 0) return null
  var limits = []
  var list = Array.isArray(value.limits) ? value.limits : []
  for (var i = 0; i < list.length && limits.length < 6; i++) {
    var limit = normalizeLimit(list[i])
    if (limit) limits.push(limit)
  }
  var budgets = []
  var rawBudgets = Array.isArray(value.budgets) ? value.budgets : []
  for (var j = 0; j < rawBudgets.length && budgets.length < 6; j++) {
    var budget = normalizeBudget(rawBudgets[j])
    if (budget) budgets.push(budget)
  }
  return {
    id: id,
    name: plain(value.name, 40) || id,
    available: value.available === true,
    tier: plain(value.tier, 60),
    status: plain(value.status, 120),
    hint: plain(value.hint, 240),
    error: plain(value.error, 240),
    source: plain(value.source, 40),
    limits: limits,
    activity: normalizeActivity(value.activity),
    money: normalizeMoney(value.money),
    budgets: budgets
  }
}

function parseResult(raw) {
  var doc = parseJson(raw)
  if (!doc || typeof doc !== "object") return null
  if (doc.ok === false) return { ok: false, error: plain(doc.error, 240) || "collector failed" }
  var list = Array.isArray(doc.providers) ? doc.providers : []
  var providers = []
  for (var i = 0; i < list.length; i++) {
    var provider = normalizeProvider(list[i])
    if (provider) providers.push(provider)
  }
  return { ok: true, fetchedAt: dateMs(doc.fetchedAt), providers: providers }
}

function visibleProviders(providers, visibility) {
  var out = []
  var seen = {}
  var order = PROVIDER_ORDER
  for (var o = 0; o < order.length; o++) {
    var id = order[o]
    if (visibility && visibility[id] === false) continue
    for (var i = 0; i < (providers || []).length; i++) {
      var provider = providers[i]
      if (!provider || provider.id !== id || !provider.available || seen[id]) continue
      seen[id] = true
      out.push(provider)
    }
  }
  return out
}

// The user's bar order, persisted in the widget's `providerOrder` setting.
// Unknown or duplicate ids are dropped; agents not named there follow in the
// default order, so a new provider still appears without a settings edit.
function parseOrder(value) {
  var out = []
  var parts = String(value || "").split(",")
  for (var i = 0; i < parts.length; i++) {
    var id = String(parts[i] || "").trim()
    if (id === "" || PROVIDER_ORDER.indexOf(id) < 0 || out.indexOf(id) >= 0) continue
    out.push(id)
  }
  return out
}

function orderedProviders(providers, visibility, orderValue) {
  var visible = visibleProviders(providers, visibility)
  var order = parseOrder(orderValue)
  if (order.length === 0) return visible
  var out = []
  for (var i = 0; i < order.length; i++) {
    var provider = findVisible(visible, order[i])
    if (provider) out.push(provider)
  }
  for (var j = 0; j < visible.length; j++) {
    if (out.indexOf(visible[j]) < 0) out.push(visible[j])
  }
  return out
}

function findVisible(list, id) {
  for (var i = 0; i < (list || []).length; i++) {
    if (list[i] && list[i].id === id) return list[i]
  }
  return null
}

function moveOrder(orderValue, id, delta) {
  var order = parseOrder(orderValue)
  if (order.length === 0 || order.indexOf(id) < 0) return order
  var index = order.indexOf(id)
  var target = index + delta
  if (target < 0 || target >= order.length) return order
  var moved = order[index]
  order[index] = order[target]
  order[target] = moved
  return order
}

// Full saved order after dropping `id` at `insertIndex` in the list of
// visible agents. Agents that are hidden right now keep their place.
function reorderInsert(orderValue, visibleIds, id, insertIndex) {
  var order = parseOrder(orderValue)
  if (order.length === 0) order = PROVIDER_ORDER.slice()
  for (var i = 0; i < PROVIDER_ORDER.length; i++) {
    if (order.indexOf(PROVIDER_ORDER[i]) < 0) order.push(PROVIDER_ORDER[i])
  }
  var from = visibleIds.indexOf(id)
  if (from < 0) return order
  var without = visibleIds.slice()
  without.splice(from, 1)
  var to = clamp(insertIndex, 0, without.length)
  if (to === from) return order
  var at = order.indexOf(id)
  if (at < 0) return order
  order.splice(at, 1)
  if (to >= without.length) {
    order.splice(order.indexOf(without[without.length - 1]) + 1, 0, id)
  } else {
    order.splice(order.indexOf(without[to]), 0, id)
  }
  return order
}

// Filter an already-ordered list by the per-agent show switches, keeping the
// order intact (visibleProviders re-sorts by the default provider order).
function shownProviders(list, visibility) {
  var out = []
  for (var i = 0; i < (list || []).length; i++) {
    var provider = list[i]
    if (!provider) continue
    if (visibility && visibility[provider.id] === false) continue
    out.push(provider)
  }
  return out
}

function providerById(providers, id) {
  for (var i = 0; i < (providers || []).length; i++) {
    if (providers[i] && providers[i].id === id) return providers[i]
  }
  return null
}

// ---------------------------------------------------------- OpenRouter cycle

function emptyHistory() {
  return { current: null, previous: null }
}

function normalizeCycle(value) {
  if (!value || typeof value !== "object") return null
  var end = dateMs(value.end)
  if (end <= 0) return null
  return {
    key: plain(value.key, 60) || String(end),
    end: end,
    spend: Math.max(0, number(value.spend) || 0),
    lastObservedAt: dateMs(value.lastObservedAt)
  }
}

function normalizeHistory(value) {
  var source = value && typeof value === "object" ? value : {}
  var current = normalizeCycle(source.current)
  var previous = normalizeCycle(source.previous)
  if (!current) return emptyHistory()
  if (previous && previous.end > current.end) previous = null
  return { current: current, previous: previous }
}

// Keep exactly one previous completed cycle, and only when it was observed
// near its end; a missed cycle is a misleading baseline.
function advanceHistory(history, money, nowMs) {
  var h = normalizeHistory(history)
  if (!money || !money.resetsAt) return h
  var now = Number(nowMs) || Date.now()
  var next = { key: "cycle:" + money.resetsAt, end: money.resetsAt, spend: money.spend, lastObservedAt: now }
  if (!h.current) return { current: next, previous: null }
  if (h.current.end === next.end) {
    return {
      current: {
        key: next.key,
        end: next.end,
        spend: Math.max(h.current.spend, next.spend),
        lastObservedAt: now
      },
      previous: h.previous
    }
  }
  if (next.end > h.current.end) {
    var observedNearEnd = h.current.lastObservedAt >= h.current.end - 6 * 3600000
    return { current: next, previous: observedNearEnd ? h.current : null }
  }
  return h
}

// The single bar/popup window OpenRouter contributes.
function openrouterWindow(provider, history, warnPercent, criticalPercent) {
  if (!provider || !provider.money) return null
  var money = provider.money
  var h = normalizeHistory(history)
  var previous = h.previous
  var limited = money.limit !== null && money.limit > 0
  var over = !!(previous && money.spend > previous.spend)
  var effectiveLimit = limited ? money.limit : (previous && previous.spend > 0 ? previous.spend : null)
  var usedPercent = effectiveLimit && effectiveLimit > 0 ? clamp(money.spend / effectiveLimit * 100, 0, 100) : 0
  var meterVisible = limited ? money.spend > 0 : !!(previous && previous.spend > 0 && money.spend <= previous.spend)
  var color = "normal"
  if (limited || meterVisible) {
    if (usedPercent >= criticalPercent) color = "critical"
    else if (usedPercent >= warnPercent) color = "warning"
  }
  if (over) color = "yellow"
  return {
    key: "cycle",
    label: "This cycle",
    short: "$",
    detail: limited ? "Key limit" : "Cycle spend",
    percent: usedPercent,
    resetsAt: money.resetsAt,
    stale: false,
    state: color === "yellow" ? "normal" : color,
    color: color,
    mode: (limited || meterVisible) ? "meter" : "dollars",
    meterVisible: meterVisible,
    spend: money.spend,
    limit: money.limit,
    effectiveLimit: effectiveLimit,
    over: over,
    previous: previous,
    credits: money.credits,
    resetInterval: money.resetInterval,
    label: money.label
  }
}

// Every window a provider contributes, in display order. OpenRouter's cycle
// record becomes one synthetic window so the panel can treat it uniformly.
function windowsFor(provider, history, warnPercent, criticalPercent) {
  if (!provider) return []
  if (provider.id === "openrouter") {
    var cycle = openrouterWindow(provider, history, warnPercent, criticalPercent)
    return cycle ? [cycle] : []
  }
  var out = []
  for (var i = 0; i < (provider.limits || []).length; i++) {
    var limit = provider.limits[i]
    var state = stateOf(limit.percent, warnPercent, criticalPercent)
    out.push({
      key: limit.key,
      label: limit.label,
      short: limit.short,
      detail: limit.detail,
      percent: limit.percent,
      resetsAt: limit.resetsAt,
      stale: limit.stale === true,
      state: state,
      color: state,
      mode: "meter",
      meterVisible: true,
      spend: null,
      limit: null,
      effectiveLimit: null,
      over: false,
      previous: null,
      credits: null,
      resetInterval: "",
      labelOverride: ""
    })
  }
  return out
}

function barWindows(provider, history, warnPercent, criticalPercent) {
  var windows = windowsFor(provider, history, warnPercent, criticalPercent)
  var out = []
  for (var i = 0; i < windows.length && out.length < 3; i++) out.push(windows[i])
  return out
}

function providerColor(provider, history, warnPercent, criticalPercent) {
  var top = highest(windowsFor(provider, history, warnPercent, criticalPercent))
  return top ? top.color : "normal"
}

function isAlarming(provider, history, warnPercent, criticalPercent) {
  return providerColor(provider, history, warnPercent, criticalPercent) === "critical"
}

// --------------------------------------------------------------- bar text

function compactText(provider, history, warnPercent, criticalPercent) {
  var windows = windowsFor(provider, history, warnPercent, criticalPercent)
  if (windows.length === 0) return provider && provider.status ? provider.status : ""
  var parts = []
  for (var i = 0; i < windows.length; i++) {
    var window = windows[i]
    if (window.key === "cycle") {
      parts.push(window.mode === "dollars" ? formatCurrency(window.spend) : percentText(window.percent))
    } else if (window.stale) {
      parts.push(window.short + " \u2014")
    } else {
      parts.push(window.short + " " + percentText(window.percent))
    }
  }
  return parts.join(" \u00b7 ")
}

function providerTooltip(provider, history, nowMs, warnPercent, criticalPercent) {
  if (!provider) return ""
  var lines = []
  var head = provider.name
  if (provider.tier !== "") head += " \u00b7 " + provider.tier
  lines.push(head)
  if (provider.status !== "") lines.push(provider.status)
  var windows = windowsFor(provider, history, warnPercent, criticalPercent)
  for (var i = 0; i < windows.length; i++) {
    var window = windows[i]
    var value = window.mode === "dollars"
      ? formatCurrency(window.spend)
      : percentText(window.percent)
    var line = "  " + window.detail + ": " + value
    if (window.mode === "meter" && window.effectiveLimit) {
      line += " of " + formatCurrency(window.effectiveLimit)
    }
    var reset = resetText(window.resetsAt, nowMs)
    if (reset !== "") line += " \u00b7 " + reset
    if (window.stale) line += " \u00b7 stale"
    lines.push(line)
  }
  if (provider.error !== "") lines.push(provider.error)
  return lines.join("\n")
}

function tooltip(providers, history, nowMs, warnPercent, criticalPercent) {
  var visible = providers || []
  if (visible.length === 0) return "No AI agents found"
  var blocks = []
  for (var i = 0; i < visible.length; i++) {
    blocks.push(providerTooltip(visible[i], history, nowMs, warnPercent, criticalPercent))
  }
  return blocks.join("\n\n")
}

function activityText(provider) {
  if (!provider || !provider.activity) return ""
  var activity = provider.activity
  var parts = []
  if (activity.prompts > 0) parts.push(formatCount(activity.prompts) + " prompts")
  if (activity.tokens > 0) parts.push(tokensText(activity.tokens))
  if (activity.accounts > 1) parts.push(activity.accounts + " accounts")
  if (parts.length === 0) return ""
  return (activity.period === "week" ? "This week" : "Today") + " \u00b7 " + parts.join(" \u00b7 ")
}

// --------------------------------------------------------------- cache

function slimProvider(provider) {
  return {
    id: provider.id,
    name: provider.name,
    available: provider.available,
    tier: provider.tier,
    status: provider.status,
    hint: provider.hint,
    error: provider.error,
    source: provider.source,
    limits: provider.limits,
    activity: provider.activity,
    money: provider.money,
    budgets: provider.budgets
  }
}

function serializeCache(providers, history, fetchedAt, attemptedAt, failures, error) {
  return JSON.stringify({
    version: CACHE_VERSION,
    fetchedAt: number(fetchedAt) || 0,
    attemptedAt: number(attemptedAt) || 0,
    failures: Math.max(0, Math.round(number(failures) || 0)),
    error: plain(error, 240),
    data: { providers: (providers || []).map(slimProvider) },
    history: normalizeHistory(history)
  }) + "\n"
}

function parseCache(raw, nowMs) {
  var doc = parseJson(raw)
  if (!doc || doc.version !== CACHE_VERSION) return null
  var now = Number(nowMs) || Date.now()
  var fetchedAt = dateMs(doc.fetchedAt)
  var attemptedAt = dateMs(doc.attemptedAt)
  if (fetchedAt > now + 300000) fetchedAt = 0
  if (attemptedAt > now + 300000) attemptedAt = 0
  var providers = []
  var list = doc.data && Array.isArray(doc.data.providers) ? doc.data.providers : []
  for (var i = 0; i < list.length; i++) {
    var provider = normalizeProvider(list[i])
    if (provider) providers.push(provider)
  }
  return {
    fetchedAt: fetchedAt,
    attemptedAt: attemptedAt,
    failures: Math.max(0, Math.round(number(doc.failures) || 0)),
    error: plain(doc.error, 240),
    providers: providers,
    history: normalizeHistory(doc.history)
  }
}

// ---------------------------------------------------------- poll coordination

function autoDelayMs(fetchedAt, attemptedAt, failures, refreshMs, nowMs) {
  var now = Number(nowMs) || Date.now()
  var interval = Math.max(60000, Number(refreshMs) || 300000)
  var fails = Math.max(0, Math.round(Number(failures) || 0))
  if (fails > 0) {
    var backoff = Math.min(FAILURE_CAP_MS, 60000 * Math.pow(2, Math.min(fails - 1, 4)))
    return Math.max(250, Math.min(backoff, (Number(attemptedAt) || now) + backoff - now))
  }
  var last = Math.max(Number(fetchedAt) || 0, Number(attemptedAt) || 0)
  if (last <= 0) return 250
  return Math.max(250, last + interval - now)
}

var pollState = { leader: null, heartbeat: 0, fetchedAt: 0, attemptedAt: 0, failures: 0, seq: 0, result: null, expires: 0 }

function pollClaim(widget, nowMs) {
  var now = Number(nowMs) || Date.now()
  if (pollState.leader === widget && now - pollState.heartbeat < 20000) {
    pollState.heartbeat = now
    return true
  }
  if (pollState.leader !== widget && now < pollState.expires && pollState.leader !== null) return false
  pollState.leader = widget
  pollState.heartbeat = now
  pollState.expires = now + 20000
  return true
}

function pollRelease(widget) {
  if (pollState.leader === widget) {
    pollState.leader = null
    pollState.heartbeat = 0
    pollState.expires = 0
  }
}

function pollPublish(widget, result) {
  pollState.seq += 1
  pollState.result = result
  pollState.fetchedAt = result && result.fetchedAt ? result.fetchedAt : 0
  pollState.attemptedAt = Date.now()
}

function pollConsume(widget) {
  if (pollState.leader === widget || pollState.result === null) return null
  var result = pollState.result
  pollState.result = null
  return result
}

function pollLeaderInstance() {
  return pollState.leader
}

function pollSeed(fetchedAt, attemptedAt, failures) {
  pollState.fetchedAt = Math.max(pollState.fetchedAt, Number(fetchedAt) || 0)
  pollState.attemptedAt = Math.max(pollState.attemptedAt, Number(attemptedAt) || 0)
  pollState.failures = Math.max(pollState.failures, Math.round(Number(failures) || 0))
}
