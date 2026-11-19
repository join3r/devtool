import type { StreamPushResult } from './types'

/** A one-line account of a push for a toast or the phone. */
export function streamPushMessage(result: StreamPushResult): string {
  switch (result.status) {
    case 'pushed': return `Pushed ${result.commits === 1 ? '1 commit' : `${result.commits} commits`} to ${result.upstream}`
    case 'nothing': return `${result.upstream} is up to date`
    case 'rejected': return result.message
    case 'auth': return result.message
    case 'no-remote': return 'This repository has no remote to push to'
    case 'failed': return result.error
  }
}
