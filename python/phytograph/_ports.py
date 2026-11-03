"""Free-port choice for a script-launched backend.

The Python twin of ``scripts/free-port.mjs`` — read that file's header for the
reasoning. In short: never bind ``:0`` (an ephemeral port can be handed to an
outgoing connection between our probe and the server's bind), and draw from a
band of our own below every OS ephemeral range so a script, the desktop app,
``npm run dev`` and E2E never consider the same number.

``SCRIPT_BAND`` is the ``script`` entry of ``PORT_BANDS`` in
``scripts/free-port.mjs``; ``scripts/free-port.test.mjs`` reads this file and
asserts the two agree (and that no band overlaps another).
"""
from __future__ import annotations

import random
import socket
from typing import Iterable, Tuple

# [min, max). The other owners: app 10000-14999, dev 15000-19999, e2e 20000-31999.
SCRIPT_BAND: Tuple[int, int] = (5_000, 10_000)


def can_listen(port: int, host: str = "127.0.0.1") -> bool:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind((host, port))
        s.listen(1)
        return True
    except OSError:
        return False
    finally:
        s.close()


def find_free_port(band: Tuple[int, int] = SCRIPT_BAND, *, exclude: Iterable[int] = (),
                   tries: int = 200, host: str = "127.0.0.1") -> int:
    lo, hi = band
    skip = set(exclude)
    for _ in range(tries):
        port = random.randrange(lo, hi)
        if port in skip:
            continue
        if can_listen(port, host):
            return port
    raise RuntimeError(f"no free port in [{lo}, {hi}) after {tries} tries")
