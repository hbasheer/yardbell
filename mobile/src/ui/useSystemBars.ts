import { NavigationBar } from 'expo-navigation-bar'
import { useEffect } from 'react'
import { Platform } from 'react-native'
import { useColorScheme } from './theme'

export function useSystemBars(): void {
  const scheme = useColorScheme()
  useEffect(() => {
    if (Platform.OS !== 'android') return
    // The value is the button colour, whatever the type docs say.
    NavigationBar.setStyle(scheme === 'dark' ? 'light' : 'dark')
  }, [scheme])
}
