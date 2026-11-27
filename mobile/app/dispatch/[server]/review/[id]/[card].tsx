import { useLocalSearchParams } from 'expo-router'
import { RouteServer, routeParam } from '@/places/RouteServer'
import { ReviewPanelScreen } from '@/dispatch/review/ReviewPanelScreen'

export default function ReviewPanelRoute() {
  const params = useLocalSearchParams<{ server: string; id: string; card: string; panel: string; file?: string }>()
  return (
    <RouteServer id={routeParam(params.server)}>
      {(server) => (
        <ReviewPanelScreen
          server={server}
          conversation={routeParam(params.id)}
          card={Number(routeParam(params.card))}
          panel={routeParam(params.panel) === 'files' ? 'files' : 'changes'}
          file={routeParam(params.file)}
        />
      )}
    </RouteServer>
  )
}
