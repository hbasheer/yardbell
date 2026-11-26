const NOT_OURS = 'That is not a Yardbell pairing code'

export function normalizeAddress(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) throw new Error('Enter the server address, like 100.64.0.10:4000')
  const withScheme = trimmed.includes('://') ? trimmed : `http://${trimmed}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    throw new Error("That address isn't valid")
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Use an http or https address')
  }
  if (!url.hostname) throw new Error("That address isn't valid")
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Leave the path off, like http://100.64.0.10:4000')
  }
  return `${url.protocol}//${url.host}`
}

export function parsePairingLink(link: string): { address: string; code: string } {
  let url: URL
  try {
    url = new URL(link.trim())
  } catch {
    throw new Error(NOT_OURS)
  }
  if (url.protocol !== 'yardbell:' || url.hostname !== 'pair') throw new Error(NOT_OURS)
  const server = url.searchParams.get('server')
  const code = url.searchParams.get('code')
  if (server === null || code === null) throw new Error(NOT_OURS)
  if (code.length === 0 || code.length > 64 || !/^[A-Za-z0-9]+$/.test(code)) {
    throw new Error(NOT_OURS)
  }
  let address: string
  try {
    address = normalizeAddress(server)
  } catch {
    throw new Error(NOT_OURS)
  }
  return { address, code }
}
