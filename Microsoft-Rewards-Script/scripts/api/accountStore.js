import fs from 'node:fs'

// Adds, edits, and removes ACCOUNT_<N>_* entries in the .env file the bot and
// this API read, so accounts can be managed over HTTP instead of by hand.
// The file is rewritten in place rather than renamed over: in Docker it is a
// bind-mounted single file, and a rename cannot replace a mount point.

const FIELDS = {
    email: 'EMAIL',
    password: 'PASSWORD',
    totpSecret: 'TOTP_SECRET',
    recoveryEmail: 'RECOVERY_EMAIL',
    geoLocale: 'GEO_LOCALE',
    langCode: 'LANG_CODE',
    // Written from the one `proxy` field of a body, never sent on their own.
    proxyUrl: 'PROXY_URL',
    proxyPort: 'PROXY_PORT',
    proxyUsername: 'PROXY_USERNAME',
    proxyPassword: 'PROXY_PASSWORD',
    proxyHttp: 'PROXY_HTTP'
}

const PROXY_SCHEMES = new Set(['http', 'https', 'socks4', 'socks5'])
// [scheme://][user:password@]host:port; a login holding @ is percent-encoded.
const PROXY_URL = /^(?:([a-z][a-z\d+.-]*):\/\/)?(?:([^:@\s]*):([^@\s]*)@)?([a-z\d.-]+):(\d+)\/?$/i
// host:port:user:password, the way proxy sellers list them; the password is the rest.
const PROXY_LIST = /^([a-z\d.-]+):(\d+):([^:\s]+):(\S+)$/i

const ACCOUNT_KEY = /^ACCOUNT_([1-9]\d*)_([A-Z_]+)$/

function fail(message, code, status = 400) {
    return Object.assign(new Error(message), { code, status })
}

function hasControlCharacters(value) {
    return [...value].some(character => {
        const code = character.charCodeAt(0)
        return code < 32 || code === 127
    })
}

function isEmail(value) {
    return value.length <= 320 && /^[^\s@]+@[^\s@]+$/.test(value)
}

// Every rule leaves a value the .env reader gives back unchanged.
const RULES = {
    email: value => (isEmail(value) ? null : 'must be an email address'),
    password: value => (value.length <= 1024 ? null : 'is too long'),
    totpSecret: value => (/^[A-Z2-7 =]{16,}$/i.test(value) ? null : 'must be a base32 TOTP secret'),
    recoveryEmail: value => (isEmail(value) ? null : 'must be an email address'),
    geoLocale: value => (/^(auto|[A-Z]{2})$/i.test(value) ? null : 'must be "auto" or a two-letter country code'),
    langCode: value => (/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(value) ? null : 'must be a language tag such as en')
}

/**
 * Splits a proxy into the ACCOUNT_<N>_PROXY_* parts, refusing what the bot's
 * own validation would refuse at run time. Every part is set, so a proxy
 * without a login clears the login of the one it replaces, and '' clears all.
 * Reward API requests go through the proxy as well, or the account would be
 * seen from two addresses in one run.
 */
function readProxy(value) {
    if (value === '') {
        return { proxyUrl: '', proxyPort: '', proxyUsername: '', proxyPassword: '', proxyHttp: '' }
    }
    const listed = PROXY_LIST.exec(value)
    const [, scheme = 'http', username = '', password = '', host, port] = listed
        ? [value, 'http', listed[3], listed[4], listed[1], listed[2]]
        : (PROXY_URL.exec(value) ?? [])
    if (!host) {
        throw fail('`proxy` must look like http://user:password@host:port or host:port:user:password.', 'BAD_REQUEST')
    }
    const protocol = scheme.toLowerCase()
    if (!PROXY_SCHEMES.has(protocol)) throw fail('`proxy` must use http, https, socks4 or socks5.', 'BAD_REQUEST')
    const portNumber = Number(port)
    if (portNumber < 1 || portNumber > 65535) throw fail('`proxy` port must be from 1 to 65535.', 'BAD_REQUEST')

    let user = username
    let pass = password
    if (!listed) {
        try {
            user = decodeURIComponent(username)
            pass = decodeURIComponent(password)
        } catch {
            throw fail('`proxy` login has broken percent-encoding.', 'BAD_REQUEST')
        }
    }
    if (Boolean(user) !== Boolean(pass)) {
        throw fail('`proxy` needs both a username and a password, or neither.', 'BAD_REQUEST')
    }
    if (user && protocol.startsWith('socks')) {
        throw fail('SOCKS proxies with a username and password are not supported; use an http proxy.', 'BAD_REQUEST')
    }
    return {
        proxyUrl: `${protocol}://${host}`,
        proxyPort: String(portNumber),
        proxyUsername: user,
        proxyPassword: pass,
        proxyHttp: 'true'
    }
}

