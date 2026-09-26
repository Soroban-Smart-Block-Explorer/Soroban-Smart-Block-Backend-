// Tutorial 01: Get started
const base = process.env.BASE_URL ?? 'http://localhost:3000';
const headers = process.env.API_KEY ? { 'x-api-key': process.env.API_KEY } : {};
const res = await fetch(`${base}/health`, { headers });
if (!res.ok) {
  console.error(`Request failed: ${res.status} ${res.statusText}`);
  process.exit(1);
}
console.log(JSON.stringify(await res.json(), null, 2));
