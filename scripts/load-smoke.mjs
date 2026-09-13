/**
 * Loads the built artifact and asserts it exports the Cordis function-plugin
 * face the harness loader requires. Run after `npm run build`.
 * @module
 */
import assert from 'node:assert/strict'

const mod = await import(new URL('../lib/index.js', import.meta.url).href)

assert.equal(mod.name, 'dsh-data-profiling', 'plugin name export')
assert.deepEqual(mod.inject, ['tools'], 'inject declares the tools service')
assert.equal(typeof mod.apply, 'function', 'apply is a function')
assert.ok(mod.Config, 'Config schema export present')

const registered = []
mod.apply({ tools: { register: def => registered.push(def) } }, { sampleSize: 3, maxColumns: 50, nullWarnPct: 20 })
assert.deepEqual(
  registered.map(t => t.name).sort(),
  ['profile_csv', 'profile_json', 'profile_report'],
  'all three tools register',
)
assert.ok(registered.every(t => t.output && typeof t.output.render === 'function'), 'every tool declares an output renderer')

console.log('load-smoke: ok —', registered.length, 'tools registered from built artifact')
