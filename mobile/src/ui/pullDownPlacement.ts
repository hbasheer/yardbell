export const MENU_WIDTH = 252
export const ANCHOR_GAP = 6
export const EDGE_INSET = 8

export type PullDownAnchor = { top: number; right: number } | { bottom: number; right: number }

type Rect = { x: number; y: number; width: number; height: number }
type WindowSize = { width: number; height: number }

export function pullDownAnchor(button: Rect, window: WindowSize): PullDownAnchor {
  const right = Math.max(EDGE_INSET, window.width - (button.x + button.width))
  return button.y + button.height / 2 > window.height / 2
    ? { bottom: window.height - button.y + ANCHOR_GAP, right }
    : { top: button.y + button.height + ANCHOR_GAP, right }
}

export function pullDownMaxHeight(anchor: PullDownAnchor, windowHeight: number): number {
  return windowHeight - ('top' in anchor ? anchor.top : anchor.bottom) - EDGE_INSET
}
