'use strict'

// Test-only preload (`node -r ./scripts/test-https-stub.js collect.js`): replaces
// https.request/https.get with canned openrouter.ai answers so the collector
// tests never touch the network. Not shipped by install.sh.
//
//   STUB_ROUTES  JSON file: { "GET https://…": { status, body } | { fail: "message" } }
//                ("POST https://…" for POST); an unknown route fails like a
//                network error.
//   STUB_LOG     file that receives one JSON line per request:
//                { method, url, authorization, contentType, body }
//   STUB_NOW     optional fixed Date.now() in epoch ms.

const EventEmitter = require('events')
const fs = require('fs')
const https = require('https')

const routes = process.env.STUB_ROUTES ? JSON.parse(fs.readFileSync(process.env.STUB_ROUTES, 'utf8')) : {}
const logFile = process.env.STUB_LOG || ''

if (process.env.STUB_NOW) {
  const fixed = Number(process.env.STUB_NOW)
  Date.now = function() { return fixed }
}

function headerValue(headers, name) {
  for (const key of Object.keys(headers || {})) {
    if (key.toLowerCase() === name) return String(headers[key])
  }
  return ''
}

function request(url, options, callback) {
  if (typeof options === 'function') { callback = options; options = {} }
  const target = typeof url === 'string' ? url : url.href
  const method = (options && options.method) || 'GET'
  const req = new EventEmitter()
  const parts = []
  let destroyed = false
  req.setTimeout = function() { return req }
  req.write = function(chunk) { parts.push(Buffer.from(chunk)) }
  req.destroy = function(error) {
    destroyed = true
    if (error) setImmediate(function() { req.emit('error', error) })
  }
  req.end = function() {
    const body = Buffer.concat(parts).toString('utf8')
    if (logFile) {
      fs.appendFileSync(logFile, JSON.stringify({
        method: method,
        url: target,
        authorization: headerValue(options.headers, 'authorization'),
        contentType: headerValue(options.headers, 'content-type'),
        body: body
      }) + '\n')
    }
    const route = new URL(target).hostname === 'openrouter.ai' ? routes[method + ' ' + target] : null
    setImmediate(function() {
      if (destroyed) return
      if (!route || route.fail) {
        req.emit('error', new Error(route && route.fail ? route.fail : 'no stub route for ' + method + ' ' + target))
        return
      }
      const res = new EventEmitter()
      res.statusCode = route.status
      callback(res)
      res.emit('data', Buffer.from(typeof route.body === 'string' ? route.body : JSON.stringify(route.body)))
      res.emit('end')
    })
  }
  return req
}

https.request = request
https.get = function(url, options, callback) {
  const req = request(url, options, callback)
  req.end()
  return req
}
