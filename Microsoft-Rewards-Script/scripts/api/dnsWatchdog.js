import dns from 'node:dns'

/**
 * Docker hands a container the host's DNS servers when the container starts.
 * If the host had none at that moment (the machine booted before its Wi-Fi was
 * up), every lookup in the container fails until it restarts, even once the
 * network is back. The watchdog spots that state: this container's resolver
 * fails while public resolvers answer. It then asks for a restart; the restart
 * policy brings the container back with the host's current DNS servers.
 */

const PROBE_HOST = 'rewards.bing.com'
const PUBLIC_RESOLVERS = ['1.1.1.1', '8.8.8.8']

function lookupPublic(host) {
    const resolver = new dns.promises.Resolver({ timeout: 3000, tries: 1 })
    resolver.setServers(PUBLIC_RESOLVERS)
    return resolver.resolve4(host)
}

export class DnsWatchdog {
    constructor({
        intervalMs = 60_000,
        threshold = 3,
        systemLookup = host => dns.promises.lookup(host),
        publicLookup = lookupPublic,
        onStale,
        note = () => {},
        setInterval: schedule = setInterval,
        clearInterval: cancel = clearInterval
    }) {
        this.intervalMs = intervalMs
        this.threshold = threshold
        this.systemLookup = systemLookup
        this.publicLookup = publicLookup
        this.onStale = onStale
        this.note = note
        this.schedule = schedule
        this.cancel = cancel

        this.failures = 0
        this.timer = null
    }

    /** One check: 'ok', 'offline' (nothing answers) or 'stale' (only public resolvers answer). */
    async check() {
        try {
            await this.systemLookup(PROBE_HOST)
            this.failures = 0
            return 'ok'
        } catch (error) {
            try {
                await this.publicLookup(PROBE_HOST)
            } catch {
                this.failures = 0
                return 'offline'
            }

            this.failures++
            if (this.failures < this.threshold) {
                this.note(
                    'WARN',
                    `DNS check ${this.failures}/${this.threshold}: this container cannot resolve ${PROBE_HOST} (${error?.code ?? error?.message ?? error}), but public DNS can`
                )
                return 'stale'
            }

            this.note(
                'ERROR',
                'DNS in this container is stuck while the network works; restarting the container to pick up the current DNS servers'
            )
            this.stop()
            this.onStale()
            return 'stale'
        }
    }

    start() {
        if (this.timer) return
        this.timer = this.schedule(() => this.check(), this.intervalMs)
        this.timer.unref?.()
    }

    stop() {
        if (!this.timer) return
        this.cancel(this.timer)
        this.timer = null
    }
}
