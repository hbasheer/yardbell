import { useLocalSearchParams } from 'expo-router'
import { RunScreen } from '@/pipelines/RunScreen'
import { RouteServer, routeParam } from '@/places/RouteServer'

export default function RunRoute() {
  const params = useLocalSearchParams<{ server: string; id: string; p?: string }>()
  const id = routeParam(params.id)
  return (
    <RouteServer id={routeParam(params.server)}>
      {(server, count) => <RunScreen key={id} server={server} runId={id} pipelineHint={routeParam(params.p)} multipleServers={count > 1} />}
    </RouteServer>
  )
}
