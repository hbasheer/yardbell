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

# Screen text as a JSON string body: tabs become spaces, other control characters go, and lines
# are joined with a literal \n.
json_text() {
  tr '\t' ' ' | tr -d '\000-\010\013-\037\177' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' |
    awk 'BEGIN { ORS = "" } { if (NR > 1) print "\\n"; print }'
}

# A Docker that stopped answering (out of memory, a stuck VM) would hold up the whole check and
# mark the machine down, so its port list gets 3 seconds: the watchdog ends docker, and read -t
# below stops waiting even if something else still holds the pipe. macOS has no timeout(1).
docker_ps() {
  docker ps --format '{{.Label "dev.yardbell.workdir"}}|{{.Label "com.docker.compose.project.working_dir"}}|{{.Label "com.docker.compose.service"}}|{{.Ports}}' 2>/dev/null &
  local pid=$!
  (sleep 3; kill "$pid") >/dev/null 2>&1 &
  local watchdog=$!
  wait "$pid" 2>/dev/null
  kill "$watchdog" 2>/dev/null
}

panes=""
if has tmux; then
  panes=$(tmux list-panes -a -F '#{session_name} #{pane_tty} #{pane_id}' 2>/dev/null || true)
fi

# On a machine shared with other people, their agents are not ours to show, and lsof reports
# their unreadable cwd as an error string that would pass for a folder.
uid=$(id -u)
candidates=""
all_pids=" "
for spec in ${agents[@]+"${agents[@]}"}; do
  agent=${spec%%=*}
  proc=${spec#*=}
  pids=$(pgrep -u "$uid" -x "$proc" 2>/dev/null || true)
  [ -z "$pids" ] && pids=$(pgrep -u "$uid" -f "(^|/)$proc( |\$)" 2>/dev/null || true)
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
  pane=""
  if [ -n "$tty" ] && [ "$tty" != "?" ] && [ -n "$panes" ]; then
    read -r session pane <<EOF_PANE
$(printf '%s\n' "$panes" | awk -v t="$tty" '{ n = split($2, p, "/"); if (p[n] == t || $2 == t || $2 == "/dev/" t) { print $1, $3; exit } }')
EOF_PANE
  fi
  [ $first -eq 0 ] && printf ','
  first=0
  printf '{"agent":%s,"pid":%s,"cwd":%s,"cpu":%s,"tmux":' "$(esc "$agent")" "$pid" "$(esc "$cwd")" "${cpu:-0}"
  if [ -n "$session" ]; then esc "$session"; else printf 'null'; fi
  if [ -n "$pane" ]; then
    printf ',"title":"%s","screen":"%s"' \
      "$(tmux display -p -t "$pane" '#{pane_title}' 2>/dev/null | json_text)" \
      "$(tmux capture-pane -p -t "$pane" 2>/dev/null | json_text)"
  fi
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
  # A compose file kept outside the checkout labels every container with its own folder, so a
  # dev.yardbell.workdir label names the checkout instead.
  while IFS='|' read -r -t 3 label workdir service ports; do
    case "$services" in *" $service "*) ;; *) continue ;; esac
    workdir=${label:-$workdir}
    seen=" "
    for binding in $(printf '%s\n' "$ports" | grep -oE '(\[[0-9a-fA-F:]*\]|[0-9.]+):[0-9]+->' | tr -d '>-'); do
      hp=${binding##*:}
      case "$seen" in *" $hp "*) continue ;; esac
      seen="$seen$hp "
      addr=${binding%:*}
      case "$addr" in 0.0.0.0 | 127.0.0.1 | \[*) addr="" ;; esac
      [ $first -eq 0 ] && printf ','
      first=0
      listening=false
      (echo >"/dev/tcp/${addr:-127.0.0.1}/$hp") 2>/dev/null && listening=true
      host=""
      [ -n "$addr" ] && host=",\"host\":$(esc "$addr")"
      printf '{"workdir":%s,"service":%s,"host_port":%s,"listening":%s%s}' "$(esc "$workdir")" "$(esc "$service")" "$hp" "$listening" "$host"
    done
  done < <(docker_ps)
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
  # On a shared server each account can have a cgroup memory limit, which runs out before the
  # machine's RAM does, so it is reported beside the machine's figures. As in MemAvailable, page
  # cache (active too, it is reclaimed under the limit) and reclaimable slab are not counted as
  # used. tmpfs is in "file" but cannot be dropped.
  cg_path=$(sed -n 's/^0:://p' /proc/self/cgroup 2>/dev/null)
  cg_dir="/sys/fs/cgroup${cg_path%/}"
  cg_limit=""
  cg_limit_dir=""
  while [ -n "$cg_path" ] && [ -d "$cg_dir" ]; do
    max=$(cat "$cg_dir/memory.max" 2>/dev/null || true)
    case "$max" in
      '' | max) ;;
      *) if [ -z "$cg_limit" ] || [ "$max" -lt "$cg_limit" ]; then cg_limit=$max; cg_limit_dir=$cg_dir; fi ;;
    esac
    [ "$cg_dir" = /sys/fs/cgroup ] && break
    cg_dir=${cg_dir%/*}
  done
  if [ -n "$cg_limit" ] && [ -n "$mem_total" ] && [ $((cg_limit / 1024)) -lt "$mem_total" ]; then
    current=$(cat "$cg_limit_dir/memory.current" 2>/dev/null || true)
    reclaimable=$(awk '$1 == "file" || $1 == "slab_reclaimable" {n += $2} $1 == "shmem" {n -= $2} END {print n + 0}' "$cg_limit_dir/memory.stat" 2>/dev/null)
    if [ -n "$current" ]; then
      limit_kb=$((cg_limit / 1024))
      limit_used_kb=$(((current - ${reclaimable:-0}) / 1024))
    fi
  fi
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
disk_total=0
disk_used=0
disk=$(df -Pk "$root" 2>/dev/null || df -Pk "$HOME" 2>/dev/null)
if [ -n "$disk" ]; then
  disk_total=$(printf '%s\n' "$disk" | awk 'NR == 2 {print $2 + 0}')
  disk_used=$(printf '%s\n' "$disk" | awk 'NR == 2 {print $2 - $4}')
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
me=$(id -u)
me_name=$(id -nu)
# The people's accounts on the machine (not the system's), by the memory of their processes.
# Rootless containers run as uids from their owner's range in /etc/subuid, so they count as the
# owner's, and as yours when the owner is you.
uid_min=1000
[ "$(uname -s)" = Darwin ] && uid_min=501
login_min=$(awk '$1 == "UID_MIN" {print $2}' /etc/login.defs 2>/dev/null)
[ -n "$login_min" ] && uid_min=$login_min
owners=$(ps -A -o uid=,rss= 2>/dev/null |
  awk -v min="$uid_min" '$1 >= min {kb[$1] += $2} END {for (u in kb) print u, kb[u]}' |
  while read -r uid kb; do
    if name=$(id -nu "$uid" 2>/dev/null); then
      printf '%s\t%s\t0\n' "$name" "$kb"
    else
      owner=$(awk -F: -v u="$uid" '$2 <= u && u < $2 + $3 {print $1; exit}' /etc/subuid 2>/dev/null)
      if [ -n "$owner" ]; then
        printf '%s\t%s\t%s\n' "$owner" "$kb" "$kb"
      else
        printf 'uid %s\t%s\t0\n' "$uid" "$kb"
      fi
    fi
  done |
  awk -F'\t' '{kb[$1] += $2; c[$1] += $3} END {for (n in kb) printf "%s\t%s\t%s\n", kb[n], c[n], n}' |
  sort -rn)
user_kb=$(printf '%s\n' "$owners" | awk -F'\t' -v me="$me_name" '$3 == me {print $1}')
[ -n "$user_kb" ] || user_kb=$(ps -o rss= -U "$me" 2>/dev/null | awk '{n += $1} END {print n + 0}')
printf ',"accounts":['
printf '%s\n' "$owners" | head -8 | {
  first=1
  while IFS=$'\t' read -r kb containers name; do
    [ -n "$name" ] || continue
    you=false
    [ "$name" = "$me_name" ] && you=true
    [ $first -eq 0 ] && printf ','
    first=0
    printf '{"name":%s,"kb":%s,"containers_kb":%s,"you":%s}' "$(esc "$name")" "$kb" "$containers" "$you"
  done
}
printf ']'
if [ -n "$mem_total" ] && [ -n "$mem_used" ]; then
  printf ',"health":{"mem_total_kb":%s,"mem_used_kb":%s,"agent_kb":%s,"user_kb":%s,"limit_kb":%s,"limit_used_kb":%s,"load1":%s,"cpus":%s,"disk_total_kb":%s,"disk_used_kb":%s}' \
    "$mem_total" "$mem_used" "$agent_kb" "${user_kb:-0}" "${limit_kb:-0}" "${limit_used_kb:-0}" "${load1:-0}" "${cpus:-0}" "${disk_total:-0}" "${disk_used:-0}"
fi
printf '}\n'
