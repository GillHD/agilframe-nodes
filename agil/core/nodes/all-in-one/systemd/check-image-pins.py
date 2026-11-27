"""Validate digest references in a resolved Compose project."""

import json
import re
import sys


def main():
    services = json.load(sys.stdin)["services"]
    for name, service in services.items():
        image = service.get("image") or ""
        if "@" in image and not re.fullmatch(r"[^@\s]+@sha256:[0-9a-f]{64}", image):
            print(f"Invalid image pin for service '{name}'. Use a SHA-256 digest with "
                  "64 lowercase hexadecimal characters.", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
