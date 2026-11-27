export async function settleWithin(start: () => Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms)
  })
  try {
    await Promise.race([start().catch(() => undefined), timeout])
  } catch (error) {
    console.error('Startup step failed', error)
  } finally {
    clearTimeout(timer)
  }
}
