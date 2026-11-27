import { useLocalSearchParams } from 'expo-router'
import { ChangesScreen } from '@/changes/ChangesScreen'
import { RouteServer, routeParam } from '@/places/RouteServer'

export default function ChangesRoute() {
  const params = useLocalSearchParams<{ server: string; machine: string; root: string }>()
  return (
    <RouteServer id={routeParam(params.server)}>
      {(server, count) => (
        <ChangesScreen server={server} machine={routeParam(params.machine)} root={routeParam(params.root)} multipleServers={count > 1} />
      )}
    </RouteServer>
  )
}
