import { useLocalSearchParams } from 'expo-router'
import { FileViewScreen } from '@/files/FileViewScreen'
import { parseLine } from '@/files/model'
import { RouteServer, routeParam } from '@/places/RouteServer'

export default function FileRoute() {
  const params = useLocalSearchParams<{ server: string; machine: string; root: string; path: string; line?: string; find?: string }>()
  return (
    <RouteServer id={routeParam(params.server)}>
      {(server, count) => (
        <FileViewScreen
          server={server}
          machine={routeParam(params.machine)}
          root={routeParam(params.root)}
          path={routeParam(params.path)}
          line={parseLine(routeParam(params.line))}
          find={routeParam(params.find)}
          multipleServers={count > 1}
        />
      )}
    </RouteServer>
  )
}
