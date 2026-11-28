import { useLocalSearchParams } from 'expo-router'
import { FilesScreen } from '@/files/FilesScreen'
import { RouteServer, routeParam } from '@/places/RouteServer'

export default function FilesRoute() {
  const params = useLocalSearchParams<{ server: string; machine: string; root: string }>()
  return (
    <RouteServer id={routeParam(params.server)}>
      {(server, count) => <FilesScreen server={server} machine={routeParam(params.machine)} root={routeParam(params.root)} multipleServers={count > 1} />}
    </RouteServer>
  )
}
