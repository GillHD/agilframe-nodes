"""Check host listeners or plan ingress for the base node and local Redis."""

import argparse
import ipaddress
from itertools import combinations
import json
import re
import subprocess
import sys


def planned_ports(services):
    node = services["node"]
    if node.get("network_mode") != "host":
        raise ValueError("The node must use host networking for this check.")
    env = node.get("environment", {})
    plan = []

    def setting(name, alias=""):
        return (env.get(name) or "").strip() or (env.get(alias) or "").strip()

    def port(name, fallback, alias="", minimum=1):
        value = setting(name, alias)
        if not value:
            return fallback
        if not re.fullmatch(r"[0-9]+", value) or not minimum <= int(value) <= 65535:
            raise ValueError(f"{name} is outside the supported port range.")
        return int(value)

    def enabled(name, default, alias=""):
        value = setting(name, alias).lower()
        if not value:
            return default
        if value in {"1", "true", "yes", "on"}:
            return True
        if value in {"0", "false", "no", "off"}:
            return False
        raise ValueError(f"{name} must be a boolean.")

    def add(name, protocol, first, last=None, host="", scope="media"):
        if first == 0:
            return
        if last is not None and last < first:
            raise ValueError(f"{name} has a reversed port range.")
        plan.append((name, protocol, first, first if last is None else last, host, scope))

    features = set(re.split(r"[,\s]+", setting("NODE_FEATURES", "AGIL_NODE_FEATURES").lower().strip(", ")))
    features = features - {""} or {"sfu"}
    if features - {"sfu", "turn", "stun"}:
        raise ValueError("NODE_FEATURES includes an unknown feature.")
    add("Agent HTTP", "tcp", port("NODE_HTTP_PORT", 8080, "AGIL_NODE_HTTP_PORT"),
        host=setting("NODE_HTTP_HOST", "AGIL_NODE_HTTP_HOST") or "0.0.0.0", scope="monitoring")
    if enabled("NODE_MEDIA_ENABLED", True, "AGIL_NODE_MEDIA_ENABLED"):
        if "sfu" in features:
            add("LiveKit signalling", "tcp", port("SFU_PORT", 7880), scope="signaling")
            add("LiveKit RTC", "tcp", port("SFU_TCP_PORT", 7881))
            add("LiveKit Prometheus", "tcp", port("SFU_METRICS_PORT", 6789, minimum=0), scope="monitoring")
            mux = port("SFU_UDP_MUX_PORT", 0, minimum=0)
            if mux:
                add("LiveKit RTC mux", "udp", mux)
            else:
                add("LiveKit RTC range", "udp", port("SFU_UDP_MIN_PORT", 50000, minimum=1024),
                    port("SFU_UDP_MAX_PORT", 50100, minimum=1024))
        if features & {"turn", "stun"}:
            listen_ip = setting("TURN_LISTEN_IP")
            for protocol in ("tcp", "udp"):
                add("TURN/STUN", protocol, port("TURN_PORT", 3478), host=listen_ip)
                if enabled("TURN_TLS", False):
                    add("TURN TLS/DTLS", protocol, port("TURN_TLS_PORT", 5349), host=listen_ip)
            if "turn" in features:
                add("TURN relay range", "udp", port("TURN_MIN_PORT", 49200, minimum=1024),
                    port("TURN_MAX_PORT", 49250, minimum=1024))

    unchecked = sorted(name for name, service in services.items()
                       if name != "node" and service.get("network_mode") == "host")
    redis_command = services.get("redis", {}).get("command") or []
    if ("redis" in unchecked and isinstance(redis_command, list)
            and len(redis_command) >= 5 and redis_command[:2] == ["redis-server", "--bind"]):
        host, option, value = redis_command[2:5]
        if option == "--port" and re.fullmatch(r"[0-9]+", value) and 1 <= int(value) <= 65535:
            add("Local Redis", "tcp", int(value), host=host, scope="local")
            unchecked.remove("redis")
    return plan, unchecked


def address(value):
    value = value.strip("[]").split("%", 1)[0]
    try:
        parsed = ipaddress.ip_address(value)
        return str(getattr(parsed, "ipv4_mapped", None) or parsed)
    except ValueError:
        return value.lower()


def overlaps(host, listener):
    wildcard = {"", "*", "0.0.0.0", "::"}
    if host in wildcard or listener in wildcard or host == listener:
        return True
    if host == "localhost":
        return listener in {"127.0.0.1", "::1"}
    try:
        ipaddress.ip_address(host)
        return False
    except ValueError:
        return True


def planned_collisions(plan):
    for left, right in combinations(plan, 2):
        left_name, protocol, left_first, left_last, left_host, _ = left
        right_name, right_protocol, right_first, right_last, right_host, _ = right
        first = max(left_first, right_first)
        last = min(left_last, right_last)
        if protocol != right_protocol or first > last:
            continue
        # Coturn identifies plain and TLS traffic on a shared endpoint.
        if {left_name, right_name} == {"TURN/STUN", "TURN TLS/DTLS"}:
            continue
        left_host, right_host = address(left_host), address(right_host)
        hosts = (left_host, right_host)
        # IPv4 wildcard does not cover an explicitly bound IPv6 address.
        if "0.0.0.0" in hosts and any(":" in host and host != "::" for host in hosts):
            continue
        if overlaps(left_host, right_host) or overlaps(right_host, left_host):
            ports = str(first) if first == last else f"{first}-{last}"
            yield f"{left_name} and {right_name} overlap on planned {protocol.upper()} port(s) {ports}."


