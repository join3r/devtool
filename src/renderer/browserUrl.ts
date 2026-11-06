/** Empty / new browser tabs. Do not fall back to a search engine. */
export const BLANK_BROWSER_URL = 'about:blank'

export function normalizeBrowserUrl(url: string): string {
  const trimmed = url.trim()
  if (!trimmed || trimmed === BLANK_BROWSER_URL) return BLANK_BROWSER_URL
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return trimmed
  }
  // A dev server on this machine (or the LAN) speaks plain http: `localhost:3000` would fail as https.
  if (/^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\]|[\w-]+\.local)(:\d+)?(\/|$)/i.test(trimmed)) return `http://${trimmed}`
  return `https://${trimmed}`
}
