// Package-surface contract (#4, docs/adr/0001): the DSH client-bundler
// convention fixes the meaning of the `./client` export — it is the browser
// UI entry (window.__ModuleLoader__.load, dsh.client injection), the shape
// dsh-voice-mimo and dsh-drop-to-path both ship. The ctx-light MiMo
// TTS/ASR client from #3 therefore lives at `./mimo`.
//
// Run: node --test tests/package-surface.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const pkg = require('../package.json')
const pkgRoot = new URL('../', import.meta.url)

const entryUrl = (target) => new URL(target, pkgRoot)

test('exports["./client"] is the browser UI entry (ModuleLoader shape)', () => {
  const target = pkg.exports['./client']
  assert.equal(typeof target, 'string', './client must map to a single file')
  const source = readFileSync(entryUrl(target), 'utf8')
  assert.ok(source.includes('__ModuleLoader__'), './client entry must register via window.__ModuleLoader__')
  assert.ok(/exports\.inject/.test(source), 'UI entry must declare its injected services')
})

test('exports["./mimo"] is the ctx-light MiMo client from #3', async () => {
  const target = pkg.exports['./mimo']
  assert.equal(typeof target, 'string')
  const mimo = await import(entryUrl(target).href)
  assert.equal(typeof mimo.createMiMoClient, 'function')
  assert.equal(typeof mimo.resolveTtsTarget, 'function')
})

test('dsh.client declares web platform + injectable modules', () => {
  assert.equal(pkg.dsh?.client?.platform, 'web')
  assert.ok(Array.isArray(pkg.dsh?.client?.inject))
  // The UI factory requires react — it must be declared injectable, or the
  // factory throws at load time (the 🔊 breakage root cause from voice-mimo).
  assert.ok(pkg.dsh.client.inject.includes('react'), 'react must be declared in dsh.client.inject')
})
