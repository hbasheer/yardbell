import type { PairedServer } from '../servers/store'

export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024
const UPLOAD_TIMEOUT_MS = 120_000

export function uploadPath(machine: string, name: string, file: string): string {
  return `/sessions/${encodeURIComponent(machine)}/${encodeURIComponent(name)}/upload?name=${encodeURIComponent(file)}`
}

export function shellPath(path: string): string {
  return path.replace(/([\\ ])/g, '\\$1')
}

export function uploadFailure(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: unknown }
    if (typeof parsed.error === 'string' && parsed.error) return parsed.error
  } catch {}
  if (status === 401) return 'This phone was signed out, pair it again'
  return `The server refused the file (${status})`
}

export type UploadResult = { path: string }

export async function uploadFile(
  server: PairedServer,
  machine: string,
  name: string,
  file: { uri: string; name: string; size?: number },
  onProgress: (fraction: number) => void
): Promise<UploadResult> {
  if (file.size === 0) throw new Error('The file is empty')
  if (file.size !== undefined && file.size > UPLOAD_MAX_BYTES) {
    throw new Error(`The file is over ${UPLOAD_MAX_BYTES / 1024 / 1024} MB`)
  }
  const blob = await (await fetch(file.uri)).blob()
  if (blob.size === 0) throw new Error('The file is empty')
  if (blob.size > UPLOAD_MAX_BYTES) throw new Error(`The file is over ${UPLOAD_MAX_BYTES / 1024 / 1024} MB`)

  return new Promise<UploadResult>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${server.address}${uploadPath(machine, name, file.name)}`)
    xhr.timeout = UPLOAD_TIMEOUT_MS
    xhr.setRequestHeader('Authorization', `Bearer ${server.token}`)
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    xhr.setRequestHeader('Accept', 'application/json')
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total)
    }
    xhr.onload = () => {
      let path: unknown
      try {
        path = (JSON.parse(xhr.responseText) as { path?: unknown }).path
      } catch {}
      if (xhr.status >= 200 && xhr.status < 300 && typeof path === 'string' && path) resolve({ path })
      else reject(new Error(uploadFailure(xhr.status, xhr.responseText)))
    }
    xhr.onerror = () => reject(new Error(`Can't reach ${server.address}. Is Meshnet on?`))
    xhr.ontimeout = () => reject(new Error('The upload took too long'))
    xhr.send(blob)
  })
}
