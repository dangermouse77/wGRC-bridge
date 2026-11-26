#!/usr/bin/env python3
"""Run the wGRC deposit client using the checkout's shared protocol code."""

import os
from pathlib import Path
import subprocess
import sys


def main():
    root = Path(__file__).resolve().parents[2]
    environment = dict(os.environ, WGRC_EXTERNAL_DEPOSIT_CLIENT="1")
    try:
        return subprocess.call(
            ["node", str(root / "scripts" / "client-deposit.cjs"), *sys.argv[1:]],
            env=environment,
        )
    except FileNotFoundError:
        print("Install Node.js 22 or newer and put node on PATH.", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
