#!/bin/sh
set -eu

if [ "$#" -lt 2 ] || [ "$#" -gt 3 ] || { [ "$#" -eq 3 ] && [ "$3" != --prepare ] && [ "$3" != --offline ]; }; then
  printf 'Usage: %s PROJECT_NAME REGISTRY_IMAGE@sha256:DIGEST [--prepare|--offline]\n' "$0" >&2
  printf '       %s PROJECT_NAME --prepare-approved|--apply-approved\n' "$0" >&2
  exit 2
fi
project=$1
candidate=$2
mode=${3:-}
approved=false
apply=false
case "$project" in
  ''|[!a-z0-9]*|*[!a-z0-9_-]*)
    printf 'Use the Compose project name from the service instance.\n' >&2
    exit 2
    ;;
esac
validate_digest() {
  case "$1" in
    *[!a-zA-Z0-9./@:_-]*) return 1 ;;
  esac
  printf '%s\n' "$1" | grep -Eq '^[a-zA-Z0-9][a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}$'
}

if [ "$candidate" = --prepare-approved ] && [ "$#" -eq 2 ]; then
  approved=true
  mode=--prepare
elif [ "$candidate" = --apply-approved ] && [ "$#" -eq 2 ]; then
  approved=true
  apply=true
  mode=--offline
elif ! validate_digest "$candidate"; then
  printf 'Use a registry image pinned by SHA-256 digest.\n' >&2
  exit 2
fi

unit="agil-node@$project.service"
stack=$(systemctl show --property=WorkingDirectory --value "$unit")
cd "${stack:?The unit must define a project directory}"
release_env="$stack/release-image.env"
unit_env=$(systemctl show --property=EnvironmentFiles --value "$unit")
case " $unit_env " in
  *" $release_env "*) ;;
  *) printf 'Install and reload the AGIL node unit with release-image.env support.\n' >&2; exit 1 ;;
esac

