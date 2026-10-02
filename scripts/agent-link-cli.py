#!/usr/bin/env python3
from native_launch import main

if __name__ == '__main__':
    import json
    import sys
    try:
        raise SystemExit(main())
    except (OSError, ValueError, RuntimeError) as error:
        print(json.dumps({'error': type(error).__name__, 'detail': 'Native setup failed; no secret values printed.'}), file=sys.stderr)
        raise SystemExit(1)
