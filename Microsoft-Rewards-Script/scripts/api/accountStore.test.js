import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { addAccount, readAccountFields, removeAccount, reorderAccounts, updateAccount } from './accountStore.js'
import { loadEnvFile } from './lib.js'

function tempEnv(content = '') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'account-store-'))
    const file = path.join(dir, '.env')
    if (content !== null) fs.writeFileSync(file, content)
    return { dir, file }
}

// What the bot and the API will see after a restart: the file read back by
// the project's own .env loader into an empty environment.
function reread(dir) {
    const saved = process.env
    const cwd = process.cwd()
    process.env = {}
    process.chdir(dir) // the loader looks in the working directory first
    try {
        loadEnvFile(dir)
        return process.env
    } finally {
        process.chdir(cwd)
        process.env = saved
    }
}

test('an added account lands in the next free slot and in the live env', () => {
    const { file } = tempEnv('API_TOKEN="abc"\nACCOUNT_1_EMAIL="one@example.com"\n')
    const env = { ACCOUNT_1_EMAIL: 'one@example.com' }

    const index = addAccount(file, { email: 'two@example.com', password: 'pw' }, env)

    assert.equal(index, 2)
    assert.equal(env.ACCOUNT_2_EMAIL, 'two@example.com')
    assert.equal(env.ACCOUNT_2_PASSWORD, 'pw')
    assert.match(fs.readFileSync(file, 'utf8'), /API_TOKEN="abc"/)
})

test('any single-line password survives the round trip through the .env reader', () => {
    const { dir, file } = tempEnv('')
    const password = `p"a'ss w#rd$HOME\\"`

    addAccount(file, { email: 'me@example.com', password }, {})

    assert.equal(reread(dir).ACCOUNT_1_PASSWORD, password)
})

test('an email already configured is refused', () => {
    const { file } = tempEnv('')
    const env = {}
    addAccount(file, { email: 'me@example.com' }, env)
    assert.throws(() => addAccount(file, { email: 'ME@example.com' }, env), { code: 'ACCOUNT_EXISTS', status: 409 })
})

test('updating replaces a field in place, and an empty value clears it', () => {
    const { dir, file } = tempEnv('')
    const env = {}
    addAccount(file, { email: 'me@example.com', password: 'old', totpSecret: 'JBSWY3DPEHPK3PXP' }, env)

    updateAccount(file, 1, { password: 'new', totpSecret: '' }, env)

    const after = reread(dir)
    assert.equal(after.ACCOUNT_1_PASSWORD, 'new')
    assert.equal(after.ACCOUNT_1_TOTP_SECRET, undefined)
    assert.equal(env.ACCOUNT_1_TOTP_SECRET, undefined)
    assert.equal(fs.readFileSync(file, 'utf8').match(/ACCOUNT_1_PASSWORD/g).length, 1)
})

test('a field added later joins its own account block', () => {
    const { file } = tempEnv('')
    const env = {}
    addAccount(file, { email: 'one@example.com' }, env)
    addAccount(file, { email: 'two@example.com' }, env)

    updateAccount(file, 1, { password: 'late' }, env)

    const keys = fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter(line => line.startsWith('ACCOUNT_'))
        .map(line => line.slice(0, line.indexOf('=')))
    assert.deepEqual(keys, ['ACCOUNT_1_EMAIL', 'ACCOUNT_1_PASSWORD', 'ACCOUNT_2_EMAIL'])
})

test('removing an account drops all of its lines and nothing else', () => {
    const { dir, file } = tempEnv('API_TOKEN="abc"\n')
    const env = {}
    addAccount(file, { email: 'one@example.com', password: 'a' }, env)
    addAccount(file, { email: 'two@example.com', password: 'b' }, env)

    assert.equal(removeAccount(file, 1, env), 'one@example.com')

    const after = reread(dir)
    assert.equal(after.ACCOUNT_1_EMAIL, undefined)
    assert.equal(after.ACCOUNT_1_PASSWORD, undefined)
    assert.equal(after.ACCOUNT_2_EMAIL, 'two@example.com')
    assert.equal(after.API_TOKEN, 'abc')
    assert.equal(env.ACCOUNT_1_EMAIL, undefined)
})

test('the file is created when missing', () => {
    const { dir, file } = tempEnv(null)
    addAccount(file, { email: 'me@example.com' }, {})
    assert.equal(reread(dir).ACCOUNT_1_EMAIL, 'me@example.com')
})

test('unknown slots are reported as not found', () => {
    const { file } = tempEnv('')
    assert.throws(() => removeAccount(file, 3, {}), { code: 'ACCOUNT_NOT_FOUND', status: 404 })
    assert.throws(() => updateAccount(file, 3, { password: 'x' }, {}), { code: 'ACCOUNT_NOT_FOUND' })
})

