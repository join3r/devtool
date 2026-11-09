import { describe, expect, it } from 'vitest'
import { isPluginId, parsePluginList, pluginActionArgs, searchPlugins } from '../src/shared/claude-plugins'
import { composerCommands, isPluginsCommand, TERMINAL_ONLY_COMMANDS } from '../src/shared/claude-chat'
import { chatCommands } from '../src/main/mobile/chat-bridge'
import { emptyChatState } from '../src/shared/claude-chat'

const CLI_OUTPUT = {
  installed: [
    { id: 'typescript-lsp@claude-plugins-official', version: '1.0.0', scope: 'user', enabled: true, installPath: '/x' },
    { id: 'security-guidance@synced', version: 'unknown', scope: 'synced', enabled: true, installPath: '', notes: ['shadowed by the local one'] },
    { id: 'feature-dev@claude-plugins-official', version: '1.0.1', scope: 'project', enabled: false },
    { scope: 'user' }
  ],
  available: [
    { pluginId: 'small@dir', name: 'small', description: 'A small one', marketplaceName: 'dir', installCount: 5 },
    { pluginId: 'big@claude-plugins-official', name: 'big', description: 'Formats code', marketplaceName: 'claude-plugins-official', installCount: 9000 },
    { pluginId: 'big@claude-plugins-official', name: 'big' },
    { pluginId: 'nocount@dir', name: 'nocount' }
  ]
}

describe('claude plugins', () => {
  it('reads the CLI list: installed by name, marketplace by install count', () => {
    const catalog = parsePluginList(CLI_OUTPUT)
    expect(catalog.installed.map((p) => p.id)).toEqual([
      'feature-dev@claude-plugins-official', 'security-guidance@synced', 'typescript-lsp@claude-plugins-official'
    ])
    expect(catalog.installed[0]).toEqual({ id: 'feature-dev@claude-plugins-official', name: 'feature-dev', marketplace: 'claude-plugins-official', version: '1.0.1', scope: 'project', enabled: false })
    expect(catalog.installed[1]).toEqual({ id: 'security-guidance@synced', name: 'security-guidance', marketplace: 'synced', scope: 'synced', enabled: true, notes: ['shadowed by the local one'] })
    expect(catalog.available.map((p) => p.id)).toEqual(['big@claude-plugins-official', 'small@dir', 'nocount@dir'])
  })

  it('keeps only the project and local installs of this project', () => {
    const json = {
      installed: [
        { id: 'a@m', scope: 'project', enabled: true, projectPath: '/work/other' },
        { id: 'a@m', scope: 'project', enabled: true, projectPath: '/work/here/' },
        { id: 'b@m', scope: 'local', enabled: false, projectPath: '/private/tmp/here' },
        { id: 'c@m', scope: 'user', enabled: true }
      ]
    }
    expect(parsePluginList(json, ['/work/here']).installed.map((p) => `${p.id}:${p.scope}`)).toEqual(['a@m:project', 'c@m:user'])
    expect(parsePluginList(json, ['/tmp/here', '/private/tmp/here']).installed.map((p) => p.id)).toEqual(['b@m', 'c@m'])
    expect(parsePluginList(json).installed).toHaveLength(4)
  })

  it('reads an older CLI that prints only the installed array', () => {
    expect(parsePluginList([{ id: 'a@m', scope: 'user', enabled: true }])).toEqual({
      installed: [{ id: 'a@m', name: 'a', marketplace: 'm', scope: 'user', enabled: true }],
      available: []
    })
    expect(parsePluginList(null)).toEqual({ installed: [], available: [] })
  })

  it('builds claude plugin arguments, with a scope only when the CLI can write it', () => {
    expect(pluginActionArgs('install', 'big@claude-plugins-official', 'project')).toEqual(['plugin', 'install', 'big@claude-plugins-official', '--scope', 'project'])
    expect(pluginActionArgs('disable', 'security-guidance@synced', 'synced')).toEqual(['plugin', 'disable', 'security-guidance@synced'])
    expect(() => pluginActionArgs('install', '--yes')).toThrow()
  })

  it('accepts only plain plugin ids', () => {
    expect(isPluginId('feature-dev@claude-plugins-official')).toBe(true)
    expect(isPluginId('feature-dev')).toBe(true)
    expect(isPluginId('-rf')).toBe(false)
    expect(isPluginId('a b')).toBe(false)
    expect(isPluginId('a@b@c')).toBe(false)
  })

  it('searches names before descriptions', () => {
    const { available } = parsePluginList(CLI_OUTPUT)
    expect(searchPlugins(available, 'format').map((p) => p.name)).toEqual(['big'])
    expect(searchPlugins(available, 'SMALL').map((p) => p.name)).toEqual(['small'])
    expect(searchPlugins(available, '', 2).map((p) => p.name)).toEqual(['big', 'small'])
  })

  it('opens the plugin manager for /plugins and /plugin', () => {
    expect(isPluginsCommand('plugins')).toBe(true)
    expect(isPluginsCommand('plugin')).toBe(true)
    expect(isPluginsCommand('permissions')).toBe(false)
    expect(TERMINAL_ONLY_COMMANDS.has('plugin')).toBe(true)
    expect(composerCommands([]).some((c) => c.name === 'plugins')).toBe(true)
    expect(composerCommands([], 'codex').some((c) => c.name === 'plugins')).toBe(false)
    // An older phone shows it greyed out; a phone with the chat.plugins sheet runs it itself.
    expect(chatCommands(emptyChatState()).commands.find((c) => c.name === 'plugins')).toEqual({ name: 'plugins', description: 'Install, enable and remove Claude Code plugins', terminalOnly: true })
  })
})
