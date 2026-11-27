const query = new URLSearchParams(window.location.search)

if (query.has('preview')) {
  const host = window.location.hostname
  const server = (port: number, machine: string) => ({
    id: `http://${host}:${port}`,
    address: `http://${host}:${port}`,
    token: 'ybd_preview',
    machine,
    deviceId: String(port)
  })
  const servers = [server(4210, 'hp'), server(4211, 'mac-mini')]
  if (query.get('preview') === 'unreachable') servers.push(server(4219, 'laptop'))
  if (query.get('preview') === 'none') servers.length = 0
  window.localStorage.setItem('servers', JSON.stringify(servers))
}

const scheme = query.get('scheme')
if (scheme === 'light' || scheme === 'dark') window.localStorage.setItem('yardbell:appearance', scheme)
