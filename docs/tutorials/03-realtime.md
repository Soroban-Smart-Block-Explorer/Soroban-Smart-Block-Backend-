# Realtime

Check service status before subscribing to the realtime WebSocket feed (`/ws`).

## Steps

1. Start the backend (`docker compose up`) and note the base URL.
2. Run the example: `BASE_URL=http://localhost:3000 node docs/tutorials/examples/03-realtime.mjs`.
3. Read the script; it calls `/api/v1/status` and prints the JSON response.
4. Adapt the request parameters to your own contracts.

Next: [Tutorial index](README.md)