test('bodies are checked field by field', () => {
    assert.deepEqual(readAccountFields({ email: ' me@example.com ', password: ' spaced ' }, { requireEmail: true }), {
        email: 'me@example.com',
        password: ' spaced '
    })
    assert.throws(() => readAccountFields({}, { requireEmail: true }), /email` is required/)
    assert.throws(() => readAccountFields({ email: 'nope' }, { requireEmail: true }), /email address/)
    assert.throws(() => readAccountFields({ email: 'a@b.c', password: 'x\ny' }, { requireEmail: true }), /control/)
    assert.throws(() => readAccountFields({ email: 'a@b.c', admin: 'yes' }, { requireEmail: true }), /Unknown field/)
    assert.throws(() => readAccountFields({ email: 'a@b.c', geoLocale: 'Vietnam' }, { requireEmail: true }), /country/)
    assert.deepEqual(readAccountFields({ totpSecret: '' }, { requireEmail: false }), { totpSecret: '' })
})

test('a proxy is split into the parts the bot reads, with reward requests sent through it too', () => {
    assert.deepEqual(readAccountFields({ proxy: ' http://user:p%40ss@1.2.3.4:8080 ' }, { requireEmail: false }), {
        proxyUrl: 'http://1.2.3.4',
        proxyPort: '8080',
        proxyUsername: 'user',
        proxyPassword: 'p@ss',
        proxyHttp: 'true'
    })
})

test('a proxy is read in the host:port:user:password form proxy sellers list', () => {
    assert.deepEqual(readAccountFields({ proxy: 'proxy.example.com:3128:user:p@ss:word' }, { requireEmail: false }), {
        proxyUrl: 'http://proxy.example.com',
        proxyPort: '3128',
        proxyUsername: 'user',
        proxyPassword: 'p@ss:word',
        proxyHttp: 'true'
    })
})

test('a proxy without a login clears the one it replaces', () => {
    assert.deepEqual(readAccountFields({ proxy: 'socks5://10.0.0.2:1080' }, { requireEmail: false }), {
        proxyUrl: 'socks5://10.0.0.2',
        proxyPort: '1080',
        proxyUsername: '',
        proxyPassword: '',
        proxyHttp: 'true'
    })
})

test('an empty proxy clears every proxy part', () => {
    assert.deepEqual(readAccountFields({ proxy: '' }, { requireEmail: false }), {
        proxyUrl: '',
        proxyPort: '',
        proxyUsername: '',
        proxyPassword: '',
        proxyHttp: ''
    })
})

test('a proxy the bot would refuse is refused before it is saved', () => {
    const read = proxy => () => readAccountFields({ proxy }, { requireEmail: false })
    assert.throws(read('1.2.3.4'), /host:port/)
    assert.throws(read('ftp://1.2.3.4:21'), /http, https, socks4 or socks5/)
    assert.throws(read('1.2.3.4:0'), /1 to 65535/)
    assert.throws(read('1.2.3.4:70000'), /1 to 65535/)
    assert.throws(read('http://user:@1.2.3.4:8080'), /both a username and a password/)
    assert.throws(read('socks5://user:pass@1.2.3.4:1080'), /SOCKS/)
    assert.throws(read('http://user:%E0%A4%A@1.2.3.4:8080'), /encoding/)
})

test('the proxy parts are stored under the account and removed together', () => {
    const { dir, file } = tempEnv('')
    const env = {}
    const proxy = readAccountFields({ proxy: 'http://user:pa"ss@1.2.3.4:8080' }, { requireEmail: false })
    addAccount(file, { email: 'me@example.com', ...proxy }, env)

    const saved = reread(dir)
    assert.equal(saved.ACCOUNT_1_PROXY_URL, 'http://1.2.3.4')
    assert.equal(saved.ACCOUNT_1_PROXY_PORT, '8080')
    assert.equal(saved.ACCOUNT_1_PROXY_USERNAME, 'user')
    assert.equal(saved.ACCOUNT_1_PROXY_PASSWORD, 'pa"ss')
    assert.equal(saved.ACCOUNT_1_PROXY_HTTP, 'true')

    updateAccount(file, 1, readAccountFields({ proxy: '' }, { requireEmail: false }), env)

    const cleared = Object.keys(reread(dir)).filter(key => key.includes('PROXY'))
    assert.deepEqual(cleared, [])
    assert.deepEqual(Object.keys(env).filter(key => key.includes('PROXY')), [])
})

test('the proxy parts cannot be sent one by one', () => {
    assert.throws(() => readAccountFields({ proxyUrl: 'http://1.2.3.4' }, { requireEmail: false }), /Unknown field/)
})

const THREE = [
    '# Accounts, managed from the Bing Auto Search manager page.',
    'API_TOKEN="abc"',
    '',
    '# Account 1',
    'ACCOUNT_1_EMAIL="a@example.com"',
    `ACCOUNT_1_PASSWORD="p"a'ss w#rd$HOME"`,
    '',
    '# Account 2',
    'ACCOUNT_2_EMAIL="b@example.com"',
    'ACCOUNT_2_TOTP_SECRET="JBSWY3DPEHPK3PXP"',
    '',
    '# Account 3',
    'ACCOUNT_3_EMAIL="c@example.com"',
    'ACCOUNT_3_GEO_LOCALE="VN"',
    ''
].join('\n')

test('reordering renumbers the account blocks and keeps every value as written', () => {
    const { dir, file } = tempEnv(THREE)
    const env = reread(dir)

    const order = reorderAccounts(file, ['c@example.com', 'a@example.com', 'b@example.com'], env)

    assert.deepEqual(order, [
        { index: 1, email: 'c@example.com' },
        { index: 2, email: 'a@example.com' },
        { index: 3, email: 'b@example.com' }
    ])
    const after = reread(dir)
    assert.equal(after.ACCOUNT_1_EMAIL, 'c@example.com')
    assert.equal(after.ACCOUNT_1_GEO_LOCALE, 'VN')
    assert.equal(after.ACCOUNT_2_EMAIL, 'a@example.com')
    assert.equal(after.ACCOUNT_2_PASSWORD, `p"a'ss w#rd$HOME`)
    assert.equal(after.ACCOUNT_3_EMAIL, 'b@example.com')
    assert.equal(after.ACCOUNT_3_TOTP_SECRET, 'JBSWY3DPEHPK3PXP')
    assert.equal(after.ACCOUNT_3_GEO_LOCALE, undefined)
    assert.equal(after.API_TOKEN, 'abc')

    const text = fs.readFileSync(file, 'utf8')
    assert.ok(text.startsWith('# Accounts, managed from the Bing Auto Search manager page.\nAPI_TOKEN="abc"\n'))
    assert.ok(text.indexOf('# Account 1\nACCOUNT_1_EMAIL="c@example.com"') !== -1)
    assert.equal(text.match(/# Account \d/g).length, 3)

    // The live env matches the file, with no field left at an old number.
    const accountKeys = source =>
        Object.fromEntries(Object.entries(source).filter(([key]) => key.startsWith('ACCOUNT_')))
    assert.deepEqual(accountKeys(env), accountKeys(after))
})

test('a list that does not match the configured accounts is refused and nothing changes', () => {
    for (const emails of [
        ['a@example.com', 'b@example.com'],
        ['a@example.com', 'b@example.com', 'c@example.com', 'd@example.com'],
        ['a@example.com', 'a@example.com', 'b@example.com'],
        ['a@example.com', 'b@example.com', 'x@example.com']
    ]) {
        const { dir, file } = tempEnv(THREE)
        const env = reread(dir)
        assert.throws(() => reorderAccounts(file, emails, env), { code: 'ACCOUNTS_CHANGED', status: 409 })
        assert.equal(fs.readFileSync(file, 'utf8'), THREE)
        assert.equal(env.ACCOUNT_1_EMAIL, 'a@example.com')
    }
})

test('emails in the new order match whatever their case', () => {
    const { dir, file } = tempEnv(THREE)
    reorderAccounts(file, ['B@Example.com', 'c@example.com', 'A@example.com'], reread(dir))
    assert.equal(reread(dir).ACCOUNT_1_EMAIL, 'b@example.com')
})

test('a new order must be a list of emails', () => {
    const { dir, file } = tempEnv(THREE)
    for (const emails of [undefined, 'a@example.com', [1, 2, 3]]) {
        assert.throws(() => reorderAccounts(file, emails, reread(dir)), { code: 'BAD_REQUEST', status: 400 })
    }
})

test('fields left without an email move after the accounts, never into one', () => {
    const { dir, file } = tempEnv(THREE + 'ACCOUNT_9_PASSWORD="orphan"\n')
    reorderAccounts(file, ['c@example.com', 'b@example.com', 'a@example.com'], reread(dir))
    const after = reread(dir)
    assert.equal(after.ACCOUNT_1_PASSWORD, undefined)
    assert.equal(after.ACCOUNT_3_PASSWORD, `p"a'ss w#rd$HOME`)
    assert.equal(after.ACCOUNT_4_PASSWORD, 'orphan')
})

test('reordering and putting the order back leaves the file exactly as it was', () => {
    const { dir, file } = tempEnv(THREE)
    const env = reread(dir)
    reorderAccounts(file, ['c@example.com', 'a@example.com', 'b@example.com'], env)
    reorderAccounts(file, ['b@example.com', 'c@example.com', 'a@example.com'], env)
    reorderAccounts(file, ['a@example.com', 'b@example.com', 'c@example.com'], env)
    assert.equal(fs.readFileSync(file, 'utf8'), THREE)
})
