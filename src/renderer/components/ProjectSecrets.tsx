import React, { useEffect, useState } from 'react'
import { HelperText, LinkBtn, SetBlock } from './ui'

/**
 * Project settings' list of secrets the user told DevTool to remember when an
 * agent asked (`request_secret`). Names only: values never come back to a
 * window. Hidden while there are none.
 */
export default function ProjectSecrets({ projectId }: { projectId: string }): React.ReactElement | null {
  const [names, setNames] = useState<string[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    // A stubbed api (tests) may not have it.
    const list = (window.api as Partial<typeof window.api>).secretsList
    if (!list) return
    list(projectId)
      .then(result => { if (live) setNames(result.secrets.map(s => s.name)) })
      .catch(() => { if (live) setNames([]) })
    return () => { live = false }
  }, [projectId])

  if (!names || names.length === 0) return null

  const forget = async (name: string): Promise<void> => {
    setError(null)
    try {
      await window.api.secretsDelete(projectId, name)
      setNames(current => (current ?? []).filter(n => n !== name))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <SetBlock label="Saved secrets" divider>
      <ul className="m-0 p-0 list-none flex flex-col gap-1" data-testid="project-secrets">
        {names.map(name => (
          <li key={name} className="flex items-center justify-between gap-3">
            <span className="font-mono text-sm text-text">{name}</span>
            <LinkBtn danger onClick={() => void forget(name)}>Forget</LinkBtn>
          </li>
        ))}
      </ul>
      <HelperText>Kept encrypted in your keychain. Agents get one only when they ask and you pick Use saved.</HelperText>
      {error && <div className="text-xs text-danger">{error}</div>}
    </SetBlock>
  )
}
