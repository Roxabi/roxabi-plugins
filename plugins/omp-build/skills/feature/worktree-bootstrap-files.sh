refuse_example() {
  case "$1" in
    *.example | *.example/*) return 0 ;;
  esac
  return 1
}

path_stays_here() {
  local rel="$1" acc="$here" part probe canon captured
  case "$rel" in
    /* | .. | ../* | */.. | */../*) return 1 ;;
  esac
  local IFS=/
  for part in $rel; do
    [ -n "$part" ] || continue
    [ "$part" = "." ] || [ "$part" = ".." ] && return 1
    acc="$acc/$part"
    [ -L "$acc" ] && return 1
  done
  probe="$here/$rel"
  while [ ! -e "$probe" ] && [ "$probe" != "$here" ]; do
    captured="$(dirname -- "$probe" && printf '.')" || return 1
    probe="${captured%$'\n.'}"
  done
  captured="$(realpath -- "$probe" && printf '.')" || return 1
  canon="${captured%$'\n.'}"
  case "$canon" in
    "$here" | "$here"/*) return 0 ;;
  esac
  return 1
}

copy_from_principal() {
  local rel="$1" src dest parent
  refuse_example "$rel" && return 0
  src="$principal/$rel"
  [ -e "$src" ] || return 0
  if ! path_stays_here "$rel"; then
    echo "bootstrap=refused symlink $rel" >&2
    exit 2
  fi
  dest="$here/$rel"
  [ -e "$dest" ] || [ -L "$dest" ] && return 0
  parent="$(dirname -- "$dest" && printf '.')" || return 1
  parent="${parent%$'\n.'}"
  mkdir -p "$parent"
  cp -a "$src" "$dest"
}
