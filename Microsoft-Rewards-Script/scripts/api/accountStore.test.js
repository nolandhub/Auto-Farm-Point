import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { addAccount, readAccountFields, removeAccount, updateAccount } from './accountStore.js'
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
