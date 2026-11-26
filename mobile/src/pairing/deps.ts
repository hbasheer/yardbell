import { pair, signIn } from '../api/client'
import { saveServer } from '../servers/store'
import { deviceName } from './deviceName'
import type { PairDeps } from './pairFlow'

export const pairDeps: PairDeps = { pair, signIn, saveServer, deviceName }
