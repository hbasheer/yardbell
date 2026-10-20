#!/usr/bin/env bash
set -u
export LC_ALL=C
root="${1:?root}"
shift
case "$root" in
  "~") root="$HOME" ;;
  "~/"*) root="$HOME/${root#\~/}" ;;
esac
workspaces=()
while [ $# -gt 0 ] && [ "$1" != "--" ]; do workspaces+=("$1"); shift; done
[ $# -gt 0 ] && shift
services=" "
while [ $# -gt 0 ] && [ "$1" != "--" ]; do services="$services$1 "; shift; done
[ $# -gt 0 ] && shift
agents=("$@")

esc() {
  local s=${1//\\/\\\\}
  s=${s//\"/\\\"}
  printf '"%s"' "$s"
}

has() { command -v "$1" >/dev/null 2>&1; }

panes=""
if has tmux; then
  panes=$(tmux list-panes -a -F '#{session_name} #{pane_tty}' 2>/dev/null || true)
fi

candidates=""
all_pids=" "
for spec in ${agents[@]+"${agents[@]}"}; do
  agent=${spec%%=*}
  proc=${spec#*=}
  pids=$(pgrep -x "$proc" 2>/dev/null || true)
  [ -z "$pids" ] && pids=$(pgrep -f "(^|/)$proc( |\$)" 2>/dev/null || true)
  for pid in $pids; do
    [ "$pid" = "$$" ] && continue
    case "$all_pids" in *" $pid "*) continue ;; esac
    all_pids="$all_pids$pid "
    candidates="$candidates$agent $pid
"
  done
done

started_by_agent() {
  local p i=0
  p=$(ps -o ppid= -p "$1" 2>/dev/null | tr -d ' ')
  while [ -n "$p" ] && [ "$p" -gt 1 ] && [ $i -lt 30 ]; do
    case "$all_pids" in *" $p "*) return 0 ;; esac
    p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')
    i=$((i + 1))
  done
  return 1
}

printf '{"root":%s,"agents":[' "$(esc "$root")"
first=1
agent_kb=0
cwds=""
while read -r agent pid; do
  [ -z "$pid" ] && continue
  rss=$(ps -o rss= -p "$pid" 2>/dev/null | tr -d ' ')
  agent_kb=$((agent_kb + ${rss:-0}))
  started_by_agent "$pid" && continue
  if [ -e "/proc/$pid/cwd" ]; then
    cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null || true)
  else
    cwd=$(lsof -a -d cwd -p "$pid" -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)
  fi
  [ -z "$cwd" ] && continue
  cwds="$cwds
$cwd"
  cpu=$(ps -o %cpu= -p "$pid" 2>/dev/null | tr -d ' ')
  tty=$(ps -o tty= -p "$pid" 2>/dev/null | tr -d ' ')
  session=""
  if [ -n "$tty" ] && [ "$tty" != "?" ] && [ -n "$panes" ]; then
    session=$(printf '%s\n' "$panes" | awk -v t="$tty" '{ n = split($2, p, "/"); if (p[n] == t || $2 == t || $2 == "/dev/" t) { print $1; exit } }')
  fi
  [ $first -eq 0 ] && printf ','
  first=0
  printf '{"agent":%s,"pid":%s,"cwd":%s,"cpu":%s,"tmux":' "$(esc "$agent")" "$pid" "$(esc "$cwd")" "${cpu:-0}"
  if [ -n "$session" ]; then esc "$session"; else printf 'null'; fi
  printf '}'
done <<EOF_AGENTS
$candidates
EOF_AGENTS

printf '],"tmux":['
first=1
if has tmux; then
  while IFS='|' read -r name attached; do
    [ -z "$name" ] && continue
    [ $first -eq 0 ] && printf ','
    first=0
    flag=false
    [ "$attached" != "0" ] && flag=true
    printf '{"name":%s,"attached":%s}' "$(esc "$name")" "$flag"
  done < <(tmux list-sessions -F '#{session_name}|#{session_attached}' 2>/dev/null)
fi

printf '],"folders":['
first=1
seen="|"
emit_folder() {
  case "$seen" in *"|$1|"*) return ;; esac
  seen="$seen$1|"
  [ $first -eq 0 ] && printf ','
  first=0
  printf '{"path":%s,"branch":%s}' "$(esc "$1")" "$(esc "$(git -C "$1" branch --show-current 2>/dev/null)")"
}
if has git; then
  for ws in ${workspaces[@]+"${workspaces[@]}"}; do
    for dir in "$root"/$ws; do
      [ -e "$dir/.git" ] || continue
      emit_folder "$dir"
    done
  done
  while IFS= read -r cwd; do
    [ -z "$cwd" ] && continue
    top=$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null)
    [ -n "$top" ] && emit_folder "$top"
  done <<EOF_CWDS
$cwds
EOF_CWDS
fi

printf '],"ports":['
first=1
if has docker; then
  while IFS='|' read -r workdir service ports; do
    case "$services" in *" $service "*) ;; *) continue ;; esac
    for hp in $(printf '%s\n' "$ports" | grep -oE ':[0-9]+->' | tr -d ':>-' | sort -un); do
      [ $first -eq 0 ] && printf ','
      first=0
      listening=false
      (echo >"/dev/tcp/127.0.0.1/$hp") 2>/dev/null && listening=true
      printf '{"workdir":%s,"service":%s,"host_port":%s,"listening":%s}' "$(esc "$workdir")" "$(esc "$service")" "$hp" "$listening"
    done
  done < <(docker ps --format '{{.Label "com.docker.compose.project.working_dir"}}|{{.Label "com.docker.compose.service"}}|{{.Ports}}' 2>/dev/null)
