import assert from 'node:assert/strict'
import test from 'node:test'

import { DnsWatchdog } from './dnsWatchdog.js'

const ok = async () => ['150.171.27.10']
const fail = async () => {
    throw Object.assign(new Error('getaddrinfo EAI_AGAIN rewards.bing.com'), { code: 'EAI_AGAIN' })
}

function setup(overrides = {}) {
    const restarts = []
    const notes = []
    const watchdog = new DnsWatchdog({
        systemLookup: ok,
        publicLookup: ok,
        onStale: () => restarts.push(Date.now()),
        note: (level, message) => notes.push({ level, message }),
        ...overrides
    })
    return { watchdog, restarts, notes }
}

test('working DNS never asks for a restart', async () => {
    const { watchdog, restarts } = setup()
    for (let i = 0; i < 5; i++) assert.equal(await watchdog.check(), 'ok')
    assert.equal(restarts.length, 0)
})

test('asks for a restart after three checks in a row where only public resolvers answer', async () => {
    const { watchdog, restarts, notes } = setup({ systemLookup: fail })
    assert.equal(await watchdog.check(), 'stale')
    assert.equal(await watchdog.check(), 'stale')
    assert.equal(restarts.length, 0)
    assert.equal(await watchdog.check(), 'stale')
    assert.equal(restarts.length, 1)
    assert.equal(notes.at(-1).level, 'ERROR')
})

test('no restart while public resolvers fail too: the network is down, not the container', async () => {
    const { watchdog, restarts } = setup({ systemLookup: fail, publicLookup: fail })
    for (let i = 0; i < 5; i++) assert.equal(await watchdog.check(), 'offline')
    assert.equal(restarts.length, 0)
})

test('a working check in between starts the count again', async () => {
    let systemWorks = false
    const { watchdog, restarts } = setup({ systemLookup: () => (systemWorks ? ok() : fail()) })
    await watchdog.check()
    await watchdog.check()
    systemWorks = true
    assert.equal(await watchdog.check(), 'ok')
    systemWorks = false
    await watchdog.check()
    await watchdog.check()
    assert.equal(restarts.length, 0)
})

test('start checks on the interval and stop cancels it', async () => {
    const timers = []
    const cleared = []
    let checks = 0
    const { watchdog } = setup({
        intervalMs: 60_000,
        systemLookup: async () => {
            checks++
            return ok()
        },
        setInterval: (fn, ms) => {
            timers.push({ fn, ms })
            return { unref() {} }
        },
        clearInterval: handle => cleared.push(handle)
    })
    watchdog.start()
    assert.equal(timers.length, 1)
    assert.equal(timers[0].ms, 60_000)
    await timers[0].fn()
    assert.equal(checks, 1)
    watchdog.stop()
    assert.equal(cleared.length, 1)
})
