import { describe, expect, it } from 'vitest'
import { AttachmentError, MAX_FILES, checkAttachments, kindOf, prepareAttachments, type FileProbe, type PickedFile } from './attachments'

const MB = 1024 * 1024
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const PDF = new TextEncoder().encode('%PDF-1.7\n')
const TEXT = new TextEncoder().encode('hello')

function probe(heads: Record<string, Uint8Array>, reads: string[] = []): FileProbe {
  return {
    async size() {
      throw new Error('size should come from the picker')
    },
    async head(file) {
      reads.push(`head ${file.name}`)
      return heads[file.name]
    },
    async base64(file) {
      reads.push(`full ${file.name}`)
      return 'QQ=='
    }
  }
}

const file = (name: string, size: number): PickedFile => ({ uri: `file:///${name}`, name, size })

async function message(p: Promise<unknown>) {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(AttachmentError)
    return (e as Error).message
  }
  throw new Error('expected a rejection')
}

describe('kindOf', () => {
  it('reads the kind from the first bytes', () => {
    expect(kindOf(PNG)).toBe('png')
    expect(kindOf(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg')
    expect(kindOf(new TextEncoder().encode('GIF89a..'))).toBe('gif')
    expect(kindOf(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('webp')
    expect(kindOf(PDF)).toBe('pdf')
    expect(kindOf(TEXT)).toBe('text')
    expect(kindOf(Uint8Array.from([1, 0, 2]))).toBeNull()
  })
})

describe('checkAttachments', () => {
  it('accepts files at each limit', async () => {
    await checkAttachments(
      [file('a.png', 5 * MB), file('b.pdf', 32 * MB), file('c.txt', 256 * 1024)],
      'claude',
      probe({ 'a.png': PNG, 'b.pdf': PDF, 'c.txt': TEXT })
    )
  })

  it('refuses more than ten files without opening any', async () => {
    const reads: string[] = []
    const many = Array.from({ length: MAX_FILES + 1 }, (_, i) => file(`f${i}.txt`, 1))
    expect(await message(checkAttachments(many, 'claude', probe({}, reads)))).toBe('Attach at most 10 files to one message')
    expect(reads).toEqual([])
  })

  it('names the file and the limit for each kind', async () => {
    expect(await message(checkAttachments([file('big.png', 5 * MB + 1)], 'claude', probe({ 'big.png': PNG })))).toBe('big.png is over 5 MB')
    expect(await message(checkAttachments([file('big.pdf', 32 * MB + 1)], 'claude', probe({ 'big.pdf': PDF })))).toBe('big.pdf is over 32 MB')
    expect(await message(checkAttachments([file('big.txt', 256 * 1024 + 1)], 'claude', probe({ 'big.txt': TEXT })))).toBe('big.txt is over 256 KB')
  })

  it('refuses an empty file and one of an unknown kind', async () => {
    expect(await message(checkAttachments([file('e.txt', 0)], 'claude', probe({})))).toBe('e.txt is empty')
    expect(await message(checkAttachments([file('x.bin', 3)], 'claude', probe({ 'x.bin': Uint8Array.from([1, 0]) })))).toBe(
      'x.bin is not an image, a PDF or a text file'
    )
  })

  it('refuses a PDF on Codex and names it', async () => {
    expect(await message(checkAttachments([file('a.pdf', 10)], 'codex', probe({ 'a.pdf': PDF })))).toBe(
      'Codex cannot read PDFs, so a.pdf cannot be sent in this conversation'
    )
  })

  it('refuses a set over 40 MB together', async () => {
    const files = [file('a.pdf', 25 * MB), file('b.pdf', 16 * MB)]
    expect(await message(checkAttachments(files, 'claude', probe({ 'a.pdf': PDF, 'b.pdf': PDF })))).toBe(
      'These files come to more than 40 MB together'
    )
  })

  it('judges by the bytes, not the name', async () => {
    expect(await message(checkAttachments([file('photo.txt', 300 * 1024)], 'claude', probe({ 'photo.txt': TEXT })))).toBe('photo.txt is over 256 KB')
    await checkAttachments([file('photo.txt', 300 * 1024)], 'claude', probe({ 'photo.txt': PNG }))
  })

  it('asks the file for its size when the picker gave none', async () => {
    const p: FileProbe = { ...probe({ 'a.png': PNG }), size: async () => 6 * MB }
    expect(await message(checkAttachments([{ uri: 'file:///a.png', name: 'a.png' }], 'claude', p))).toBe('a.png is over 5 MB')
  })
})

describe('prepareAttachments', () => {
  it('reads nothing in full when a check fails', async () => {
    const reads: string[] = []
    const files = [file('a.png', 1), file('b.png', 6 * MB)]
    await message(prepareAttachments(files, 'claude', probe({ 'a.png': PNG, 'b.png': PNG }, reads)))
    expect(reads.some((r) => r.startsWith('full'))).toBe(false)
  })

  it('returns the files as base64 in order', async () => {
    const out = await prepareAttachments([file('a.png', 1), file('b.txt', 1)], 'claude', probe({ 'a.png': PNG, 'b.txt': TEXT }))
    expect(out).toEqual([
      { name: 'a.png', data: 'QQ==' },
      { name: 'b.txt', data: 'QQ==' }
    ])
  })
})
