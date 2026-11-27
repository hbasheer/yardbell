import { ApiClient } from '../api/client'
import type { PairedServer } from '../servers/store'
import type { ActionEvent, Decision } from '../dispatch/types'

export type Proposal = ActionEvent & { by: 'client'; from?: string }

export type ProposalList = { proposals: Proposal[]; waiting: number }

const client = (server: PairedServer) => new ApiClient(server)
const proposalPath = (id: string) => `/api/proposals/${encodeURIComponent(id)}`

export function listProposals(server: PairedServer, opened = false): Promise<ProposalList> {
  return client(server).get(`/api/proposals${opened ? '?opened=1' : ''}`)
}

export function getProposal(server: PairedServer, id: string): Promise<Proposal> {
  return client(server).get(proposalPath(id))
}

export function decideProposal(
  server: PairedServer,
  id: string,
  decision: Decision,
  input?: Record<string, unknown>
): Promise<Proposal> {
  return client(server).post(proposalPath(id), input === undefined ? { decision } : { decision, input })
}

export function deleteProposal(server: PairedServer, id: string): Promise<{ deleted: string }> {
  return client(server).delete(proposalPath(id))
}

export function clearDecided(server: PairedServer): Promise<{ cleared: number }> {
  return client(server).post('/api/proposals/clear', {})
}
