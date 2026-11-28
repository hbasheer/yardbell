import { useLocalSearchParams } from 'expo-router'
import { FileDiffScreen } from '@/changes/FileDiffScreen'
import { RouteServer, routeParam } from '@/places/RouteServer'

export default function ChangeDiffRoute() {
  const params = useLocalSearchParams<{ server: string; machine: string; root: string; path: string; staged: string }>()
  return (
    <RouteServer id={routeParam(params.server)}>
      {(server) => (
        <FileDiffScreen
          server={server}
          machine={routeParam(params.machine)}
          root={routeParam(params.root)}
          path={routeParam(params.path)}
          staged={routeParam(params.staged) === '1'}
        />
      )}
    </RouteServer>
  )
}