fi
printf ']'

mem_total=""
mem_used=""
load1=0
cpus=0
if [ -r /proc/meminfo ]; then
  mem_total=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)
  avail=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)
  [ -n "$mem_total" ] && [ -n "$avail" ] && mem_used=$((mem_total - avail))
  load1=$(cut -d' ' -f1 /proc/loadavg 2>/dev/null)
  cpus=$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 0)
elif command -v vm_stat >/dev/null 2>&1; then
  bytes=$(sysctl -n hw.memsize 2>/dev/null)
  page=$(sysctl -n hw.pagesize 2>/dev/null)
  [ -n "$bytes" ] && mem_total=$((bytes / 1024))
  pages=$(vm_stat 2>/dev/null | awk -F: '/Pages active|Pages wired down|Pages occupied by compressor/ {gsub(/[^0-9]/, "", $2); n += $2} END {print n + 0}')
  [ -n "$page" ] && mem_used=$((pages * page / 1024))
  load1=$(sysctl -n vm.loadavg 2>/dev/null | awk '{print $2}')
  cpus=$(sysctl -n hw.ncpu 2>/dev/null || echo 0)
fi
if command -v ip >/dev/null 2>&1; then
  addrs=$(ip -o -4 addr show 2>/dev/null | awk '{print $4}' | cut -d/ -f1)
else
  addrs=$(ifconfig 2>/dev/null | awk '/inet / {print $2}')
fi
printf ',"mesh_ips":['
first=1
for a in $(printf '%s\n' "$addrs" | awk -F. '$1 == 100 && $2 >= 64 && $2 <= 127'); do
  [ $first -eq 0 ] && printf ','
  first=0
  printf '"%s"' "$a"
done
printf ']'
if [ -n "$mem_total" ] && [ -n "$mem_used" ]; then
  printf ',"health":{"mem_total_kb":%s,"mem_used_kb":%s,"agent_kb":%s,"load1":%s,"cpus":%s}' \
    "$mem_total" "$mem_used" "$agent_kb" "${load1:-0}" "${cpus:-0}"
fi
printf '}\n'
