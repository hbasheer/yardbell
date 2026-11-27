export const getItem = async (key: string) => window.localStorage.getItem(key)
export const setItem = async (key: string, value: string) => window.localStorage.setItem(key, value)
