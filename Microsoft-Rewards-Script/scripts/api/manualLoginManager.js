import { spawn as nodeSpawn } from 'node:child_process'
import fs from 'node:fs'

/**
 * Runs the bot's own manual-login command on a virtual display that the user
 * sees through noVNC, for accounts the bot cannot sign in to by itself (an
 * emailed code, a passkey). One at a time; the extension decides when.
 */

const MARKER_RE = /^MANUAL_LOGIN_REQUIRED \| email=(\S+@\S+) \| reason=([a-z-]+)$/
const PLATFORMS = ['mobile', 'desktop', 'both']
const DISPLAY_WAIT_STEPS = 50
const DISPLAY_WAIT_MS = 100

/** The line Login.ts logs when an account needs a person (manualLoginMarker in LoginState.ts). */
export function parseManualLoginMarker(message) {
    const match = MARKER_RE.exec(String(message ?? '').trim())
    return match ? { email: match[1], reason: match[2] } : null
}

function codedError(message, code) {
    return Object.assign(new Error(message), { code })
}

export class ManualLoginManager {
    constructor({
        projectRoot,
        display = ':99',
        webPort = 6080,
        vncPort = 5900,
        timeoutMs = 15 * 60 * 1000,
        spawn = nodeSpawn,
        kill = (pid, signal) => process.kill(-pid, signal),
        displayReady = name => fs.existsSync(`/tmp/.X11-unix/X${name.slice(1)}`),
        wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
        note = () => {}
    }) {
        this.projectRoot = projectRoot
        this.display = display
        this.webPort = webPort
        this.vncPort = vncPort
        this.timeoutMs = timeoutMs
        this.spawn = spawn
        this.kill = kill
        this.displayReady = displayReady
        this.wait = wait
        this.note = note

        this.state = 'idle'
        this.email = null
        this.platform = null
        this.startedAt = null
        this.endedAt = null
        this.exitCode = null
        this.requests = new Map()
        this.helpers = []
        this.login = null
        this.timer = null
    }

    observeLog(entry) {
        const marker = parseManualLoginMarker(entry?.message)
        if (!marker) return
        this.requests.set(marker.email, { ...marker, at: entry.receivedAt ?? new Date().toISOString() })
    }

    getStatus() {
        return {
            state: this.state,
            email: this.email,
            platform: this.platform,
            startedAt: this.startedAt,
            endedAt: this.endedAt,
            exitCode: this.exitCode,
            webPort: this.webPort,
            path: '/vnc.html?autoconnect=1&resize=scale',
            requests: [...this.requests.values()]
        }
    }

    async start(email, platform = 'both') {
        if (this.state === 'running') throw codedError('A manual login is already running.', 'ALREADY_RUNNING')
        if (!PLATFORMS.includes(platform)) {
            throw codedError('`platform` must be mobile, desktop, or both.', 'BAD_REQUEST')
        }

        this.state = 'running'
        this.email = email
        this.platform = platform
        this.startedAt = new Date().toISOString()
        this.endedAt = null
        this.exitCode = null
        this.note('info', `Manual login started for ${email} (${platform}).`)

        try {
            this.helpers.push(this.startHelper('Xvfb', [this.display, '-screen', '0', '1920x1080x24', '-nolisten', 'tcp']))
            await this.waitForDisplay()
            this.helpers.push(
                this.startHelper('x11vnc', [
                    '-display',
                    this.display,
                    '-rfbport',
                    String(this.vncPort),
                    '-localhost',
                    '-nopw',
                    '-forever',
                    '-shared',
                    '-quiet'
                ])
            )
            this.helpers.push(
                this.startHelper('websockify', ['--web', '/usr/share/novnc', String(this.webPort), `localhost:${this.vncPort}`])
            )
            this.login = this.startLogin(email, platform)
        } catch (error) {
            this.finish('failed', null)
            throw error
        }

        const login = this.login
        login.once('exit', code => {
            if (this.login === login) this.finish(code === 0 ? 'succeeded' : 'failed', code)
        })
        login.once('error', error => {
            this.note('error', `Manual login could not start: ${error.message}`)
            if (this.login === login) this.finish('failed', null)
        })
        this.timer = setTimeout(() => this.stopWith('timedOut'), this.timeoutMs)
        this.timer.unref?.()
        return this.getStatus()
    }

    cancel() {
        if (this.state !== 'running') throw codedError('No manual login is running.', 'NOT_RUNNING')
        this.stopWith('cancelled')
        return this.getStatus()
    }

    startHelper(command, args) {
        return this.spawn(command, args, { cwd: this.projectRoot, stdio: 'ignore', detached: true })
    }

    startLogin(email, platform) {
        const env = { ...process.env, DISPLAY: this.display }
        delete env.FORCE_HEADLESS
        const child = this.spawn(process.execPath, ['scripts/main/manualLogin.js', email, '--platform', platform], {
            cwd: this.projectRoot,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: true
        })
        const forward = chunk => {
            for (const line of String(chunk).split('\n')) {
                if (line.trim()) this.note('info', `[manual-login] ${line.trim()}`)
            }
        }
        child.stdout?.on('data', forward)
        child.stderr?.on('data', forward)
        return child
    }

    async waitForDisplay() {
        for (let step = 0; step < DISPLAY_WAIT_STEPS; step++) {
            if (this.displayReady(this.display)) return
            await this.wait(DISPLAY_WAIT_MS)
        }
        throw new Error(`Virtual display ${this.display} did not start`)
    }

    stopWith(state) {
        if (this.state !== 'running') return
        this.signal(this.login, 'SIGTERM')
        this.finish(state, null)
    }

    finish(state, exitCode) {
        if (this.state !== 'running') return
        clearTimeout(this.timer)
        this.timer = null
        for (const helper of this.helpers) this.signal(helper, 'SIGTERM')
        this.helpers = []
        this.login = null
        this.state = state
        this.exitCode = exitCode
        this.endedAt = new Date().toISOString()
        if (state === 'succeeded') this.requests.delete(this.email)
        this.note(state === 'succeeded' ? 'info' : 'warn', `Manual login ${state} for ${this.email}.`)
    }

    signal(child, signal) {
        if (!child?.pid) return
        try {
            this.kill(child.pid, signal)
        } catch {
            // already gone
        }
    }
}
