import { useLocalSearchParams } from 'expo-router'
import { RouteServer, routeParam } from '@/places/RouteServer'
import { MemoryScreen } from '@/settings/server/MemoryScreen'

export default function Route() {
  const params = useLocalSearchParams<{ server: string }>()
  return <RouteServer id={routeParam(params.server)}>{(server, count) => <MemoryScreen server={server} serverCount={count} />}</RouteServer>
}
