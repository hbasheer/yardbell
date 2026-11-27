import type { AgentView } from '../state/types'

export const short = (path: string) => path.replace(/^\/(home|Users)\/[^/]+(?=\/|$)/, '~')

export const agentLabel = (agents: AgentView[] | undefined, name: string) =>
  agents?.find((a) => a.name === name)?.label || name

type Target = { folder: string; machine: string; agent: string; activity: string }

const interruption = (target: Target) =>
  target.activity === 'active' ? 'It is working right now and will be interrupted. ' : ''

export function moveCopy(target: Target, agents: AgentView[] | undefined) {
  return {
    title: `Move ${short(target.folder)} on ${target.machine} into tmux?`,
    message: `${interruption(target)}Yardbell stops ${agentLabel(agents, target.agent)} and starts it again in tmux with its last conversation. The terminal it runs in now gets its prompt back.`,
    confirm: 'Move to tmux'
  }
}

export function stopCopy(target: Target, agents: AgentView[] | undefined) {
  return {
    title: `Stop ${agentLabel(agents, target.agent)} in ${short(target.folder)} on ${target.machine}?`,
    message: `${interruption(target)}The agent ends and the terminal it runs in gets its prompt back. Its conversation is kept, so Resume can continue it.`,
    confirm: 'Stop'
  }
}

export const LOOSE_NOTE =
  'Yardbell can only open sessions that run in tmux. Move one to stop its agent and start it again in tmux with the same conversation, or start agents inside tmux from now on.'

export const staleNote = (machine: string) =>
  `What ran on ${machine} when Yardbell last reached it. They may still be running; they open again once it reconnects.`
