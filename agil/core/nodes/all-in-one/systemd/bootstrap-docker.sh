#!/bin/sh
set -eu

mode=${1:-plan}
if [ "$#" -gt 1 ] || { [ "$mode" != plan ] && [ "$mode" != install ]; }; then
  printf 'Usage: %s [plan|install]\n' "$0" >&2
  exit 2
fi
if ! grep -Eq '^ID=(ubuntu|debian|"(ubuntu|debian)")$' /etc/os-release ||
   ! command -v apt-get >/dev/null || ! command -v apt-cache >/dev/null || ! command -v dpkg >/dev/null; then
  printf 'This Docker bootstrap requires Debian or Ubuntu with APT.\n' >&2
  exit 1
fi
if [ "$mode" = install ] && [ "$(id -u)" -ne 0 ]; then
  printf 'Run install as root. Plan can run without changing the host.\n' >&2
  exit 1
fi

export LC_ALL=C

check_version() {
  package=$1
  required=$2
  policy=$(apt-cache policy "$package")
  version=$(printf '%s\n' "$policy" | awk '$1 == "Installed:" { print $2; exit }')
  if [ "$version" = '(none)' ]; then
    version=$(printf '%s\n' "$policy" | awk '$1 == "Candidate:" { print $2; exit }')
  fi
  if [ -z "$version" ] || [ "$version" = '(none)' ]; then
    printf 'APT cannot find %s. Configure the signed Docker repository or a trusted mirror and refresh the package index.\n' "$package" >&2
    return 1
  fi
  if ! dpkg --compare-versions "${version#*:}" ge "$required"; then
    printf '%s must be version %s or later. Review your installed packages and APT candidates.\n' "$package" "$required" >&2
    return 1
  fi
}

check_version docker-ce 24
check_version docker-compose-plugin 2.24

set -- docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
if ! plan=$(apt-get --simulate --no-remove --no-upgrade --no-install-recommends install "$@"); then
  printf 'APT could not plan the first installation without removals. Review the package conflicts.\n' >&2
  exit 1
fi
printf '%s\n' "$plan"
if ! printf '%s\n' "$plan" | awk '
  $1 == "Remv" || $1 == "Purg" { unsafe = 1 }
  $1 == "Inst" {
    if (substr($3, 1, 1) == "[") unsafe = 1
    installing[$2] = 1
  }
  $1 == "Conf" { configuring[$2] = 1 }
  END {
    for (package in configuring) {
      if (!(package in installing)) unsafe = 1
    }
    exit unsafe
  }
'; then
  printf 'The plan changes packages already installed. Resolve that separately before using first-install bootstrap.\n' >&2
  exit 1
fi
if [ "$mode" = install ] && printf '%s\n' "$plan" | grep -q '^Inst[[:space:]]'; then
  exec apt-get --no-remove --no-upgrade --no-install-recommends install "$@"
fi
