# Search

Search indexed contracts, events and transactions.

## Steps

1. Start the backend (`docker compose up`) and note the base URL.
2. Run the example: `BASE_URL=http://localhost:3000 node docs/tutorials/examples/02-search.mjs`.
3. Read the script; it calls `/api/v1/search?q=transfer` and prints the JSON response.
4. Adapt the request parameters to your own contracts.

Next: [Tutorial index](README.md)
