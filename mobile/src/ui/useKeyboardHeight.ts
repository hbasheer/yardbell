import { useEffect, useState } from 'react'
import { Keyboard } from 'react-native'

type KeyboardState = { height: number; duration: number }

const CLOSED: KeyboardState = { height: 0, duration: 250 }

export function useKeyboardHeight(): KeyboardState {
  const [state, setState] = useState<KeyboardState>(CLOSED)
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', (event) =>
      setState({ height: Math.max(0, event.endCoordinates.height), duration: event.duration || 250 })
    )
    const hide = Keyboard.addListener('keyboardDidHide', (event) => setState({ height: 0, duration: event.duration || 250 }))
    return () => {
      show.remove()
      hide.remove()
    }
  }, [])
  return state
}
