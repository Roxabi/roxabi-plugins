# Parsed worktree fields; caller owns location, lock, marker, transfer and setup ordering.
read_bootstrap_stack() {
  local stack="$1"
  copy_values=()
  seed_values=()
  setup_mode="none"
  setup_value=""
  [ -f "$stack" ] || return 0
  if [ -f "$stack" ]; then
    need_cli bun bun
    fields=()
    while IFS= read -r -d '' field; do
      fields+=("$field")
    done < <(
      if cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && bun --no-env-file -e '
        import { readFileSync } from "node:fs"
  
        const path = process.argv[1]
        const invalid = (message) => {
          throw new Error(message)
        }
        const isMap = (value) => value == null || (typeof value === "object" && !Array.isArray(value))
        const list = (value, name) => {
          if (value == null) return []
          if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
            invalid(`${name} must be a list of strings or null`)
          if (value.some((item) => item.includes("\0"))) invalid(`${name} must not contain NUL`)
          return value
        }
        const record = (key, value) => process.stdout.write(`${key}\0${value}\0`)
  
        try {
          const config = Bun.YAML.parse(readFileSync(path, "utf8"))
          if (!isMap(config)) invalid("document must be a map or null")
          const worktree = config?.worktree
          const commands = config?.commands
          if (!isMap(worktree)) invalid("worktree must be a map or null")
          const copy = list(worktree?.copy, "worktree.copy")
          const seed = list(worktree?.seed, "worktree.seed")
          const setup = typeof worktree?.setup === "string" && worktree.setup.trim()
            ? ["snippet", worktree.setup]
            : typeof commands?.worktree_setup === "string" && commands.worktree_setup.trim()
              ? ["file", commands.worktree_setup]
              : ["none", ""]
          if (setup[1].includes("\0")) invalid("selected setup must not contain NUL")
          for (const value of copy.length ? copy : [""]) record("copy", value)
          for (const value of seed.length ? seed : [""]) record("seed", value)
          record("setup_mode", setup[0])
          record("setup", setup[1])
        } catch (error) {
          console.error(`${path}: ${error instanceof Error ? error.message : String(error)}`)
          process.exit(1)
        }
      ' "$stack"; then
        printf 'status\0%s\0' 0
      else
        status=$?
        printf 'status\0%s\0' "$status"
      fi
    )
    if [ $(( ${#fields[@]} % 2 )) -ne 0 ] || [ "${#fields[@]}" -lt 2 ]; then
      echo "bootstrap=stack-invalid $stack" >&2
      exit 1
    fi
    status_index=$((${#fields[@]} - 2))
    if [ "${fields[$status_index]}" != "status" ] || ! [[ "${fields[$((status_index + 1))]}" =~ ^[0-9]+$ ]]; then
      echo "bootstrap=stack-invalid $stack" >&2
      exit 1
    fi
    if [ "${fields[$((status_index + 1))]}" -ne 0 ]; then
      echo "bootstrap=stack-invalid $stack" >&2
      exit "${fields[$((status_index + 1))]}"
    fi
    if [ "${#fields[@]}" -lt 10 ]; then
      echo "bootstrap=stack-invalid $stack" >&2
      exit 1
    fi
  
    copy_values=()
    seed_values=()
    setup_mode=""
    setup_value=""
    phase=copy
    index=0
    while [ "$index" -lt "$status_index" ]; do
      key="${fields[$index]}"
      value="${fields[$((index + 1))]}"
      case "$key:$phase" in
        copy:copy)
          copy_values+=("$value")
          ;;
        seed:copy | seed:seed)
          phase=seed
          seed_values+=("$value")
          ;;
        setup_mode:seed)
          phase=setup_mode
          setup_mode="$value"
          ;;
        setup:setup_mode)
          phase=setup
          setup_value="$value"
          ;;
        *)
          echo "bootstrap=stack-invalid $stack" >&2
          exit 1
          ;;
      esac
      index=$((index + 2))
    done
    case "$phase:$setup_mode" in
      setup:snippet | setup:file | setup:none) ;;
      *)
        echo "bootstrap=stack-invalid $stack" >&2
        exit 1
        ;;
    esac
  fi
}
