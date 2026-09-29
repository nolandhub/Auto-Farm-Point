import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { readConfig, writeConfigAtomic } from './configEditor.js'

// The Docker layout: the real file lives on the ./config volume and the
// entrypoint links <root>/config.json to it on every container start.
function dockerLayout(content) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'config-editor-'))
    fs.mkdirSync(path.join(root, 'config'))
    const real = path.join(root, 'config', 'config.json')
    fs.writeFileSync(real, JSON.stringify(content))
    fs.symlinkSync(real, path.join(root, 'config.json'))
    return { root, real }
}

test('a config write reaches the volume file behind the root symlink', () => {
    const { root, real } = dockerLayout({ workers: { doBonusSearches: false } })

    writeConfigAtomic(root, { workers: { doBonusSearches: true } })

    assert.equal(JSON.parse(fs.readFileSync(real, 'utf8')).workers.doBonusSearches, true)
    assert.ok(fs.lstatSync(path.join(root, 'config.json')).isSymbolicLink(), 'the link must stay a link')
    assert.equal(readConfig(root).data.workers.doBonusSearches, true)
})

test('the backup lands next to the volume file', () => {
    const { root, real } = dockerLayout({ workers: { doBonusSearches: false } })

    writeConfigAtomic(root, { workers: { doBonusSearches: true } })

    assert.equal(JSON.parse(fs.readFileSync(`${real}.bak`, 'utf8')).workers.doBonusSearches, false)
})

test('a plain config.json is still written in place', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'config-editor-'))
    const file = path.join(root, 'config.json')
    fs.writeFileSync(file, JSON.stringify({ a: 1 }))

    writeConfigAtomic(root, { a: 2 })

    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: 2 })
})
