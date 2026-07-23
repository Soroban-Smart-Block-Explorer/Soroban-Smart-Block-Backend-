export const graphqlExamples = {
  typescript: `// TypeScript — Fetch latest transactions
const query = \`
  query LatestTransactions($limit: Int!) {
    transactions(limit: $limit) {
      data { hash ledgerSequence sourceAccount functionName status }
      hasNext
    }
  }
\`;

const res = await fetch('https://explorer.example.com/api/graphql', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    query,
    variables: { limit: 10 },
  }),
});
const json = await res.json();
console.log(json.data.transactions.data);`,

  python: `# Python — Fetch contract details
import requests

query = """
query Contract($address: ID!) {
  contract(address: $address) {
    name
    isToken
    transactions(limit: 5) {
      data { hash functionName status }
    }
  }
}
"""

res = requests.post(
    'https://explorer.example.com/api/graphql',
    json={'query': query, 'variables': {'address': 'C...'}},
    headers={'Content-Type': 'application/json'},
)
print(res.json()['data']['contract'])`,

  curl: `# cURL — Subscribe to real-time events via WebSocket
# First, establish a WebSocket connection:
# wss://explorer.example.com/api/graphql

# Then send the subscription:
curl -X POST https://explorer.example.com/api/graphql \\
  -H "Content-Type: application/json" \\
  -d '{
    "query": "subscription { eventEmitted(contract: \\"C...\\") { id eventType topicSymbol ledgerSequence } }"
  }'`,
};
