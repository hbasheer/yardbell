import { expect, test } from 'vitest'
import { shellPath, uploadFailure, uploadPath } from './upload'

test('upload path encodes machine, session and file', () => {
  expect(uploadPath('my box', 'x/y', 'a b.png')).toBe('/sessions/my%20box/x%2Fy/upload?name=a%20b.png')
})

test('shellPath escapes spaces and backslashes', () => {
  expect(shellPath('/tmp/yardbell-uploads/s/my shot.png')).toBe('/tmp/yardbell-uploads/s/my\\ shot.png')
})

test('failures prefer the server message', () => {
  expect(uploadFailure(415, '{"error":"only images, PDFs and text files can be attached"}')).toBe(
    'only images, PDFs and text files can be attached'
  )
  expect(uploadFailure(502, 'bad gateway')).toBe('The server refused the file (502)')
  expect(uploadFailure(401, '')).toContain('signed out')
})
