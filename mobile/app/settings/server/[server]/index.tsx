import { useLocalSearchParams } from 'expo-router'
import { RouteServer, routeParam } from '@/places/RouteServer'
import { ServerSettingsScreen } from '@/settings/server/ServerSettingsScreen'

export default function Route() {
  const params = useLocalSearchParams<{ server: string }>()
  return <RouteServer id={routeParam(params.server)}>{(server, count) => <ServerSettingsScreen server={server} serverCount={count} />}</RouteServer>
}
