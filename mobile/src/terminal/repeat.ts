export const REPEAT_DELAY_MS = 400
export const REPEAT_INTERVAL_MS = 45

export function createRepeater(fire: () => void) {
  let delay: ReturnType<typeof setTimeout> | undefined
  let every: ReturnType<typeof setInterval> | undefined
  let repeated = false

  const stop = () => {
    clearTimeout(delay)
    clearInterval(every)
    delay = undefined
    every = undefined
  }

  return {
    pressIn() {
      stop()
      repeated = false
      delay = setTimeout(() => {
        repeated = true
        fire()
        every = setInterval(fire, REPEAT_INTERVAL_MS)
      }, REPEAT_DELAY_MS)
    },
    pressOut: stop,
    press() {
      if (!repeated) fire()
      repeated = false
    }
  }
}
