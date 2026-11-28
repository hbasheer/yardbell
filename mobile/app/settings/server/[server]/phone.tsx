import { useLocalSearchParams } from 'expo-router'
import { RouteServer, routeParam } from '@/places/RouteServer'
import { PhoneSettingsScreen } from '@/settings/server/PhoneSettingsScreen'

export default function Route() {
  const params = useLocalSearchParams<{ server: string }>()
  return <RouteServer id={routeParam(params.server)}>{(server, count) => <PhoneSettingsScreen server={server} serverCount={count} />}</RouteServer>
}
