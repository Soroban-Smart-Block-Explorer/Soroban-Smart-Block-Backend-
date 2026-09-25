# Python Client — Runbook

## Develop

```bash
npm run sdk:generate                                   # regenerate _operations.py + models.py
python -m unittest discover -s packages/python-client/tests
SOROBAN_API_URL=http://localhost:3000/api/v1 PYTHONPATH=packages/python-client \
  python packages/python-client/examples/quickstart.py  # against docker compose
```

## Debug

| Symptom                  | Action                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------- |
| `SDK drift` in CI        | `npm run sdk:generate` and commit                                                                 |
| `Unknown operation`      | Operation id changed/removed in the spec; see `docs/sdk/parity-matrix.md`                         |
| `RequestValidationError` | Message lists every issue; the table in `_operations.py` shows types/bounds                       |
| Retries / 429s           | Enable `logging.getLogger("soroban_explorer").setLevel(logging.DEBUG)` or pass `on_request=print` |

## Release

1. Bump `version` in `packages/python-client/pyproject.toml` and
   `__version__` in `soroban_explorer/client.py` (policy: `docs/sdk/versioning.md`).
2. Tag `python-client-v<version>`; `.github/workflows/sdk-publish.yml` builds
   and publishes via PyPI trusted publishing with attestations (provenance).

## Recover

Yank the bad version on PyPI and publish a patch; never delete releases.