/**
 * Checks the fields of an account body. Unknown fields are refused; an empty
 * string clears an optional field.
 */
export function readAccountFields(body, { requireEmail }) {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        throw fail('Body must be a JSON object.', 'BAD_REQUEST')
    }
    const unknown = Object.keys(body).filter(key => !(key in RULES) && key !== 'proxy')
    if (unknown.length)
        throw fail(`Unknown field${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`, 'BAD_REQUEST')

    const fields = {}
    for (const [name, raw] of Object.entries(body)) {
        if (typeof raw !== 'string') throw fail(`\`${name}\` must be a string.`, 'BAD_REQUEST')
        const value = name === 'password' ? raw : raw.trim()
        if (hasControlCharacters(value)) throw fail(`\`${name}\` must not contain control characters.`, 'BAD_REQUEST')
        if (name === 'proxy') {
            Object.assign(fields, readProxy(value))
            continue
        }
        if (value === '') {
            if (name === 'email') throw fail('`email` must not be empty.', 'BAD_REQUEST')
            fields[name] = ''
            continue
        }
        const problem = RULES[name](value)
        if (problem) throw fail(`\`${name}\` ${problem}.`, 'BAD_REQUEST')
        fields[name] = value
    }
    if (requireEmail && !fields.email) throw fail('`email` is required.', 'BAD_REQUEST')
    return fields
}

function readLines(file) {
    try {
        return fs.readFileSync(file, 'utf8').split(/\r?\n/)
    } catch (err) {
        if (err.code === 'ENOENT') return []
        throw err
    }
}

function writeLines(file, lines) {
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop()
    fs.writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 })
}

function keyOf(line) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return null
    const eq = trimmed.indexOf('=')
    return eq === -1 ? null : trimmed.slice(0, eq).trim()
}

// The reader strips exactly one pair of surrounding quotes and nothing else,
// so wrapping in double quotes round-trips any single-line value.
function entry(key, value) {
    return `${key}="${value}"`
}

function accountIndexes(lines, env) {
    const indexes = new Set()
    for (const key of [...lines.map(keyOf), ...Object.keys(env)]) {
        const match = key && ACCOUNT_KEY.exec(key)
        if (match) indexes.add(Number(match[1]))
    }
    return indexes
}

function emailAt(index, env) {
    const value = env[`ACCOUNT_${index}_EMAIL`]
    return typeof value === 'string' && value.trim() ? value.trim() : null
}

function setField(lines, env, key, value) {
    const at = lines.findIndex(line => keyOf(line) === key)
    if (value === '') {
        if (at !== -1) lines.splice(at, 1)
        delete env[key]
        return
    }
    if (at !== -1) {
        lines[at] = entry(key, value)
    } else {
        // Next to the account's other lines, so each account stays one block.
        const prefix = key.slice(0, key.indexOf('_', 'ACCOUNT_'.length) + 1)
        const last = lines.findLastIndex(line => keyOf(line)?.startsWith(prefix))
        lines.splice(last === -1 ? lines.length : last + 1, 0, entry(key, value))
    }
    env[key] = value
}

/** Adds an account in the next free slot. Returns its index. */
export function addAccount(file, fields, env = process.env) {
    const lines = readLines(file)
    const indexes = accountIndexes(lines, env)
    const taken = [...indexes].map(i => emailAt(i, env)?.toLowerCase())
    if (taken.includes(fields.email.toLowerCase())) {
        throw fail(`${fields.email} is already configured.`, 'ACCOUNT_EXISTS', 409)
    }

    const index = Math.max(0, ...indexes) + 1
    if (lines.length && lines[lines.length - 1].trim() !== '') lines.push('')
    lines.push(`# Account ${index}`)
    for (const [name, suffix] of Object.entries(FIELDS)) {
        if (fields[name]) setField(lines, env, `ACCOUNT_${index}_${suffix}`, fields[name])
    }
    writeLines(file, lines)
    return index
}

