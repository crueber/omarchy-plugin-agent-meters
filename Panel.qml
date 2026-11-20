import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Commons as Commons
import qs.Ui
import "Model.js" as Model

// One bar widget for the AI agents this machine actually uses. scripts/collect.js
// reads each provider's own source and keeps only the agents with a plan, a key
// or usage; the bar then draws their marks and limit meters side by side, and
// the panel explains every window.
Panel {
  id: root
  moduleName: "crueber.agent-meters"
  ipcTarget: "agent-meters"
  manageIpc: false

  // ------------------------------------------------------------------ theme

  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color urgent: bar ? bar.urgent : Color.urgent
  readonly property color dim: Qt.darker(foreground, 1.55)
  readonly property color track: Style.selectedFillFor(foreground, Color.accent)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family
  readonly property bool vertical: bar ? bar.vertical : false

  // --------------------------------------------------------------- settings

  readonly property string barStyle: {
    var value = String(setting("barStyle", "bars"))
    return value === "text" || value === "icon" ? value : "bars"
  }
  readonly property int refreshIntervalSec: Model.clampInt(setting("refreshIntervalSec", 300), 60, 3600, 300)
  readonly property int warnPercent: Model.clampInt(setting("warnPercent", 70), 0, 100, 70)
  readonly property int criticalPercent: Model.clampInt(setting("criticalPercent", 90), 0, 100, 90)
  readonly property string warningColor: String(setting("warningColor", "#f67400"))
  readonly property string criticalColor: String(setting("criticalColor", ""))
  readonly property string compareColor: "#d9b45b"
  readonly property string nodeCommand: String(setting("nodeCommand", ""))
  readonly property string authFile: String(setting("authFile", ""))
  readonly property string grokHome: String(setting("grokHome", ""))
  readonly property string botHome: String(setting("botHome", ""))
  readonly property string opencodeCommand: String(setting("opencodeCommand", ""))
  readonly property string codexCommand: String(setting("codexCommand", ""))
  readonly property string claudeCommand: String(setting("claudeCommand", ""))
  readonly property bool showActivity: setting("showActivity", true) !== false
  readonly property string rightClickCommand: String(setting("onRightClick", ""))
  // OpenRouter account-wide (management key) display: key rows in the panel
  // and the months the usage meter averages (0 = no meter, no analytics).
  readonly property int openrouterKeyRows: Model.clampInt(setting("openrouterKeyRows", 3), 0, 12, 3)
  readonly property int openrouterAverageMonths: Model.clampInt(setting("openrouterAverageMonths", 2), 0, 12, 2)
  readonly property var orOptions: ({ keyRows: openrouterKeyRows, averageMonths: openrouterAverageMonths })
  property var visibility: ({
    claude: setting("showClaude", true) !== false,
    grok: setting("showGrok", true) !== false,
    opencode: setting("showOpencode", true) !== false,
    openrouter: setting("showOpenrouter", true) !== false,
    codex: setting("showCodex", true) !== false
  })
  // Written by the panel's reorder controls; comma-separated agent ids. Kept
  // writable so a move repaints immediately, before shell.json reloads.
  property string providerOrder: String(setting("providerOrder", ""))

  // OpenRouter management key entry. The key itself only lives in keyDraft
  // (and the password field) between typing and the helper's stdin; it is
  // never a setting, so it cannot reach shell.json or the cache. Everything
  // key-related lives on the panel's own settings view, not in the agent list.
  property bool settingsOpen: false
  property bool keyEditing: false
  property string keyDraft: ""
  property string keyMessage: ""
  property bool keyRevealed: false
  property string keyPhase: ""   // "", "storing", "removing", "reading"
  readonly property bool keyBusy: keyPhase !== ""
  onSettingsOpenChanged: if (!settingsOpen) cancelKeyEdit()
  // The field takes keyboard focus while the editor is open; give it back to
  // the panel when the editor closes, or Esc and the close key stop working.
  onKeyEditingChanged: if (!keyEditing && opened) Qt.callLater(function() { keyCatcher.forceActiveFocus() })

  readonly property string executable: nodeCommand !== "" ? nodeCommand : "node"
  readonly property string helperPath: {
    var value = String(Qt.resolvedUrl("scripts/collect.js"))
    if (value.indexOf("file://") === 0) value = value.slice(7)
    try { value = decodeURIComponent(value) } catch (e) {}
    return value
  }
  readonly property string keyHelperPath: {
    var value = String(Qt.resolvedUrl("scripts/set-management-key.sh"))
    if (value.indexOf("file://") === 0) value = value.slice(7)
    try { value = decodeURIComponent(value) } catch (e) {}
    return value
  }

  // ------------------------------------------------------------------- data

  property var providers: []
  property var history: Model.emptyHistory()
  property string errorText: ""
  property string lastErrorMessage: ""
  property string stderrText: ""
  property bool gotOutput: false
  property double lastFetchMs: 0
  property double lastAttemptMs: 0
  property int fetchFailures: 0
  property double nowMs: Date.now()

  property bool cacheLoadAttempted: false
  property bool pollLeader: false
  property int consumedSeq: 0

  // The agents the bar may draw: available ones in providerOrder order.
  readonly property var availableProviders: Model.orderedProviders(providers, {}, providerOrder)
  // The panel also lists OpenRouter when it has no key, so the management key
  // can be set there. The bar never receives that entry.
  readonly property var panelProviders: Model.panelProviders(availableProviders, providers)
  readonly property var visibleProviders: Model.shownProviders(availableProviders, visibility)
  readonly property int hiddenCount: Math.max(0, availableProviders.length - visibleProviders.length)
  readonly property var openrouterProvider: Model.providerById(panelProviders, "openrouter")
  readonly property bool keyStored: openrouterProvider !== null
    && (openrouterProvider.keySource === "secret-service" || openrouterProvider.keySource === "file")
  readonly property bool keyFromEnv: openrouterProvider !== null && openrouterProvider.keySource === "env"
  readonly property string keyStatusText: {
    if (keyPhase === "storing") return "Storing the management key…"
    if (keyPhase === "removing") return "Removing the management key…"
    if (keyPhase === "reading") return "Reading the account…"
    var text = Model.managementKeyText(openrouterProvider)
    return text !== "" ? text : "Management key: not set"
  }

  // Drag-to-reorder state. The ghost and insertion line live in the panel's
  // Flickable content, in the same coordinates as the sections.
  property string dragProviderId: ""
  property real dragPointerY: 0
  property int dropIndex: -1
  readonly property bool dragging: dragProviderId !== ""
  readonly property bool busy: fetchProc.running
  readonly property bool hasData: visibleProviders.length > 0

  readonly property string cacheHome: {
    var xdg = Quickshell.env("XDG_CACHE_HOME")
    if (xdg) return xdg
    var home = Quickshell.env("HOME")
    return home ? home + "/.cache" : "/tmp"
  }
  readonly property string cacheDir: root.cacheHome + "/agent-meters"
  readonly property string cachePath: root.cacheDir + "/usage.json"

  readonly property string heroDetail: {
    var top = null
    for (var i = 0; i < visibleProviders.length; i++) {
      var list = Model.windowsFor(visibleProviders[i], history, warnPercent, criticalPercent, orOptions)
      for (var j = 0; j < list.length; j++) {
        if (list[j].mode !== "meter") continue
        if (top === null || list[j].percent > top) top = list[j].percent
      }
    }
    return top === null ? "" : Model.percentText(top)
  }
  readonly property string heroMeta: {
    var parts = []
    if (availableProviders.length > 0) parts.push(availableProviders.length + (availableProviders.length === 1 ? " agent" : " agents"))
    if (hiddenCount > 0) parts.push(hiddenCount + " hidden")
    var updated = Model.updatedText(root.lastFetchMs, root.nowMs)
    if (updated !== "") parts.push(updated.replace(/^Updated /, ""))
    if (lastErrorMessage !== "") parts.push("read failed")
    return parts.join(" · ")
  }
  readonly property string footerText: {
    var parts = []
    var updated = Model.updatedText(root.lastFetchMs, root.nowMs)
    if (updated !== "") parts.push(updated)
    if (lastErrorMessage !== "") parts.push(lastErrorMessage)
    parts.push("local agent records")
    return parts.join(" · ")
  }
  readonly property string tooltipText: visibleProviders.length > 0
    ? Model.tooltip(visibleProviders, history, nowMs, warnPercent, criticalPercent, orOptions)
    : (availableProviders.length > 0
      ? "All agents are hidden from the bar\nOpen Agent Meters to show one"
      : "No AI agents found")

  function stateColor(name) {
    if (name === "critical") return criticalColor !== "" ? criticalColor : urgent
    if (name === "warning") return warningColor !== "" ? warningColor : foreground
    if (name === "yellow") return compareColor
    return foreground
  }

  function isShown(id) {
    return !visibility || visibility[id] !== false
  }

  function showKey(id) {
    return "show" + id.charAt(0).toUpperCase() + id.slice(1)
  }

  // Flip one agent in the bar and persist the same setting the widget's
  // schema exposes, so the switch and the settings page stay in step.
  function setShown(id, shown) {
    if (id === "") return
    var next = {}
    for (var key in visibility) next[key] = visibility[key]
    next[id] = shown
    root.visibility = next
    orderProc.command = ["/bin/sh", "-lc",
      "omarchy bar set " + Model.shellQuote(root.moduleName) + " " + Model.shellQuote(showKey(id))
      + (shown ? " true" : " false") + " --json"]
    orderProc.running = true
  }

  function saveSetting(name, value) {
    var next = {}
    for (var key in settings) if (key !== "id") next[key] = settings[key]
    next[name] = value
    root.settings = next
    orderProc.command = ["/bin/sh", "-lc",
      "omarchy bar set " + Model.shellQuote(root.moduleName) + " " + Model.shellQuote(name)
      + " " + Model.shellQuote(String(value)) + " --json"]
    orderProc.running = true
  }

  function saveProviderOrder(order) {
    root.providerOrder = order.join(",")
    orderProc.command = ["/bin/sh", "-lc",
      "omarchy bar set " + Model.shellQuote(root.moduleName) + " providerOrder " + Model.shellQuote(root.providerOrder)]
    orderProc.running = true
  }

  // The saved order padded with every known agent, so agents that are hidden
  // right now keep their place when they come back.
  function fullOrder() {
    var order = Model.parseOrder(providerOrder)
    if (order.length === 0) order = Model.PROVIDER_ORDER.slice()
    for (var i = 0; i < Model.PROVIDER_ORDER.length; i++) {
      if (order.indexOf(Model.PROVIDER_ORDER[i]) < 0) order.push(Model.PROVIDER_ORDER[i])
    }
    return order
  }

  function moveProvider(id, delta) {
    var ids = []
    for (var i = 0; i < panelProviders.length; i++) ids.push(panelProviders[i].id)
    var from = ids.indexOf(id)
    if (from < 0) return
    var targetId = ids[from + delta]
    if (targetId === undefined) return
    var order = fullOrder()
    var a = order.indexOf(id)
    var b = order.indexOf(targetId)
    if (a < 0 || b < 0) return
    order[a] = targetId
    order[b] = id
    saveProviderOrder(order)
  }

  // Insert `id` at `insertIndex` in the list without the dragged agent.
  function reorderProvider(id, insertIndex) {
    var ids = []
    for (var i = 0; i < panelProviders.length; i++) ids.push(panelProviders[i].id)
    saveProviderOrder(Model.reorderInsert(providerOrder, ids, id, insertIndex))
  }

  function dropIndexAt(y) {
    var count = sectionsRepeater ? sectionsRepeater.count : 0
    for (var i = 0; i < count; i++) {
      var item = sectionsRepeater.itemAt(i)
      if (item && y < item.y + item.height / 2) return i
    }
    return count
  }

  function dropLineY() {
    var count = sectionsRepeater ? sectionsRepeater.count : 0
    if (count === 0) return 0
    if (dropIndex >= count) {
      var last = sectionsRepeater.itemAt(count - 1)
      return last ? last.y + last.height + Style.space(3) : 0
    }
    var item = sectionsRepeater.itemAt(Math.max(0, dropIndex))
    return item ? item.y - Style.space(3) : 0
  }

  function providerName(id) {
    for (var i = 0; i < panelProviders.length; i++) {
      if (panelProviders[i].id === id) return panelProviders[i].name
    }
    return id
  }

  function startSectionDrag(id, source, mouse) {
    if (id === "") return
    var point = source.mapToItem(panelColumn, mouse.x, mouse.y)
    root.dragProviderId = id
    root.dragPointerY = point.y
    root.dropIndex = 0
    for (var i = 0; i < panelProviders.length; i++) {
      if (panelProviders[i].id === id) { root.dropIndex = i; break }
    }
  }

  function updateSectionDrag(source, mouse) {
    if (!root.dragging) return
    var point = source.mapToItem(panelColumn, mouse.x, mouse.y)
    root.dragPointerY = point.y
    root.dropIndex = dropIndexAt(point.y)
  }

  function endSectionDrag() {
    if (!root.dragging) return
    var id = root.dragProviderId
    var from = -1
    for (var i = 0; i < panelProviders.length; i++) {
      if (panelProviders[i].id === id) from = i
    }
    if (from >= 0) {
      var to = root.dropIndex
      if (to > from) to -= 1
      reorderProvider(id, to)
    }
    cancelSectionDrag()
  }

  function cancelSectionDrag() {
    root.dragProviderId = ""
    root.dragPointerY = 0
    root.dropIndex = -1
  }

  // ------------------------------------------------------------ cache & fetch

  function findProvider(list, id) {
    for (var i = 0; i < (list || []).length; i++) {
      if (list[i] && list[i].id === id) return list[i]
    }
    return null
  }

  // A failed provider read keeps its last good numbers and gains the error, so
  // one endpoint being down does not blank the whole widget.
  function mergeProviders(oldList, newList) {
    var out = []
    for (var i = 0; i < newList.length; i++) {
      var next = newList[i]
      var old = findProvider(oldList, next.id)
      if (next.error !== "" && old && old.available) {
        var merged = {
          id: old.id,
          name: old.name,
          available: old.available,
          tier: next.tier !== "" ? next.tier : old.tier,
          status: next.status !== "" ? next.status : old.status,
          hint: next.hint,
          error: next.error,
          source: old.source,
          keySource: next.keySource,
          limits: old.limits,
          activity: old.activity,
          money: old.money,
          budgets: old.budgets
        }
        out.push(merged)
      } else {
        out.push(next)
      }
    }
    return out
  }

  function loadCache(raw) {
    var cached = Model.parseCache(raw, Date.now())
    if (!cached) return
    root.lastFetchMs = Math.max(root.lastFetchMs, cached.fetchedAt)
    root.lastAttemptMs = Math.max(root.lastAttemptMs, cached.attemptedAt)
    root.fetchFailures = Math.max(root.fetchFailures, cached.failures)
    Model.pollSeed(cached.fetchedAt, cached.attemptedAt, cached.failures)
    if (cached.providers.length > 0) {
      root.providers = cached.providers
      root.history = cached.history
      root.lastErrorMessage = cached.error
      root.errorText = cached.error
      root.nowMs = Date.now()
    } else if (cached.error !== "") {
      root.lastErrorMessage = cached.error
      root.errorText = cached.error
    }
  }

  function writeCache() {
    if (!root.cacheLoadAttempted) return
    cacheFile.setText(Model.serializeCache(
      root.providers,
      root.history,
      root.lastFetchMs,
      root.lastAttemptMs,
      root.fetchFailures,
      root.lastErrorMessage
    ))
  }

  function nextAutoDelayMs() {
    var fetchedAt = Math.max(root.lastFetchMs, Model.pollState.fetchedAt)
    var attemptedAt = Math.max(root.lastAttemptMs, Model.pollState.attemptedAt)
    var failures = Math.max(root.fetchFailures, Model.pollState.failures)
    return Model.autoDelayMs(fetchedAt, attemptedAt, failures, root.refreshIntervalSec * 1000, Date.now())
  }

  function scheduleNextPoll(delayMs) {
    if (!root.pollLeader) return
    poll.interval = Math.max(250, Math.round(Number(delayMs) || 0))
    poll.restart()
  }

  function fetchCommand() {
    var command = Model.shellQuote(root.executable) + " " + Model.shellQuote(root.helperPath)
    if (root.authFile !== "") command += " --auth-file " + Model.shellQuote(root.authFile)
    if (root.grokHome !== "") command += " --grok-home " + Model.shellQuote(root.grokHome)
    if (root.botHome !== "") command += " --bot-home " + Model.shellQuote(root.botHome)
    if (root.opencodeCommand !== "") command += " --opencode " + Model.shellQuote(root.opencodeCommand)
    if (root.codexCommand !== "") command += " --codex " + Model.shellQuote(root.codexCommand)
    if (root.claudeCommand !== "") command += " --claude " + Model.shellQuote(root.claudeCommand)
    // Only non-secret display state goes on the command line: the averaging
    // window, and the analytics baseline this cache already holds, so the
    // collector asks OpenRouter's analytics at most once per (month, N).
    command += " --openrouter-average-months " + Model.shellQuote(String(root.openrouterAverageMonths))
    var baseline = Model.baselineArg(findProvider(root.providers, "openrouter"))
    if (baseline !== "") command += " --openrouter-baseline " + Model.shellQuote(baseline)
    return command
  }

  function requestFetch(kind) {
    if (!root.pollLeader || fetchProc.running) return
    var last = Math.max(root.lastAttemptMs, Model.pollState.attemptedAt)
    var floor = kind === "manual" ? Model.FORCE_MIN_MS : Model.AUTO_MIN_MS
    if (last > 0 && Date.now() - last < floor) return
    spawnFetch()
  }

  function refreshNow() {
    if (root.lastAttemptMs > 0 && Date.now() - root.lastAttemptMs < Model.FORCE_MIN_MS) return
    requestFetch("manual")
  }

  // ------------------------------------------------------ management key

  // The helper's key shape (scripts/set-management-key.sh): 16–512 characters
  // from the URL-safe set. Pre-checked here only to avoid a pointless process;
  // the helper is the authority.
  function keyLooksValid(value) {
    var key = String(value || "")
    return key.length >= 16 && key.length <= 512 && /^[A-Za-z0-9._~+\/=:-]+$/.test(key)
  }

  function beginKeyEdit() {
    if (root.keyBusy || root.keyFromEnv) return
    root.settingsOpen = true
    root.keyDraft = ""
    root.keyMessage = ""
    root.keyRevealed = false
    root.keyEditing = true
  }

  function cancelKeyEdit() {
    root.keyEditing = false
    root.keyDraft = ""
    root.keyMessage = ""
    root.keyRevealed = false
  }

  // The key goes to the helper on stdin, never on its command line. The draft
  // is cleared as soon as it is handed over, so the panel does not keep it.
  function submitKey() {
    if (root.keyBusy) return
    var key = String(root.keyDraft || "").trim()
    if (!keyLooksValid(key)) {
      root.keyMessage = "That does not look like an OpenRouter key; nothing was stored."
      return
    }
    root.keyEditing = false
    root.keyRevealed = false
    root.keyMessage = ""
    root.keyDraft = ""
    keyProc.pending = key
    root.keyPhase = "storing"
    keyProc.running = true
  }

  function removeKey() {
    if (root.keyBusy || !root.keyStored) return
    root.keyEditing = false
    root.keyDraft = ""
    root.keyMessage = ""
    root.keyRevealed = false
    root.keyPhase = "removing"
    removeKeyProc.running = true
  }

  // A changed credential is read now instead of on the poll floor, so the
  // panel's status and numbers catch up while the user is looking at them.
  function refreshAfterKeyChange() {
    root.nowMs = Date.now()
    if (!root.pollLeader) {
      keyRetryTimer.stop()
      return
    }
    if (fetchProc.running) {
      // A fetch that started before the key changed must not be allowed to
      // decide the result; try again as soon as it exits.
      keyRetryTimer.restart()
      return
    }
    keyRetryTimer.stop()
    spawnFetch()
  }

  function finishKeyAction() {
    keyReadTimer.stop()
    if (root.keyPhase === "reading") root.keyPhase = ""
  }

  function spawnFetch() {
    root.lastAttemptMs = Date.now()
    root.gotOutput = false
    root.stderrText = ""
    writeCache()
    fetchProc.command = ["/bin/sh", "-lc", root.fetchCommand()]
    fetchProc.running = true
  }

  function applyOutput(raw) {
    root.gotOutput = true
    var result = Model.parseResult(raw)
    if (!result) {
      handleFailure("Unreadable collector output")
      return
    }
    if (!result.ok) {
      handleFailure(result.error)
      return
    }
    var fetchedAt = result.fetchedAt > 0 ? result.fetchedAt : Date.now()
    root.providers = root.mergeProviders(root.providers, result.providers)
    root.history = Model.advanceHistory(root.history, Model.historyMoney(result.providers), Date.now())
    root.lastFetchMs = fetchedAt
    root.fetchFailures = 0
    root.lastErrorMessage = ""
    root.errorText = ""
    root.nowMs = Date.now()
    Model.pollPublish(root, { fetchedAt: fetchedAt, providers: root.providers, history: root.history })
    writeCache()
    scheduleNextPoll(nextAutoDelayMs())
    root.finishKeyAction()
  }

  function handleFailure(message) {
    root.fetchFailures = Math.min(20, root.fetchFailures + 1)
    root.lastErrorMessage = String(message || "Collector failed").slice(0, 240)
    root.errorText = root.lastErrorMessage
    Model.pollPublish(root, { fetchedAt: root.lastFetchMs, providers: root.providers, history: root.history })
    writeCache()
    scheduleNextPoll(nextAutoDelayMs())
    root.finishKeyAction()
  }

  // A new averaging window needs a new analytics baseline. Ask through the
  // normal path, so leadership and the fetch floors still apply; the panel
  // already redraws from the observed history meanwhile.
  onOpenrouterAverageMonthsChanged: {
    if (root.pollLeader && root.cacheLoadAttempted) root.requestFetch("auto")
  }

  // --------------------------------------------------------------- lifecycle

  Component.onCompleted: {
    Model.pollClaim(root, Date.now())
    root.pollLeader = Model.pollLeaderInstance() === root
    // A missing cache leaves the first fetch to the FileView, which may run
    // before leadership is settled. Ask once afterwards so a fresh install
    // paints in seconds instead of waiting for the next five-minute poll.
    if (root.pollLeader) {
      Qt.callLater(function() {
        if (root.providers.length === 0 && !fetchProc.running) root.requestFetch("auto")
      })
    }
  }

  FileView {
    id: cacheFile
    path: root.cachePath
    blockLoading: true
    watchChanges: false
    atomicWrites: true
    printErrors: false
    onLoaded: {
      root.cacheLoadAttempted = true
      root.loadCache(text())
      if (root.pollLeader) {
        if (root.providers.length === 0) {
          root.requestFetch("auto")
        } else {
          root.scheduleNextPoll(root.nextAutoDelayMs())
        }
      }
    }
    onLoadFailed: {
      root.cacheLoadAttempted = true
      if (root.pollLeader) root.requestFetch("auto")
    }
  }

  Process {
    id: orderProc
    onExited: function(exitCode) {
      if (exitCode !== 0) root.errorText = "Could not save the agent order"
    }
  }

  Process {
    id: cacheDirProc
    command: ["install", "-d", "-m", "700", root.cacheDir]
    running: true
  }

  Process {
    id: fetchProc
    onExited: function(exitCode) {
      if (!root.gotOutput) {
        var line = root.stderrText.trim().split("\n").filter(function(value) { return value !== "" }).pop()
        if (line) root.handleFailure(line)
        else root.handleFailure(exitCode === 127
          ? "node not found; set the Node executable in the widget settings"
          : "Collector failed (exit " + exitCode + ")")
      }
    }
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.applyOutput(text)
    }
    stderr: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.stderrText = text
    }
  }

  // scripts/set-management-key.sh. The key is written to its stdin and never
  // appears on the command line or in the environment; output is drained into
  // collectors so the shell does not echo it.
  Process {
    id: keyProc
    property string pending: ""
    command: [root.keyHelperPath]
    stdinEnabled: true
    stdout: StdioCollector {}
    stderr: StdioCollector {}
    onStarted: {
      write(keyProc.pending + "\n")
      keyProc.pending = ""
    }
    onExited: function(exitCode) {
      keyProc.pending = ""
      if (exitCode === 0) {
        root.keyPhase = "reading"
        root.keyMessage = ""
        keyReadTimer.restart()
        root.refreshAfterKeyChange()
      } else {
        root.keyPhase = ""
        root.keyMessage = exitCode === 127
          ? "The key helper is missing; reinstall the plugin."
          : "The key was not stored. Check it at openrouter.ai/settings/management-keys and try again."
      }
    }
  }

  Process {
    id: removeKeyProc
    command: [root.keyHelperPath, "--remove"]
    stdout: StdioCollector {}
    stderr: StdioCollector {}
    onExited: function(exitCode) {
      if (exitCode === 0) {
        root.keyPhase = "reading"
        keyReadTimer.restart()
        root.refreshAfterKeyChange()
      } else {
        root.keyPhase = ""
        root.keyMessage = "The stored key could not be removed."
      }
    }
  }

  // A fetch that never reports back (not the poll leader, or a collector that
  // hangs) must not leave the key row saying "Reading the account…".
  Timer {
    id: keyReadTimer
    interval: 15000
    onTriggered: root.finishKeyAction()
  }

  // Retries the post-key-change read while a fetch that started before the
  // change is still running.
  Timer {
    id: keyRetryTimer
    interval: 2000
    onTriggered: root.refreshAfterKeyChange()
  }

  Timer {
    id: poll
    repeat: true
    running: root.pollLeader
    interval: 300000
    onTriggered: {
      root.pollLeader = Model.pollClaim(root, Date.now())
      if (!root.pollLeader) return
      var result = Model.pollConsume(root)
      if (result) {
        root.nowMs = Date.now()
        return
      }
      root.requestFetch("auto")
    }
  }

  Timer {
    interval: 5000
    running: true
    repeat: true
    onTriggered: {
      var wasLeader = root.pollLeader
      root.pollLeader = Model.pollClaim(root, Date.now())
      if (!wasLeader && root.pollLeader && root.providers.length === 0 && !fetchProc.running) {
        root.requestFetch("auto")
      }
    }
  }

  Timer {
    interval: 30000
    running: root.opened
    repeat: true
    onTriggered: root.nowMs = Date.now()
  }

  onOpenedChanged: if (!opened) {
    root.cancelSectionDrag()
    root.settingsOpen = false
    root.cancelKeyEdit()
  } else {
    nowMs = Date.now()
    if (root.pollLeader && root.lastFetchMs > 0 && Date.now() - root.lastFetchMs > root.refreshIntervalSec * 1000) {
      root.requestFetch("auto")
    }
    Qt.callLater(function() { keyCatcher.forceActiveFocus() })
  }

  function openDocs() {
    Qt.openUrlExternally("https://github.com/crueber/omarchy-plugin-agent-meters")
  }

  function handleClick(buttonCode) {
    if (buttonCode === Qt.MiddleButton) root.refreshNow()
    else if (buttonCode === Qt.RightButton) {
      if (rightClickCommand !== "" && root.bar) root.bar.run(rightClickCommand)
      else root.openDocs()
    } else {
      root.toggle()
    }
  }

  ShellIpc {
    target: root.ipcTarget

    function open(): void { root.open() }
    function close(): void { root.close() }
    function show(): void { root.open() }
    function hide(): void { root.close() }
    function toggle(): void { root.toggle() }
    function refresh(): string { root.refreshNow(); return "ok" }
    // Opens the settings view and the OpenRouter management key editor. The
    // key itself never crosses IPC: this only opens the masked field.
    function setupKey(): string { root.open(); root.settingsOpen = true; root.beginKeyEdit(); return "ok" }
    function text(): string {
      var parts = []
      for (var i = 0; i < root.visibleProviders.length; i++) {
        var provider = root.visibleProviders[i]
        parts.push(provider.name + ": " + Model.compactText(provider, root.history, root.warnPercent, root.criticalPercent, root.orOptions))
      }
      return parts.length > 0 ? parts.join(" | ") : "no agents"
    }
    function providers(): string { return JSON.stringify(root.visibleProviders) }
    function move(id: string, delta: int): string { root.moveProvider(id, delta); return root.providerOrder }
  }

  // -------------------------------------------------------------------- bar

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  component BarMeter: Item {
    id: meter
    property var window: null
    width: Style.space(17)
    height: Style.space(3)

    Rectangle {
      anchors.fill: parent
      radius: height / 2
      color: root.track
    }

    Rectangle {
      width: Math.max(height, parent.width * Math.min(100, Math.max(0, Number(meter.window ? meter.window.percent : 0))) / 100)
      height: parent.height
      radius: height / 2
      color: root.stateColor(meter.window ? meter.window.color : "normal")

      Behavior on width {
        NumberAnimation { duration: Style.duration(160); easing.type: Easing.OutCubic }
      }
    }
  }

  component ProviderChip: Row {
    id: chip
    property var provider: null
    spacing: Style.space(4)

    ProviderMark {
      anchors.verticalCenter: parent.verticalCenter
      providerId: chip.provider ? chip.provider.id : ""
      markSize: Style.bar.iconFont + 3
      color: root.foreground
    }

    Column {
      anchors.verticalCenter: parent.verticalCenter
      spacing: Style.space(2)
      visible: root.barStyle === "bars"

      Repeater {
        model: root.barStyle === "bars" && chip.provider
          ? Model.barWindows(chip.provider, root.history, root.warnPercent, root.criticalPercent, root.orOptions)
          : []

        delegate: Item {
          width: Style.space(17)
          height: Style.space(3)
          visible: modelData.mode === "meter"
            ? (chip.provider.id !== "openrouter" || modelData.meterVisible !== false)
            : false

          Rectangle {
            anchors.fill: parent
            radius: height / 2
            color: root.track
          }

          Rectangle {
            width: Math.max(height, parent.width * Math.min(100, Math.max(0, modelData.fillPercent)) / 100)
            height: parent.height
            radius: height / 2
            color: root.stateColor(modelData.color)

            Behavior on width {
              NumberAnimation { duration: Style.duration(160); easing.type: Easing.OutCubic }
            }
          }
        }
      }
    }

    Text {
      textFormat: Text.PlainText
      anchors.verticalCenter: parent.verticalCenter
      visible: root.barStyle === "bars" && chip.provider && chip.provider.id === "openrouter"
      text: chip.provider
        ? Model.barDollarsText(chip.provider, root.history, root.warnPercent, root.criticalPercent, root.orOptions)
        : ""
      color: chip.provider
        ? root.stateColor(Model.barDollarsColor(chip.provider, root.history, root.warnPercent, root.criticalPercent, root.orOptions))
        : root.foreground
      font.family: root.fontFamily
      font.pixelSize: Style.font.bodySmall
      renderType: Text.NativeRendering
    }

    Text {
      textFormat: Text.PlainText
      anchors.verticalCenter: parent.verticalCenter
      visible: root.barStyle === "text"
      text: chip.provider ? Model.barText(chip.provider, root.history, root.warnPercent, root.criticalPercent, root.orOptions) : ""
      color: {
        var color = chip.provider ? Model.providerColor(chip.provider, root.history, root.warnPercent, root.criticalPercent, root.orOptions) : "normal"
        return root.stateColor(color)
      }
      font.family: root.fontFamily
      font.pixelSize: Style.font.bodySmall
      renderType: Text.NativeRendering
    }
  }

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    labelVisible: false
    hasVisualContent: true
    dimmed: !root.hasData
    active: {
      for (var i = 0; i < root.visibleProviders.length; i++) {
        if (Model.isAlarming(root.visibleProviders[i], root.history, root.warnPercent, root.criticalPercent, root.orOptions)) return true
      }
      return false
    }
    tooltipText: root.tooltipText
    fixedWidth: root.vertical ? -1 : Math.ceil(content.implicitWidth + button.scaledHorizontalMargin * 2)
    fixedHeight: root.vertical ? Math.ceil(content.implicitHeight + button.scaledVerticalPadding * 2) : -1

    onPressed: function(buttonCode) { root.handleClick(buttonCode) }

    Row {
      id: content
      anchors.centerIn: parent
      spacing: Style.space(7)

      Repeater {
        model: root.visibleProviders
        delegate: ProviderChip { provider: modelData }
      }

      Text {
        textFormat: Text.PlainText
        visible: root.visibleProviders.length === 0
        anchors.verticalCenter: parent.verticalCenter
        text: "󰚩"
        color: root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.bar.iconFont
        renderType: Text.NativeRendering
      }
    }
  }

  // ------------------------------------------------------------------ popup

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(380))
    contentHeight: panel.fittedContentHeight(panelColumn.implicitHeight, Style.space(1200))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      blocked: root.keyEditing || root.keyBusy
      onCloseRequested: {
        if (root.keyEditing) root.cancelKeyEdit()
        else if (root.settingsOpen) root.settingsOpen = false
        else root.close()
      }
      onTextKey: function(text) {
        if (text === "r") root.refreshNow()
      }

      Flickable {
        id: panelFlick
        anchors.fill: parent
        contentWidth: width
        contentHeight: panelColumn.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        flickableDirection: Flickable.VerticalFlick
        interactive: contentHeight > height

        Column {
          id: panelColumn
          width: panelFlick.width
          spacing: Style.space(12)

          PanelHero {
            width: parent.width
            title: "Agent Meters"
            meta: root.settingsOpen ? "Settings" : root.heroMeta
            detail: root.settingsOpen ? "" : root.heroDetail
            foreground: root.foreground
            fontFamily: root.fontFamily

            iconComponent: Component {
              Text {
                text: "󰚩"
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.display
                renderType: Text.NativeRendering
              }
            }

            trailingControl: Component {
              Row {
                spacing: Style.space(2)

                PanelActionButton {
                  visible: !root.settingsOpen
                  iconText: "󰑐"
                  tooltipText: root.busy ? "Refreshing…" : "Refresh (r)"
                  foreground: root.foreground
                  fontFamily: root.fontFamily
                  enabled: !root.busy
                  onClicked: root.refreshNow()
                }

                PanelActionButton {
                  iconText: root.settingsOpen ? "󰁍" : "󰒓"
                  tooltipText: root.settingsOpen ? "Back to agents" : "Settings"
                  foreground: root.foreground
                  fontFamily: root.fontFamily
                  onClicked: root.settingsOpen = !root.settingsOpen
                }
              }
            }
          }

          PanelSeparator { foreground: root.foreground }

          Column {
            visible: root.panelProviders.length === 0 && !root.settingsOpen
            width: parent.width
            spacing: Style.space(4)

            Text {
              textFormat: Text.PlainText
              width: parent.width
              text: root.errorText !== "" ? "No agent found" : "Looking for agents"
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.subtitle
              font.bold: true
            }

            Text {
              textFormat: Text.PlainText
              width: parent.width
              text: root.errorText !== ""
                ? root.errorText
                : "Sign in to Claude Code, Grok or OpenCode, or add an OpenRouter key, and that agent appears here."
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              wrapMode: Text.WordWrap
            }
          }

          Column {
            width: parent.width
            spacing: Style.space(12)
            visible: !root.settingsOpen

            Repeater {
              id: sectionsRepeater
              model: root.panelProviders
              delegate: ProviderSection { provider: modelData }
            }

            Text {
              textFormat: Text.PlainText
              width: parent.width
              text: root.footerText
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              elide: Text.ElideRight
            }
          }

          // Settings live on their own view: the agent list keeps its space,
          // and the key entry appears only when the gear opens this.
          Column {
            id: settingsColumn
            width: parent.width
            spacing: Style.space(8)
            visible: root.settingsOpen

            PanelSectionHeader {
              foreground: root.foreground
              fontFamily: root.fontFamily
              text: "Agents in the bar"
            }

            Column {
              width: parent.width
              spacing: Style.space(6)

              Repeater {
                model: root.panelProviders

                delegate: Row {
                  width: parent.width
                  spacing: Style.space(8)

                  ProviderMark {
                    id: toggleMark
                    anchors.verticalCenter: parent.verticalCenter
                    providerId: modelData.id
                    markSize: Style.font.title
                    color: root.foreground
                  }

                  Text {
                    textFormat: Text.PlainText
                    width: Math.max(0, parent.width - toggleMark.width - showToggle.width - parent.spacing * 2)
                    anchors.verticalCenter: parent.verticalCenter
                    text: modelData.name + (modelData.available === false ? "  ·  not set up" : "")
                    color: root.foreground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.body
                    elide: Text.ElideRight
                  }

                  ToggleSwitch {
                    id: showToggle
                    anchors.verticalCenter: parent.verticalCenter
                    checked: root.isShown(modelData.id)
                    trackHeight: Style.space(16)
                    foreground: root.foreground
                    accent: Commons.Color.accent
                    onToggled: root.setShown(modelData.id, !root.isShown(modelData.id))
                  }
                }
              }
            }

            Text {
              textFormat: Text.PlainText
              width: parent.width
              text: "A hidden agent stays out of the bar but remains listed here and in the agent list."
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              wrapMode: Text.WordWrap
            }

            PanelSectionHeader {
              foreground: root.foreground
              fontFamily: root.fontFamily
              text: "OpenRouter"
            }

            Text {
              textFormat: Text.PlainText
              width: parent.width
              text: "A management key shows the whole account: this month's spend against its average, the credits left, and the keys that spent the most. It can create and delete API keys, so it is stored outside shell.json and is never shown again."
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              wrapMode: Text.WordWrap
            }

            Row {
              width: parent.width
              spacing: Style.space(6)

              Text {
                id: keyStatus
                textFormat: Text.PlainText
                width: Math.max(0, parent.width - keyActions.width - parent.spacing)
                anchors.verticalCenter: parent.verticalCenter
                text: root.keyStatusText
                color: root.keyMessage !== "" ? root.stateColor("warning") : root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
                wrapMode: Text.WordWrap
              }

              Row {
                id: keyActions
                anchors.verticalCenter: parent.verticalCenter
                spacing: Style.space(2)

                PanelActionButton {
                  visible: !root.keyFromEnv
                  iconText: "󰌋"
                  tooltipText: root.keyStored ? "Change the management key" : "Set a management key"
                  foreground: root.foreground
                  fontFamily: root.fontFamily
                  enabled: !root.keyBusy && !root.keyEditing
                  onClicked: root.beginKeyEdit()
                }

                PanelActionButton {
                  visible: root.keyStored
                  iconText: "󰆴"
                  tooltipText: "Remove the management key"
                  foreground: root.foreground
                  hoverColor: root.urgent
                  fontFamily: root.fontFamily
                  enabled: !root.keyBusy
                  onClicked: root.removeKey()
                }
              }
            }

            Text {
              textFormat: Text.PlainText
              width: parent.width
              visible: root.keyFromEnv
              text: "Set in the environment. Unset OPENROUTER_MANAGEMENT_KEY to manage it here."
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              wrapMode: Text.WordWrap
            }

            Text {
              textFormat: Text.PlainText
              width: parent.width
              visible: !root.keyStored && !root.keyFromEnv && !root.keyEditing && !root.keyBusy
              text: "Create one at openrouter.ai/settings/management-keys, then paste it here."
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              font.underline: keySetupArea.containsMouse
              wrapMode: Text.WordWrap

              MouseArea {
                id: keySetupArea
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onClicked: Qt.openUrlExternally("https://openrouter.ai/settings/management-keys")
              }
            }

            Column {
              width: parent.width
              spacing: Style.space(4)
              visible: root.keyEditing

              onVisibleChanged: if (visible) Qt.callLater(function() { keyField.forceActiveFocus() })

              Row {
                width: parent.width
                spacing: Style.space(4)

                TextField {
                  id: keyField
                  width: Math.max(0, parent.width - keyStoreBtn.width - keyRevealBtn.width - parent.spacing * 2)
                  password: true
                  revealed: root.keyRevealed
                  placeholderText: "sk-or-v1-…"
                  foreground: root.foreground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.body
                  horizontalPadding: Style.spacing.controlGap
                  verticalPadding: Style.spacing.controlPaddingY
                  text: root.keyDraft
                  enabled: !root.keyBusy
                  onTextChanged: if (root.keyEditing && text !== root.keyDraft) root.keyDraft = text
                  onAccepted: root.submitKey()
                  Keys.onEscapePressed: root.cancelKeyEdit()
                }

                PanelActionButton {
                  id: keyStoreBtn
                  iconText: "󰄬"
                  tooltipText: "Store the key"
                  foreground: root.foreground
                  fontFamily: root.fontFamily
                  enabled: !root.keyBusy && root.keyDraft.trim().length >= 16
                  onClicked: root.submitKey()
                }

                PanelActionButton {
                  id: keyRevealBtn
                  iconText: root.keyRevealed ? "󰈉" : "󰈈"
                  tooltipText: root.keyRevealed ? "Hide the key" : "Show the key"
                  foreground: root.foreground
                  fontFamily: root.fontFamily
                  onClicked: root.keyRevealed = !root.keyRevealed
                }
              }

              Text {
                textFormat: Text.PlainText
                width: parent.width
                text: "Esc cancels. The key is stored in the Secret Service (or a 0600 file if none answers)."
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                wrapMode: Text.WordWrap
              }
            }

            Text {
              textFormat: Text.PlainText
              width: parent.width
              visible: root.keyMessage !== ""
              text: root.keyMessage
              color: root.stateColor("warning")
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              wrapMode: Text.WordWrap
            }

            PanelSectionHeader {
              foreground: root.foreground
              fontFamily: root.fontFamily
              text: "Account view"
            }

            Row {
              width: parent.width
              spacing: Style.space(6)

              Text {
                textFormat: Text.PlainText
                width: Math.max(0, parent.width - keyRowsStepper.width - parent.spacing)
                anchors.verticalCenter: parent.verticalCenter
                text: "Top keys shown"
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
                elide: Text.ElideRight
              }

              Stepper {
                id: keyRowsStepper
                anchors.verticalCenter: parent.verticalCenter
                value: root.openrouterKeyRows
                low: 0
                high: 12
                onChanged: function(next) { root.saveSetting("openrouterKeyRows", next) }
              }
            }

            Row {
              width: parent.width
              spacing: Style.space(6)

              Text {
                textFormat: Text.PlainText
                width: Math.max(0, parent.width - monthsStepper.width - parent.spacing)
                anchors.verticalCenter: parent.verticalCenter
                text: "Average of the last N months"
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
                elide: Text.ElideRight
              }

              Stepper {
                id: monthsStepper
                anchors.verticalCenter: parent.verticalCenter
                value: root.openrouterAverageMonths
                low: 0
                high: 12
                onChanged: function(next) { root.saveSetting("openrouterAverageMonths", next) }
              }
            }

            Text {
              textFormat: Text.PlainText
              width: parent.width
              text: "0 top keys hides the key rows; 0 months shows dollars only and makes no analytics request."
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              wrapMode: Text.WordWrap
            }

            Text {
              textFormat: Text.PlainText
              width: parent.width
              text: "Bar style, thresholds and other settings stay in the widget's settings."
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              wrapMode: Text.WordWrap
            }
          }
        }

        Rectangle {
          id: dropLine
          visible: root.dragging
          x: Style.space(4)
          width: panelFlick.width - Style.space(8)
          height: 2
          radius: 1
          color: Commons.Color.accent
          y: root.dropLineY()
          z: 20
        }

        Rectangle {
          id: dragGhost
          visible: root.dragging
          x: Style.space(4)
          width: panelFlick.width - Style.space(8)
          height: Style.space(34)
          radius: Style.cornerRadius
          color: Style.hoverFillFor(root.foreground, Commons.Color.accent)
          border.width: 1
          border.color: Commons.Color.accent
          y: Math.max(0, Math.min(panelColumn.height - height, root.dragPointerY - height / 2))
          z: 21

          Row {
            anchors.centerIn: parent
            spacing: Style.space(8)

            ProviderMark {
              anchors.verticalCenter: parent.verticalCenter
              providerId: root.dragProviderId
              markSize: Style.font.title
              color: root.foreground
            }

            Text {
              textFormat: Text.PlainText
              anchors.verticalCenter: parent.verticalCenter
              text: root.providerName(root.dragProviderId)
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
              font.bold: true
            }
          }
        }
      }
    }
  }

  component MeterBar: Item {
    id: meter
    property real percent: 0
    property color fill: root.foreground
    width: parent ? parent.width : 0
    height: Math.max(Style.space(4), Math.round(Style.spacing.controlHeight * 0.14))

    Rectangle {
      anchors.fill: parent
      radius: height / 2
      color: root.track
    }

    Rectangle {
      width: Math.max(height, parent.width * Math.min(100, Math.max(0, meter.percent)) / 100)
      height: parent.height
      radius: height / 2
      color: meter.fill

      Behavior on width {
        NumberAnimation { duration: Style.duration(160); easing.type: Easing.OutCubic }
      }
    }
  }

  // A number with minus/plus buttons, used by the settings view. The caller
  // persists the new value and this component only reports it.
  component Stepper: Row {
    id: stepper
    property int value: 0
    property int low: 0
    property int high: 99
    signal changed(int value)
    spacing: Style.space(2)

    function step(delta) {
      var next = Math.max(stepper.low, Math.min(stepper.high, stepper.value + delta))
      if (next !== stepper.value) stepper.changed(next)
    }

    PanelActionButton {
      iconText: "󰍴"
      tooltipText: "Less"
      foreground: root.foreground
      fontFamily: root.fontFamily
      enabled: stepper.value > stepper.low
      onClicked: stepper.step(-1)
    }

    Text {
      textFormat: Text.PlainText
      anchors.verticalCenter: parent.verticalCenter
      width: Style.space(20)
      horizontalAlignment: Text.AlignHCenter
      text: String(stepper.value)
      color: root.foreground
      font.family: root.fontFamily
      font.pixelSize: Style.font.body
      font.bold: true
    }

    PanelActionButton {
      iconText: "󰐕"
      tooltipText: "More"
      foreground: root.foreground
      fontFamily: root.fontFamily
      enabled: stepper.value < stepper.high
      onClicked: stepper.step(1)
    }
  }

  component ProviderSection: Column {
    id: section
    property var provider: null
    width: parent ? parent.width : 0
    spacing: Style.space(8)

    function sectionWindows() {
      return section.provider
        ? Model.windowsFor(section.provider, root.history, root.warnPercent, root.criticalPercent, root.orOptions)
        : []
    }

    PanelSeparator { foreground: root.foreground; visible: section.provider !== null }

    Item {
      id: sectionHeaderWrap
      width: parent.width
      implicitHeight: sectionHeader.implicitHeight

    MouseArea {
      id: sectionDrag
      anchors.fill: parent
      hoverEnabled: true
      preventStealing: true
      cursorShape: pressed ? Qt.ClosedHandCursor : Qt.OpenHandCursor
      onPressed: function(mouse) {
        root.startSectionDrag(section.provider ? section.provider.id : "", sectionDrag, mouse)
      }
      onPositionChanged: function(mouse) {
        if (pressed) root.updateSectionDrag(sectionDrag, mouse)
      }
      onReleased: function(mouse) { root.endSectionDrag() }
      onCanceled: root.cancelSectionDrag()
    }

    Row {
      id: sectionHeader
      width: parent.width
      spacing: Style.space(10)

      ProviderMark {
        id: sectionMark
        anchors.verticalCenter: parent.verticalCenter
        providerId: section.provider ? section.provider.id : ""
        markSize: Style.font.display
        color: root.foreground
      }

      Column {
        width: Math.max(0, sectionHeader.width - sectionMark.width
          - sectionGrip.width - sectionHeader.spacing * 2)
        anchors.verticalCenter: parent.verticalCenter
        spacing: Style.space(2)

        Text {
          textFormat: Text.PlainText
          width: parent.width
          text: section.provider ? section.provider.name : ""
          color: root.foreground
          font.family: root.fontFamily
          font.pixelSize: Style.font.subtitle
          font.bold: true
          elide: Text.ElideRight
        }

        Text {
          textFormat: Text.PlainText
          width: parent.width
          visible: text !== ""
          text: {
            if (!section.provider) return ""
            var parts = []
            if (section.provider.tier !== "") parts.push(section.provider.tier)
            if (section.provider.status !== "") parts.push(section.provider.status)
            if (!root.isShown(section.provider.id)) parts.push("Hidden from bar")
            return parts.join(" · ")
          }
          color: section.provider && section.provider.status !== "" && sectionWindows().length === 0
            ? root.stateColor("warning")
            : root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          elide: Text.ElideRight
        }
      }

      Text {
        id: sectionGrip
        textFormat: Text.PlainText
        anchors.verticalCenter: parent.verticalCenter
        text: "⠿"
        color: root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.body
      }
    }
    }

    Text {
      textFormat: Text.PlainText
      width: parent.width
      visible: section.provider && section.provider.hint !== "" && sectionWindows().length === 0
      text: section.provider ? section.provider.hint : ""
      color: root.dim
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
      wrapMode: Text.WordWrap
    }

    Text {
      textFormat: Text.PlainText
      width: parent.width
      visible: root.showActivity && text !== ""
      text: Model.activityText(section.provider)
      color: root.dim
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
      elide: Text.ElideRight
    }

    Column {
      width: parent.width
      spacing: Style.space(8)

      Repeater {
        model: sectionWindows()

        delegate: Column {
          width: parent.width
          spacing: Style.space(3)

          Item {
            width: parent.width
            implicitHeight: Math.max(windowLabel.implicitHeight, windowValue.implicitHeight)

            Text {
              id: windowLabel
              textFormat: Text.PlainText
              anchors.left: parent.left
              anchors.verticalCenter: parent.verticalCenter
              width: parent.width - windowValue.width - Style.space(12)
              text: modelData.detail
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
              elide: Text.ElideRight
            }

            Text {
              id: windowValue
              textFormat: Text.PlainText
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              text: Model.windowValueText(modelData)
              color: root.stateColor(modelData.color)
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
              font.bold: true
            }
          }

          MeterBar {
            visible: modelData.mode === "meter"
            percent: modelData.fillPercent
            fill: root.stateColor(modelData.color)
          }

          Text {
            textFormat: Text.PlainText
            width: parent.width
            visible: text !== ""
            text: Model.windowCaption(modelData, root.nowMs)
            color: modelData.over ? root.stateColor("yellow") : root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            wrapMode: Text.WordWrap
          }
        }
      }
    }

    Row {
      width: parent.width
      visible: section.provider !== null && section.provider.money !== null && moneyText.text !== ""
      spacing: Style.space(8)

      Text {
        id: moneyText
        textFormat: Text.PlainText
        width: parent.width
        text: section.provider ? Model.moneySummary(section.provider.money) : ""
        color: root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        wrapMode: Text.WordWrap
      }
    }

    Column {
      width: parent.width
      spacing: Style.space(6)
      visible: section.provider !== null && section.provider.budgets.length > 0

      PanelSectionHeader {
        foreground: root.foreground
        fontFamily: root.fontFamily
        text: "Console budgets"
      }

      Repeater {
        model: section.provider ? section.provider.budgets : []

        delegate: Column {
          width: parent.width
          spacing: Style.space(3)

          Item {
            width: parent.width
            implicitHeight: Math.max(budgetLabel.implicitHeight, budgetValue.implicitHeight)

            Text {
              id: budgetLabel
              textFormat: Text.PlainText
              anchors.left: parent.left
              anchors.verticalCenter: parent.verticalCenter
              width: parent.width - budgetValue.width - Style.space(12)
              text: modelData.id
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
              elide: Text.ElideRight
            }

            Text {
              id: budgetValue
              textFormat: Text.PlainText
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              text: Model.formatCurrency(modelData.spent) + " / " + Model.formatCurrency(modelData.limit)
              color: root.stateColor(Model.stateOf(modelData.percent, root.warnPercent, root.criticalPercent))
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
              font.bold: true
            }
          }

          MeterBar {
            percent: modelData.percent
            fill: root.stateColor(Model.stateOf(modelData.percent, root.warnPercent, root.criticalPercent))
          }
        }
      }
    }

    Text {
      textFormat: Text.PlainText
      width: parent.width
      visible: section.provider !== null && section.provider.error !== ""
      text: section.provider ? section.provider.error : ""
      color: root.stateColor("warning")
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
      wrapMode: Text.WordWrap
    }

  }
}
