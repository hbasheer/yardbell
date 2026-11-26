export function versionCode(version: string): number {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!match) throw new Error(`Expected a version like 1.2.3, got "${version}"`)
  const [major, minor, patch] = match.slice(1).map(Number)
  return major * 1_000_000 + minor * 1_000 + patch
}
