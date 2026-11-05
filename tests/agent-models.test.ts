import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { readCodexModels, resolveModel } from '../src/main/agent-models'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

describe('agent models', () => {
  it('reads Codex\'s cached list in priority order, hidden ones marked', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'devtool-codex-home-'))
    dirs.push(home)
    fs.writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify({ models: [
      { slug: 'gpt-6-luna', priority: 6, visibility: 'list' },
      { slug: 'gpt-6.1-sol', priority: 1, visibility: 'list' },
      { slug: 'gpt-reserve', priority: 5, visibility: 'hide' }
    ] }))
    expect(readCodexModels({ CODEX_HOME: home })).toEqual([{ id: 'gpt-6.1-sol' }, { id: 'gpt-reserve', hidden: true }, { id: 'gpt-6-luna' }])
    expect(readCodexModels({ CODEX_HOME: path.join(home, 'none') })).toBeNull()
  })

  it('resolves exact ids, short names and refuses the rest', () => {
    const models = [{ id: 'gpt-6.1-sol' }, { id: 'gpt-reserve', hidden: true }, { id: 'gpt-6-luna' }, { id: 'gpt-5.6-luna' }]
    expect(resolveModel('GPT-5.6-Luna', models, 'Codex')).toEqual({ ok: true, model: 'gpt-5.6-luna' })
    expect(resolveModel('gpt-reserve', models, 'Codex')).toEqual({ ok: true, model: 'gpt-reserve' })
    expect(resolveModel('5.6-luna', models, 'Codex')).toMatchObject({ ok: true, model: 'gpt-5.6-luna' })
    expect(resolveModel('sol', models, 'Codex')).toMatchObject({ ok: true, model: 'gpt-6.1-sol', note: '"sol" is gpt-6.1-sol.' })
    expect(resolveModel('reserve', models, 'Codex')).toMatchObject({ ok: false })
    expect(resolveModel('luna', models, 'Codex')).toMatchObject({ ok: true, model: 'gpt-6-luna' })
  })
})
