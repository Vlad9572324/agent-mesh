#!/usr/bin/env python3
"""Private-config stdio entrypoint; never starts a provider or model."""
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'adapters'))
from native_mcp import main

if __name__ == '__main__':
    raise SystemExit(main())
