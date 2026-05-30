#!/usr/bin/env bash
# Canonical source: plugins/dev-core/tools/ — do not edit project-side copies directly
# Shared exemption helpers for check_file_length.sh / check_folder_size.sh.
# Sourced, not executed. The caller must export (or set) before sourcing:
#   EXEMPT_FILE       path to the exemptions file
#   QG_EXEMPT_UNIT    cap unit word as it appears in exemption lines ("lines" | "files")
# No `set` here: sourcing must not mutate the caller's shell options.

# Return 0 if "$1" is listed (exact first-field match) in the exemptions file.
# Exact match on the first whitespace-delimited field — no regex, no escaping,
# left-anchored (awk field split) so a path substring elsewhere on the line
# cannot cause a false positive. Exemption format: '<path> <issue-url>'.
# Paths must not contain spaces — field splitting would break the match.
# ENVIRON avoids awk's -v escape processing (backslash sequences in path → corrupted match).
is_exempt() {
    [ ! -f "$EXEMPT_FILE" ] && return 1
    P="$1" awk '$1 == ENVIRON["P"] { found = 1 } END { exit !found }' "$EXEMPT_FILE"
}

# Parse the declared cap from the matching exemption line.
# Looks for "# <N> <unit>" anywhere after the path field, where <unit> is $QG_EXEMPT_UNIT.
# Returns the integer N, or empty string if not present (back-compat: full bypass).
# POSIX-portable: uses two-arg match() + substr() instead of gawk's three-arg match()
# so the script works on mawk (Ubuntu/Pop!_OS default /usr/bin/awk). The unit is passed
# via ENVIRON and concatenated into a dynamic regex so the two callers share one parser.
exempt_cap() {
    [ ! -f "$EXEMPT_FILE" ] && return 0
    P="$1" UNIT="$QG_EXEMPT_UNIT" awk '
        $1 == ENVIRON["P"] {
            if (match($0, "# *[0-9]+ *" ENVIRON["UNIT"])) {
                s = substr($0, RSTART, RLENGTH)
                if (match(s, /[0-9]+/)) print substr(s, RSTART, RLENGTH)
            }
            exit
        }
    ' "$EXEMPT_FILE"
}
