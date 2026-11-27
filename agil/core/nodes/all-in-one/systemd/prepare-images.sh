#!/bin/sh
set -eu

usage() {
  printf 'Usage: %s STACK_DIRECTORY PROJECT_NAME check|check-ports|check-images|build|registry\n' "$0" >&2
  printf '       %s STACK_DIRECTORY PROJECT_NAME firewall-plan [--signaling-cidr NETWORK] [--media-cidr NETWORK] [--monitoring-cidr NETWORK] [--nftables TABLE CHAIN]\n' "$0" >&2
  exit 2
}
if [ "$#" -lt 3 ] || { [ "$3" != firewall-plan ] && [ "$#" -ne 3 ]; }; then
  usage
fi
case "$3" in check|check-ports|check-images|build|registry|firewall-plan) ;; *) usage ;; esac

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
cd "$1"
project=$2
mode=$3

unset DOCKER_HOST DOCKER_CONTEXT
docker_local() {
  docker --host unix:///var/run/docker.sock "$@"
}

compose() {
  docker_local compose --env-file .env --project-name "$project" "$@"
}

resolved_images() {
  images=$(compose config --images)
  if [ -z "$images" ]; then
    printf 'No images found in Compose project %s.\n' "$project" >&2
    return 1
  fi
  if printf '%s\n' "$images" | grep -qF '@'; then
    if ! command -v python3 >/dev/null; then
      printf 'Install Python 3 to validate the configured image pins.\n' >&2
      return 1
    fi
    config=$(compose config --format json)
    printf '%s\n' "$config" | python3 "$script_dir/check-image-pins.py"
  fi
}

if [ "$mode" = firewall-plan ]; then
  shift 3
  if ! command -v python3 >/dev/null; then
    printf 'Install Python 3 to generate the firewall plan.\n' >&2
    exit 2
  fi
  config=$(compose config --format json)
  printf '%s\n' "$config" | python3 "$script_dir/check-ports.py" --firewall-plan "$@"
  exit
fi

if [ "$mode" = check-images ]; then
  resolved_images
  printf 'Image references in Compose project %s are ready for preparation.\n' "$project"
  exit 0
fi

if ! engine=$(docker_local version --format '{{.Server.Os}} {{.Server.Version}}'); then
  printf 'Cannot reach the local Docker Engine at /var/run/docker.sock. Check docker.service and access to its socket.\n' >&2
  exit 1
fi
engine_os=${engine%% *}
engine_version=${engine#* }
engine_major=${engine_version%%.*}
case "$engine_major" in
  ''|*[!0-9]*) engine_major=0 ;;
esac
if [ "$engine_os" != linux ] || [ "$engine_major" -lt 24 ]; then
  printf 'The systemd node requires Linux Docker Engine 24 or later. Detected: %s.\n' "$engine" >&2
  exit 1
fi
if ! compose_help=$(docker_local compose up --help); then
  printf 'Install or repair the Docker Compose plugin used by the local Docker CLI.\n' >&2
  exit 1
fi
for flag in --wait --wait-timeout; do
  if ! printf '%s\n' "$compose_help" | grep -Eq "^[[:space:]]+$flag([[:space:]]|$)"; then
    printf 'The Docker Compose plugin lacks up %s. Update Compose before enabling the systemd unit.\n' "$flag" >&2
    exit 1
  fi
done

if ! compose config --quiet; then
  printf 'Cannot resolve the Compose project %s. Check the project .env and Compose files.\n' "$project" >&2
  exit 1
fi
if [ "$mode" = check-ports ]; then
  if ! command -v python3 >/dev/null; then
    printf 'Install Python 3 to check host ports.\n' >&2
    exit 2
  fi
  config=$(compose config --format json)
  printf '%s\n' "$config" | python3 "$script_dir/check-ports.py"
  exit
fi
resolved_images
if [ "$mode" = check ]; then
  printf 'Docker Engine %s and Compose are ready for systemd project %s.\n' "$engine_version" "$project"
  exit 0
fi
if [ "$mode" = build ]; then
  compose build node
else
  compose pull node
fi
compose pull --ignore-buildable

# systemd starts from the local image store with --pull never.
resolved_images
printf '%s\n' "$images" | while IFS= read -r image; do
  docker_local image inspect "$image" >/dev/null
done