def listeners():
    result = subprocess.run(["ss", "-H", "-a", "-n", "-t", "-u"], check=True,
                            stdout=subprocess.PIPE, text=True)
    for line in result.stdout.splitlines():
        protocol, state, _, _, local, *_ = line.split()
        if protocol == "tcp" and state != "LISTEN":
            continue
        host, _, port = local.rpartition(":")
        if port.isdecimal() and int(port):
            yield protocol, address(host), int(port)


def source_networks(values):
    try:
        networks = [ipaddress.ip_network(value, strict=True) for value in values]
    except ValueError as error:
        raise ValueError("Use a valid IPv4 or IPv6 CIDR with no host bits set.") from error
    return [network for version in (4, 6) for network in
            ipaddress.collapse_addresses(item for item in networks if item.version == version)]


def firewall_plan(plan, unchecked, options):
    sources = {scope: source_networks(getattr(options, f"{scope}_cidr"))
               for scope in ("signaling", "media", "monitoring")}
    if any(network.prefixlen == 0 for network in sources["monitoring"]):
        raise ValueError("Monitoring requires restricted source CIDRs.")

    rules = []
    unplanned = []
    for index, (name, protocol, first, last, host, scope) in enumerate(plan):
        host = address(host)
        for other, kind, low, high, bind, group in plan[:index]:
            if (scope != group and protocol == kind and first <= high and low <= last
                    and overlaps(host, address(bind))):
                raise ValueError(f"{name} and {other} have overlapping {protocol.upper()} firewall scopes.")
        entry = {"component": name, "scope": scope, "protocol": protocol,
                 "portStart": first, "portEnd": last, "bindAddress": host or None}
        try:
            ip = ipaddress.ip_address(host)
        except ValueError:
            ip = None
        networks = sources.get(scope, [])
        matching = [network for network in networks if ip is None or network.version == ip.version]
        if host == "localhost" or (ip is not None and ip.is_loopback):
            unplanned.append({**entry, "reason": "loopback"})
        elif scope == "local":
            unplanned.append({**entry, "reason": "review-local-service"})
        elif host and ip is None:
            unplanned.append({**entry, "reason": "unresolved-bind-address"})
        elif matching:
            rules.append({**entry, "sourceCidrs": [str(network) for network in matching]})
        else:
            reason = "no-matching-address-family" if networks else "source-cidr-required"
            unplanned.append({**entry, "reason": reason})
    return {"ingressRules": rules, "unplanned": unplanned, "additionalHostServices": unchecked}


def nftables_rules(plan, table, chain):
    if not all(re.fullmatch(r"[a-zA-Z_][a-zA-Z0-9_]*", item) for item in (table, chain)):
        raise ValueError("Use letters, digits and underscores for the nftables table and chain names.")
    lines = ["# Append to an existing inet chain. Review the JSON plan for omitted services."]
    target = f"add rule inet {table} {chain}"
    for rule in plan["ingressRules"]:
        first, last = rule["portStart"], rule["portEnd"]
        ports = f"{first}-{last}" if first != last else str(first)
        bind = rule["bindAddress"]
        for source in rule["sourceCidrs"]:
            family = "ip6" if ipaddress.ip_network(source).version == 6 else "ip"
            match = f"{family} saddr {source}"
            if bind and not ipaddress.ip_address(bind).is_unspecified:
                match += f" {family} daddr {bind}"
            comment = json.dumps(f"AGIL {rule['component']}")
            lines.append(f"{target} {match} {rule['protocol']} dport {ports} accept comment {comment}")
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--firewall-plan", action="store_true")
    parser.add_argument("--nftables", nargs=2, metavar=("TABLE", "CHAIN"))
    for scope in ("signaling", "media", "monitoring"):
        parser.add_argument(f"--{scope}-cidr", action="append", default=[])
    options = parser.parse_args()
    if options.nftables and not options.firewall_plan:
        parser.error("--nftables requires --firewall-plan")
    action = "plan ingress rules" if options.firewall_plan else "check planned ports"
    try:
        plan, unchecked = planned_ports(json.load(sys.stdin)["services"])
        if options.firewall_plan:
            ingress = firewall_plan(plan, unchecked, options)
            print(nftables_rules(ingress, *options.nftables) if options.nftables
                  else json.dumps(ingress, indent=2))
            return 0
        collisions = list(planned_collisions(plan))
        if collisions:
            print("\n".join(collisions), file=sys.stderr)
            return 1
        occupied = sorted(set(listeners()), key=lambda row: (row[2], row[1]))
    except (KeyError, TypeError, ValueError, OSError, subprocess.CalledProcessError) as error:
        if isinstance(error, ValueError) and not isinstance(error, json.JSONDecodeError):
            print(f"Cannot {action}: {error}", file=sys.stderr)
        else:
            hint = "Check the Compose config." if options.firewall_plan else "Check the Compose config and install iproute2 (ss)."
            print(f"Cannot {action}. {hint}", file=sys.stderr)
        return 2
    if unchecked:
        print(f"Check additional host-network services separately: {', '.join(unchecked)}.", file=sys.stderr)
    conflicts = 0
    for name, protocol, first, last, host, _scope in plan:
        bind_host = address(host)
        matches = [f"[{bind}]:{port}" if ":" in bind else f"{bind}:{port}"
                   for kind, bind, port in occupied
                   if kind == protocol and first <= port <= last and overlaps(bind_host, bind)]
        if matches:
            conflicts += 1
            shown = ", ".join(matches[:6])
            more = f" and {len(matches) - 6} more" if len(matches) > 6 else ""
            print(f"{name} ({protocol.upper()}): already in use on {shown}{more}.", file=sys.stderr)
    if conflicts:
        return 1
    print("No occupied ports found for the base node and configured local Redis.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
