#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  printf 'Usage: %s STACK_DIRECTORY\n' "$0" >&2
  exit 2
fi

source_dir=$(CDPATH= cd "$(dirname "$0")/.." && pwd)
stack=$1
install -d -m 0700 -- "$stack" "$stack/agent"

seed_file() (
  input=$1
  target=$2
  mode=$3
  if [ -f "$target" ]; then
    exit 0
  fi
  if [ -e "$target" ] || [ -L "$target" ]; then
    printf 'Expected a regular file at %s. Preserving the existing path.\n' "$target" >&2
    exit 1
  fi

  staged=$(mktemp "$stack/.env.agil-stage.XXXXXX")
  trap 'rm -f -- "$staged"' EXIT
  install -m "$mode" -- "$input" "$staged"
  if [ "$target" = "$stack/.env" ]; then
    sed -i 's/^NODE_HTTP_HOST=.*/NODE_HTTP_HOST=127.0.0.1/; s/^SFU_METRICS_PORT=.*/SFU_METRICS_PORT=0/' "$staged"
  fi
  # Publish a complete file without overwriting another invocation's result.
  ln -T -- "$staged" "$target" || [ -f "$target" ]
)

for file in .dockerignore Dockerfile docker-compose.yml Caddyfile.sfu; do
  seed_file "$source_dir/$file" "$stack/$file" 0644
done
for input in "$source_dir"/compose.local-*.yml; do
  seed_file "$input" "$stack/${input##*/}" 0644
done
for input in "$source_dir"/agent/*.mjs; do
  seed_file "$input" "$stack/agent/${input##*/}" 0644
done
seed_file "$source_dir/.env.example" "$stack/.env" 0600