trusted_owner() {
  [ ! -L "$1" ] && ownership=$(stat -c '%u %a' -- "$1") &&
    [ "${ownership%% *}" = 0 ] && [ $((0${ownership#* } & 022)) -eq 0 ]
}

if [ "$approved" = true ] && ! trusted_owner .; then
  printf 'The unit directory must be owned by root and writable only by root.\n' >&2
  exit 1
fi

umask 077
lock=.release-image.lock
if [ -L "$lock" ] || { [ -e "$lock" ] && ! [ -f "$lock" ]; }; then
  printf 'The rollout lock must be a regular file in the project directory.\n' >&2
  exit 1
fi
exec 9>>"$lock"
if ! flock --nonblock 9; then
  printf 'An image rollout is already running for %s.\n' "$project" >&2
  exit 1
fi
approval=approved-image.txt
window=approved-rollout.txt
matches_file() {
  printf '%s\n' "$1" | cmp -s - "$2" || printf '%s' "$1" | cmp -s - "$2"
}

if [ "$apply" = true ] && [ ! -e "$window" ] && [ ! -L "$window" ]; then exit 0; fi
if [ "$approved" = true ]; then
  if [ ! -e "$approval" ] && [ ! -L "$approval" ]; then
    printf 'No approved image for %s.\n' "$project"
    exit 0
  fi
  if ! [ -f "$approval" ] || ! trusted_owner "$approval" || [ "$(stat -c '%s' -- "$approval")" -gt 512 ]; then
    printf 'Use a root-owned regular approved-image.txt with one digest and no group or other write access.\n' >&2
    exit 1
  fi
  candidate=$(cat -- "$approval")
  if ! validate_digest "$candidate" || ! matches_file "$candidate" "$approval"; then
    printf 'approved-image.txt must contain one image pinned by SHA-256 digest.\n' >&2
    exit 2
  fi
fi

within_window() {
  now=$(date -u +%s)
  [ "$now" -ge "$earliest" ] && [ "$now" -lt "$latest" ]
}

if [ "$apply" = true ]; then
  if ! [ -f "$window" ] || ! trusted_owner "$window" || [ "$(stat -c '%s' -- "$window")" -gt 512 ]; then
    printf 'Use a root-owned regular approved-rollout.txt without group or other write access.\n' >&2
    exit 1
  fi
  authorized=$(cat -- "$window")
  if [ "$(printf '%s' "$authorized" | wc -l)" -ne 0 ] ||
    ! printf '%s\n' "$authorized" | grep -Eq '^[^[:space:]]+ [1-9][0-9]{9} [1-9][0-9]{9}$' ||
    ! matches_file "$authorized" "$window"; then
    printf 'approved-rollout.txt requires DIGEST EARLIEST_EPOCH LATEST_EPOCH on one line.\n' >&2
    exit 2
  fi
  IFS=' ' read -r approved_digest earliest latest <<EOF
$authorized
EOF
  if [ "$approved_digest" != "$candidate" ] || [ "$earliest" -ge "$latest" ] || [ "$((latest - earliest))" -gt 3600 ]; then
    printf 'Use the approved image digest and a nonempty rollout window of at most one hour.\n' >&2
    exit 2
  fi
  within_window || exit 0
fi
unset DOCKER_HOST DOCKER_CONTEXT
docker_local() {
  docker --host unix:///var/run/docker.sock "$@"
}

running_image() {
  container=$(docker_local compose --env-file .env --project-name "$project" ps --status running --quiet node) &&
    [ -n "$container" ] &&
    docker_local inspect --type container --format '{{.Image}}' "$container"
}

is_image_id() {
  [ "${#1}" -eq 71 ] && printf '%s\n' "$1" | grep -Eq '^sha256:[a-f0-9]{64}$'
}

inspect_image() {
  image_id=$(docker_local image inspect --format '{{.Id}}' "$1") &&
    is_image_id "$image_id" && printf '%s\n' "$image_id"
}

if [ "$approved" = true ] && [ "$mode" = --prepare ] && inspect_image "$candidate" >/dev/null 2>&1; then
  printf 'The approved digest is already cached for %s.\n' "$project"
  exit 0
fi

if [ "$mode" != --prepare ]; then
  systemctl is-active --quiet "$unit"
  if ! previous=$(running_image) || ! is_image_id "$previous"; then
    printf 'Cannot determine the current image ID for %s. No rollout was attempted.\n' "$project" >&2
    exit 1
  fi
fi
if [ "$mode" != --offline ]; then
  docker_local pull "$candidate"
fi
if ! candidate_id=$(inspect_image "$candidate"); then
  printf 'The requested digest has no valid local image ID. Run --prepare before an offline rollout.\n' >&2
  exit 1
fi
if [ "$mode" = --prepare ]; then
  printf 'Prepared %s on %s. The active image selection was not changed.\n' "$candidate" "$project"
  exit 0
fi
if [ "$apply" = true ]; then
  if ! trusted_owner "$approval" || ! trusted_owner "$window" ||
    ! matches_file "$candidate" "$approval" || ! matches_file "$authorized" "$window"; then
    printf 'The rollout approval changed during preflight. No rollout was attempted.\n' >&2
    exit 1
  fi
  within_window || exit 0
  # Consume the approval even on failure so the timer cannot retry a disruptive restart.
  mv -fT -- "$window" last-scheduled-rollout.txt
fi
if [ "$candidate_id" = "$previous" ]; then
  printf 'The requested image is already running on %s.\n' "$project"
  exit 0
fi

staged=$(mktemp "$stack/.env.release-image.XXXXXX")
trap 'rm -f -- "$staged"' EXIT
select_image() {
  printf 'AGIL_NODE_IMAGE=%s\n' "$1" >"$staged" && mv -fT -- "$staged" "$release_env"
}
restore_image() {
  if select_image "$previous" && systemctl restart "$unit" && [ "$(running_image)" = "$previous" ]; then
    printf 'Restored the previous image for %s.\n' "$project" >&2
  else
    printf 'Could not restore the previous image. Inspect the journal for %s.\n' "$unit" >&2
  fi
}

trap 'trap - HUP INT TERM; restore_image; exit 1' HUP INT TERM
if [ "$apply" = true ] && ! within_window; then
  trap - HUP INT TERM
  printf 'The rollout window closed before the restart on %s.\n' "$project"
  exit 0
fi
select_image "$candidate"
if systemctl restart "$unit" && [ "$(running_image)" = "$candidate_id" ]; then
  trap - HUP INT TERM
  printf 'Image rollout complete for %s.\n' "$project"
  exit 0
fi

trap - HUP INT TERM
printf 'The requested image did not become active on %s.\n' "$project" >&2
restore_image
exit 1
