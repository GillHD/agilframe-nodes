import io
import json
import runpy
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "systemd" / "check-ports.py"
MAIN = runpy.run_path(str(SCRIPT))["main"]


def agent(**environment):
    return {"network_mode": "host", "environment": environment}


def redis(host="127.0.0.1"):
    return {"network_mode": "host", "command": ["redis-server", "--bind", host, "--port", "6380"]}


class PortPreflightTest(unittest.TestCase):
    def run_check(self, services, sockets=()):
        source = io.StringIO(json.dumps({"services": services}))
        output, errors = io.StringIO(), io.StringIO()
        with (
            patch("sys.argv", [str(SCRIPT)]),
            patch("sys.stdin", source),
            patch.dict(MAIN.__globals__, {"listeners": lambda: iter(sockets)}),
            redirect_stdout(output),
            redirect_stderr(errors),
        ):
            status = MAIN()
        return status, output.getvalue(), errors.getvalue()

    def test_redis_and_agent_overlap_without_open_sockets(self):
        for host in ("127.0.0.1", "::"):
            with self.subTest(host=host):
                services = {"node": agent(NODE_MEDIA_ENABLED="false", NODE_HTTP_HOST=host, NODE_HTTP_PORT="6380"),
                            "redis": redis()}
                status, _, errors = self.run_check(services)
                self.assertEqual(status, 1)
                self.assertIn("Agent HTTP and Local Redis overlap on planned TCP port(s) 6380", errors)

    def test_livekit_and_turn_overlap_at_udp_range_boundary(self):
        services = {"node": agent(NODE_FEATURES="sfu,turn", SFU_UDP_MIN_PORT="50000", SFU_UDP_MAX_PORT="50050",
                                  TURN_MIN_PORT="50050", TURN_MAX_PORT="50080")}
        status, _, errors = self.run_check(services)
        self.assertEqual(status, 1)
        self.assertIn("LiveKit RTC range and TURN relay range overlap on planned UDP port(s) 50050", errors)

    def test_distinct_binds_and_intentional_port_sharing_are_allowed(self):
        cases = [
            {"node": agent(NODE_MEDIA_ENABLED="false", NODE_HTTP_HOST="127.0.0.2", NODE_HTTP_PORT="6380"),
             "redis": redis()},
            {"node": agent(NODE_MEDIA_ENABLED="false", NODE_HTTP_HOST="0.0.0.0", NODE_HTTP_PORT="6380"),
             "redis": redis("::1")},
            {"node": agent(NODE_FEATURES="sfu", SFU_PORT="50000", SFU_UDP_MUX_PORT="50000")},
            {"node": agent(NODE_FEATURES="turn", TURN_TLS="1", TURN_PORT="5349", TURN_TLS_PORT="5349")},
            {"node": agent(NODE_FEATURES="sfu,turn,stun"), "redis": redis()},
        ]
        for services in cases:
            with self.subTest(services=services):
                status, output, errors = self.run_check(services)
                self.assertEqual(status, 0, errors)
                self.assertIn("No occupied ports", output)

    def test_already_bound_tcp_port_is_reported(self):
        services = {"node": agent(NODE_MEDIA_ENABLED="false", NODE_HTTP_HOST="127.0.0.1", NODE_HTTP_PORT="6380")}
        status, output, errors = self.run_check(services, [("tcp", "127.0.0.1", 6380)])
        self.assertEqual(status, 1, errors)
        self.assertIn("Agent HTTP (TCP): already in use on 127.0.0.1:6380", output + errors)


if __name__ == "__main__":
    unittest.main()
