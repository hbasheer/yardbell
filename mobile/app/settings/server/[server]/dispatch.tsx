import { useLocalSearchParams } from 'expo-router'
import { RouteServer, routeParam } from '@/places/RouteServer'
import { DispatchSettingsScreen } from '@/settings/server/DispatchSettingsScreen'

export default function Route() {
  const params = useLocalSearchParams<{ server: string }>()
  return <RouteServer id={routeParam(params.server)}>{(server, count) => <DispatchSettingsScreen server={server} serverCount={count} />}</RouteServer>
}
