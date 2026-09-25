"""Quickstart — a working call in under five minutes.

    pip install soroban-explorer-client
    SOROBAN_API_URL=http://localhost:3000/api/v1 python examples/quickstart.py

Executed in CI against a live API instance.
"""

import os

from soroban_explorer import Client, NotFoundError, RateLimitError


def main() -> None:
    client = Client(
        base_url=os.environ.get("SOROBAN_API_URL", "http://localhost:3000/api/v1"),
        api_key=os.environ.get("SOROBAN_API_KEY"),
    )

    page = client.transactions.list(limit=5)
    print("transactions:", len(page.get("data", [])) if isinstance(page, dict) else page)

    print("network:", str(client.call("getNetwork"))[:120])

    try:
        client.transactions.get("0" * 64)
    except NotFoundError as err:
        print("not found as expected; request id", err.request_id)
    except RateLimitError as err:
        print("rate limited; retry after", err.retry_after)

    n = sum(1 for _ in client.paginate("getTransactions", query={"limit": 2}, max_pages=2))
    print("paginated items:", n)


if __name__ == "__main__":
    main()
