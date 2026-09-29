import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { ManualLoginManager, parseManualLoginMarker } from './manualLoginManager.js'

class FakeChild extends EventEmitter {
    constructor(pid) {
        super()
        this.pid = pid
        this.stdout = new EventEmitter()
        this.stderr = new EventEmitter()
    }
}

function setup(overrides = {}) {
    const spawned = []
    const killed = []
    const notes = []
    let pid = 100
    const manager = new ManualLoginManager({
        projectRoot: '/app',
        spawn: (command, args, options) => {
            const child = new FakeChild(++pid)
            spawned.push({ command, args, options, child })
            return child
        },
        kill: (target, signal) => killed.push({ pid: target, signal }),
        displayReady: () => true,
        wait: async () => {},
        note: (level, message) => notes.push({ level, message }),
        ...overrides
    })
    const login = () => spawned.find(s => s.args.includes('scripts/main/manualLogin.js'))
    return { manager, spawned, killed, notes, login }
}

test('reads the marker the bot logs', () => {
    assert.deepEqual(parseManualLoginMarker('MANUAL_LOGIN_REQUIRED | email=me@example.com | reason=email-code-only'), {
        email: 'me@example.com',
        reason: 'email-code-only'
    })
    assert.equal(parseManualLoginMarker('Account error: That password is incorrect'), null)
    assert.equal(parseManualLoginMarker(undefined), null)
})

test('a marker in the log becomes a request', () => {
    const { manager } = setup()
    manager.observeLog({ message: 'Starting login process', receivedAt: '2026-09-29T12:00:00.000Z' })
    manager.observeLog({
        message: 'MANUAL_LOGIN_REQUIRED | email=me@example.com | reason=email-code-only',
        receivedAt: '2026-09-29T12:01:00.000Z'
    })
    assert.deepEqual(manager.getStatus().requests, [
        { email: 'me@example.com', reason: 'email-code-only', at: '2026-09-29T12:01:00.000Z' }
    ])
})

test('start brings up the display, VNC, noVNC, then manual-login on that display', async () => {
    const { manager, spawned, login } = setup()
    const status = await manager.start('me@example.com', 'mobile')
    assert.equal(status.state, 'running')
    assert.equal(status.email, 'me@example.com')
    assert.deepEqual(
        spawned.map(s => s.command),
        ['Xvfb', 'x11vnc', 'websockify', process.execPath]
    )
    assert.deepEqual(login().args, ['scripts/main/manualLogin.js', 'me@example.com', '--platform', 'mobile'])
    assert.equal(login().options.env.DISPLAY, ':99')
    assert.equal(login().options.cwd, '/app')
    assert.equal(status.webPort, 6080)
    assert.equal(status.path, '/vnc.html?autoconnect=1&resize=scale')
})

test('a saved sign-in succeeds, stops the helpers and clears the request', async () => {
    const { manager, killed, spawned, login } = setup()
    manager.observeLog({ message: 'MANUAL_LOGIN_REQUIRED | email=me@example.com | reason=email-code-only' })
    await manager.start('me@example.com')
    login().child.emit('exit', 0, null)
    const status = manager.getStatus()
    assert.equal(status.state, 'succeeded')
    assert.equal(status.exitCode, 0)
    assert.deepEqual(status.requests, [])
    const helperPids = spawned.filter(s => s !== login()).map(s => s.child.pid)
    assert.deepEqual(
        killed.map(k => k.pid).sort(),
        helperPids.sort()
    )
})

test('a failed sign-in is reported and keeps the request', async () => {
    const { manager, login } = setup()
    manager.observeLog({ message: 'MANUAL_LOGIN_REQUIRED | email=me@example.com | reason=email-code-only' })
    await manager.start('me@example.com')
    login().child.emit('exit', 1, null)
    assert.equal(manager.getStatus().state, 'failed')
    assert.equal(manager.getStatus().exitCode, 1)
    assert.equal(manager.getStatus().requests.length, 1)
})

test('only one manual login at a time', async () => {
    const { manager } = setup()
    await manager.start('me@example.com')
    await assert.rejects(manager.start('you@example.com'), { code: 'ALREADY_RUNNING' })
})

test('an unknown platform is refused before anything starts', async () => {
    const { manager, spawned } = setup()
    await assert.rejects(manager.start('me@example.com', 'tablet'), { code: 'BAD_REQUEST' })
    assert.equal(spawned.length, 0)
    assert.equal(manager.getStatus().state, 'idle')
})

test('cancel stops the browser and the helpers', async () => {
    const { manager, killed, login } = setup()
    await manager.start('me@example.com')
    const status = manager.cancel()
    assert.equal(status.state, 'cancelled')
    assert.ok(killed.some(k => k.pid === login().child.pid && k.signal === 'SIGTERM'))
    assert.throws(() => manager.cancel(), { code: 'NOT_RUNNING' })
    login().child.emit('exit', null, 'SIGTERM')
    assert.equal(manager.getStatus().state, 'cancelled')
})

test('nobody signing in times out', async () => {
    const { manager } = setup({ timeoutMs: 20 })
    await manager.start('me@example.com')
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.equal(manager.getStatus().state, 'timedOut')
})

test('a display that never comes up fails the start and cleans up', async () => {
    const { manager, spawned, killed } = setup({ displayReady: () => false })
    await assert.rejects(manager.start('me@example.com'), /display/i)
    assert.equal(manager.getStatus().state, 'failed')
    assert.deepEqual(spawned.map(s => s.command), ['Xvfb'])
    assert.equal(killed[0].pid, spawned[0].child.pid)
})