/** Changes the given fields of an existing account; '' clears a field. */
export function updateAccount(file, index, fields, env = process.env) {
    if (!emailAt(index, env)) throw fail(`ACCOUNT_${index} is not configured.`, 'ACCOUNT_NOT_FOUND', 404)
    const lines = readLines(file)
    if (fields.email) {
        const clash = [...accountIndexes(lines, env)].some(
            i => i !== index && emailAt(i, env)?.toLowerCase() === fields.email.toLowerCase()
        )
        if (clash) throw fail(`${fields.email} is already configured.`, 'ACCOUNT_EXISTS', 409)
    }
    for (const [name, value] of Object.entries(fields)) {
        setField(lines, env, `ACCOUNT_${index}_${FIELDS[name]}`, value)
    }
    writeLines(file, lines)
}

/** Removes every ACCOUNT_<index>_* entry. Returns the removed email. */
export function removeAccount(file, index, env = process.env) {
    const email = emailAt(index, env)
    if (!email) throw fail(`ACCOUNT_${index} is not configured.`, 'ACCOUNT_NOT_FOUND', 404)
    const prefix = `ACCOUNT_${index}_`
    const lines = readLines(file).filter(line => {
        const key = keyOf(line)
        return !(key && key.startsWith(prefix)) && line.trim() !== `# Account ${index}`
    })
    for (const key of Object.keys(env)) if (key.startsWith(prefix)) delete env[key]
    writeLines(file, lines)
    return email
}

/**
 * Renumbers the accounts so the bot, which runs them by number, runs them in
 * the order of `emails`. Each line moves to its new number exactly as written;
 * fields that have no email move after the accounts, so they never join one.
 * Returns the new order as [{ index, email }].
 */
export function reorderAccounts(file, emails, env = process.env) {
    if (!Array.isArray(emails) || !emails.every(email => typeof email === 'string')) {
        throw fail('`emails` must be a list of the account emails in their new order.', 'BAD_REQUEST')
    }
    const lines = readLines(file)
    const indexes = [...accountIndexes(lines, env)].sort((a, b) => a - b)
    const byEmail = new Map(indexes.filter(i => emailAt(i, env)).map(i => [emailAt(i, env).toLowerCase(), i]))
    const wanted = emails.map(email => email.trim().toLowerCase())
    if (
        wanted.length !== byEmail.size ||
        new Set(wanted).size !== wanted.length ||
        !wanted.every(e => byEmail.has(e))
    ) {
        throw fail('The accounts have changed since this list was read. Reload and try again.', 'ACCOUNTS_CHANGED', 409)
    }

    const ordered = wanted.map(email => byEmail.get(email))
    const orphans = indexes.filter(i => !ordered.includes(i))
    const renumber = new Map([...ordered, ...orphans].map((old, at) => [old, at + 1]))
    const oldIndex = key => Number(ACCOUNT_KEY.exec(key ?? '')?.[1] ?? 0)

    // What is not an account stays; the blank lines that parted the old blocks fold into one.
    const kept = lines
        .filter(line => !oldIndex(keyOf(line)) && !/^# Account \d+$/.test(line.trim()))
        .filter((line, at, rest) => line.trim() !== '' || (at > 0 && rest[at - 1].trim() !== ''))
    for (const [old, index] of renumber) {
        const block = lines.filter(line => oldIndex(keyOf(line)) === old)
        if (!block.length) continue
        if (kept.length && kept[kept.length - 1].trim() !== '') kept.push('')
        if (index <= ordered.length) kept.push(`# Account ${index}`)
        for (const line of block) kept.push(line.replace(`ACCOUNT_${old}_`, `ACCOUNT_${index}_`))
    }

    const moved = Object.entries(env).filter(([key]) => oldIndex(key))
    for (const [key] of moved) delete env[key]
    for (const [key, value] of moved)
        env[key.replace(`ACCOUNT_${oldIndex(key)}_`, `ACCOUNT_${renumber.get(oldIndex(key))}_`)] = value

    writeLines(file, kept)
    return ordered.map((old, at) => ({ index: at + 1, email: emailAt(at + 1, env) }))
}
