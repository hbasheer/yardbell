import { useLocalSearchParams } from 'expo-router'
import { PipelineScreen } from '@/pipelines/PipelineScreen'
import { RouteServer, routeParam } from '@/places/RouteServer'

export default function PipelineRoute() {
  const params = useLocalSearchParams<{ server: string; id: string }>()
  return (
    <RouteServer id={routeParam(params.server)}>
      {(server, count) => <PipelineScreen key={routeParam(params.id)} server={server} id={routeParam(params.id)} multipleServers={count > 1} />}
    </RouteServer>
  )
}
