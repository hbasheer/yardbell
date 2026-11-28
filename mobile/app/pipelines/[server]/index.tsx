import { useLocalSearchParams } from 'expo-router'
import { PipelinesScreen } from '@/pipelines/PipelinesScreen'
import { RouteServer, routeParam } from '@/places/RouteServer'

export default function PipelinesRoute() {
  const params = useLocalSearchParams<{ server: string }>()
  return <RouteServer id={routeParam(params.server)}>{(server, count) => <PipelinesScreen server={server} multipleServers={count > 1} />}</RouteServer>
}
