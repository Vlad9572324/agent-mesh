#!/usr/bin/env python3
"""Passive opt-in native hook; config is fixed argv, identity is wrapper env."""

from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "adapters"))
from native_hooks import main


if __name__ == "__main__":
    raise SystemExit(main())
