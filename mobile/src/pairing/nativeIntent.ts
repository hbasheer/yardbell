export function redirectPairingPath(path: string): string {
  const full = /^yardbell:\/\/pair[/?]?/.exec(path)
  const relative = /^\/?pair\?/.exec(path)
  if (!full && !relative) return path
  const query = path.slice(path.indexOf('?'))
  if (path.indexOf('?') === -1 || query.includes('link=')) return path
  return `/pair?link=${encodeURIComponent(`yardbell://pair${query}`)}`
}
