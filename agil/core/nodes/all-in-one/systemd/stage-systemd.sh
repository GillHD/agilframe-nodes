#!/bin/sh
set -eu

usage() {
  printf 'Usage: %s DESTDIR [--install] [--with-prepare-timer] [--with-apply-timer]\n' "$0" >&2
  exit 2
}
[ "$#" -ge 1 ] || usage
root=$(CDPATH= cd -- "$1" && pwd -P)
shift
install_units=false
with_prepare=false
with_apply=false
for option do
  case "$option" in
    --install) install_units=true ;;
    --with-prepare-timer) with_prepare=true ;;
    --with-apply-timer) with_apply=true ;;
    *) usage ;;
  esac
done
with_timer=false
if [ "$with_prepare" = true ] || [ "$with_apply" = true ]; then with_timer=true; fi

source_dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
unit_dir="${root%/}/etc/systemd/system"
script_dir="${root%/}/usr/local/libexec/agil-node"

check_directory() {
  resolved=$(realpath -m -- "$1")
  case "$resolved" in
    "${root%/}"/*) ;;
    *) printf 'Destination escapes the selected root: %s\n' "$1" >&2; exit 1 ;;
  esac
}
check_directory "$unit_dir"
if [ "$with_timer" = true ]; then
  check_directory "$script_dir"
fi
if ! command -v systemd-analyze >/dev/null; then
  printf 'Install systemd tools to verify the units before staging them.\n' >&2
  exit 1
fi

stage=$(mktemp -d)
cleanup() {
  rm -f -- "$stage/"*
  rmdir -- "$stage"
}
trap cleanup EXIT
install -m 0644 -- "$source_dir/agil-node@.service" "$stage/"
set -- "$stage/agil-node@.service"
if [ "$with_prepare" = true ]; then
  install -m 0644 -- "$source_dir/agil-node-prepare@.service" "$source_dir/agil-node-prepare@.timer" "$stage/"
  set -- "$@" "$stage/agil-node-prepare@.service" "$stage/agil-node-prepare@.timer"
fi
if [ "$with_apply" = true ]; then
  install -m 0644 -- "$source_dir/agil-node-apply@.service" "$source_dir/agil-node-apply@.timer" "$stage/"
  set -- "$@" "$stage/agil-node-apply@.service" "$stage/agil-node-apply@.timer"
fi
if [ "$with_timer" = true ]; then
  install -m 0644 -- "$source_dir/rollout-image.sh" "$stage/"
  sh -n "$stage/rollout-image.sh"
fi
systemd-analyze verify "$@"

check_file() {
  if [ -e "$2" ] || [ -L "$2" ]; then
    if [ -L "$2" ] || ! [ -f "$2" ] || ! cmp -s -- "$1" "$2"; then
      printf 'Preserving existing file %s. Review its local changes before staging.\n' "$2" >&2
      return 1
    fi
  fi
}

publish_file() (
  input=$1
  destination=$2
  check_file "$input" "$destination" || exit 1
  if [ -e "$destination" ]; then exit 0; fi
  temporary=$(mktemp "$(dirname "$destination")/.agil-systemd.XXXXXX")
  trap 'rm -f -- "$temporary"' EXIT
  install -m 0644 -- "$input" "$temporary"
  if ! ln -T -- "$temporary" "$destination" 2>/dev/null; then
    if [ ! -e "$destination" ] && [ ! -L "$destination" ]; then
      printf 'Could not stage %s.\n' "$destination" >&2
      exit 1
    fi
    check_file "$input" "$destination"
  fi
)

for unit do
  check_file "$unit" "$unit_dir/${unit##*/}"
done
if [ "$with_timer" = true ]; then
  check_file "$stage/rollout-image.sh" "$script_dir/rollout-image.sh"
fi

if [ "$install_units" = false ]; then
  for unit do printf 'Verified destination: %s/%s\n' "$unit_dir" "${unit##*/}"; done
  if [ "$with_timer" = true ]; then printf 'Verified destination: %s/rollout-image.sh\n' "$script_dir"; fi
  exit 0
fi

if [ "$with_timer" = true ]; then
  check_directory "$script_dir"
  mkdir -p -- "$script_dir"
  publish_file "$stage/rollout-image.sh" "$script_dir/rollout-image.sh"
fi
check_directory "$unit_dir"
mkdir -p -- "$unit_dir"
for unit do
  publish_file "$unit" "$unit_dir/${unit##*/}"
done
printf 'Staged AGIL node units under %s. Activate them separately if intended.\n' "$unit_dir"
