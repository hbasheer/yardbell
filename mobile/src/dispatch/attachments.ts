import type { AskAttachment, AttachmentKind, Backend } from './types'

export const MAX_FILES = 10
export const MAX_TOTAL = 40 * 1024 * 1024
export const HEAD_BYTES = 4096

const LIMITS: Record<'image' | 'pdf' | 'text', { bytes: number; words: string }> = {
  image: { bytes: 5 * 1024 * 1024, words: '5 MB' },
  pdf: { bytes: 32 * 1024 * 1024, words: '32 MB' },
  text: { bytes: 256 * 1024, words: '256 KB' }
}

export type PickedFile = { uri: string; name: string; size?: number | null }

export type FileProbe = {
  size(file: PickedFile): Promise<number>
  head(file: PickedFile, length: number): Promise<Uint8Array>
  base64(file: PickedFile): Promise<string>
}

const startsWith = (bytes: Uint8Array, text: string, at = 0) =>
  bytes.length >= at + text.length && [...text].every((c, i) => bytes[at + i] === c.charCodeAt(0))

export function kindOf(head: Uint8Array): AttachmentKind | null {
  if (head.length >= 8 && head[0] === 0x89 && startsWith(head, 'PNG\r\n\x1a\n', 1)) return 'png'
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg'
  if (startsWith(head, 'GIF87a') || startsWith(head, 'GIF89a')) return 'gif'
  if (startsWith(head, 'RIFF') && startsWith(head, 'WEBP', 8)) return 'webp'
  if (startsWith(head, '%PDF-')) return 'pdf'
  if (!head.includes(0)) return 'text'
  return null
}

const groupOf = (kind: AttachmentKind) => (kind === 'pdf' ? 'pdf' : kind === 'text' ? 'text' : 'image')

export class AttachmentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AttachmentError'
  }
}

export async function checkAttachments(
  files: PickedFile[],
  backend: Backend | undefined,
  probe: Pick<FileProbe, 'size' | 'head'>
): Promise<void> {
  if (files.length > MAX_FILES) throw new AttachmentError(`Attach at most ${MAX_FILES} files to one message`)
  let total = 0
  for (const file of files) {
    const size = file.size ?? (await probe.size(file))
    if (size === 0) throw new AttachmentError(`${file.name} is empty`)
    const head = await probe.head(file, HEAD_BYTES)
    const kind = kindOf(head)
    if (!kind) throw new AttachmentError(`${file.name} is not an image, a PDF or a text file`)
    if (kind === 'pdf' && backend === 'codex') {
      throw new AttachmentError(`Codex cannot read PDFs, so ${file.name} cannot be sent in this conversation`)
    }
    const limit = LIMITS[groupOf(kind)]
    if (size > limit.bytes) throw new AttachmentError(`${file.name} is over ${limit.words}`)
    total += size
    if (total > MAX_TOTAL) throw new AttachmentError('These files come to more than 40 MB together')
  }
}

export async function prepareAttachments(
  files: PickedFile[],
  backend: Backend | undefined,
  probe: FileProbe
): Promise<AskAttachment[]> {
  await checkAttachments(files, backend, probe)
  const out: AskAttachment[] = []
  for (const file of files) out.push({ name: file.name, data: await probe.base64(file) })
  return out
}
