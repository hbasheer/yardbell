import AsyncStorage from '@react-native-async-storage/async-storage'
import { useSyncExternalStore } from 'react'
import { AppState, Appearance, Platform } from 'react-native'
import { applyColorScheme, isAppearancePreference, resolveScheme, type AppearancePreference } from './scheme'

const APPEARANCE_KEY = 'yardbell:appearance'

let preference: AppearancePreference = 'system'
let chosenThisLaunch = false
let started: Promise<void> | null = null
const preferenceListeners = new Set<() => void>()

function applyAppearance(): void {
  if (AppState.currentState === 'background') return
  applyColorScheme(resolveScheme(preference, Appearance.getColorScheme()))
}

function adoptPreference(next: AppearancePreference): void {
  preference = next
  if (Platform.OS !== 'web') Appearance.setColorScheme(next === 'system' ? 'unspecified' : next)
  applyAppearance()
  for (const listener of preferenceListeners) listener()
}

export function startAppearance(): Promise<void> {
  if (started !== null) return started
  applyAppearance()
  Appearance.addChangeListener(applyAppearance)
  AppState.addEventListener('change', (state) => {
    if (state === 'active') applyAppearance()
  })
  started = AsyncStorage.getItem(APPEARANCE_KEY)
    .then((stored) => {
      if (!chosenThisLaunch && isAppearancePreference(stored) && stored !== preference) adoptPreference(stored)
    })
    .catch((error) => console.error('Could not read the saved appearance', error))
  return started
}

export function setAppearancePreference(next: AppearancePreference): Promise<void> {
  chosenThisLaunch = true
  adoptPreference(next)
  return AsyncStorage.setItem(APPEARANCE_KEY, next)
}

function subscribePreference(listener: () => void): () => void {
  preferenceListeners.add(listener)
  return () => {
    preferenceListeners.delete(listener)
  }
}

export function useAppearancePreference(): AppearancePreference {
  return useSyncExternalStore(subscribePreference, () => preference)
}
