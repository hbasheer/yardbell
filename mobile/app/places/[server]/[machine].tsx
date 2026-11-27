import { useLocalSearchParams, useRouter } from 'expo-router'
import { placeHref, type PlaceDestination } from '@/places/model'
import { PlacePicker } from '@/places/PlacePicker'
import { RouteServer, routeParam } from '@/places/RouteServer'

const DESTINATIONS: Record<string, { title: string; destination: PlaceDestination }> = {
  changes: { title: 'Changes in', destination: 'changes' },
  files: { title: 'Files in', destination: 'files' }
}

export default function PlacesRoute() {
  const params = useLocalSearchParams<{ server: string; machine: string; then?: string }>()
  const router = useRouter()
  const machine = routeParam(params.machine)
  const target = DESTINATIONS[routeParam(params.then)] ?? DESTINATIONS.changes
  return (
    <RouteServer id={routeParam(params.server)}>
      {(server) => (
        <PlacePicker
          server={server}
          machine={machine}
          title={target.title}
          onBack={() => router.back()}
          onPick={(place) => router.replace(placeHref(target.destination, server.id, machine, place.path) as never)}
        />
      )}
    </RouteServer>
  )
}
