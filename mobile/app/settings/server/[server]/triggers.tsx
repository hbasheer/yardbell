import { useLocalSearchParams } from 'expo-router'
import { RouteServer, routeParam } from '@/places/RouteServer'
import { TriggersScreen } from '@/settings/server/TriggersScreen'

export default function Route() {
  const params = useLocalSearchParams<{ server: string }>()
  return <RouteServer id={routeParam(params.server)}>{(server, count) => <TriggersScreen server={server} serverCount={count} />}</RouteServer>
}
