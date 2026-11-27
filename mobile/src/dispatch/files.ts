import { File } from 'expo-file-system'
import type { FileProbe } from './attachments'

export const deviceFiles: FileProbe = {
  async size(file) {
    return new File(file.uri).size
  },
  async head(file, length) {
    const handle = new File(file.uri).open()
    try {
      return await handle.readBytes(length)
    } finally {
      handle.close()
    }
  },
  base64(file) {
    return new File(file.uri).base64()
  }
}
