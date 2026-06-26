import fetch from 'node-fetch'; // assuming node-fetch is available, or use native fetch if node 18+

async function runLoadTest() {
  const CONCURRENT_REQUESTS = 1000;
  const API_URL = process.env.API_URL || 'http://localhost:3000/api/v1/freeze/keys';

  console.log(`Starting load test with ${CONCURRENT_REQUESTS} concurrent requests to ${API_URL}...`);

  const start = Date.now();
  
  const requests = Array.from({ length: CONCURRENT_REQUESTS }, () => {
    return fetch(API_URL).then(res => res.status).catch(err => 'ERROR');
  });

  const results = await Promise.all(requests);
  const end = Date.now();

  const successCount = results.filter(r => r === 200).length;
  const errorCount = results.filter(r => r === 'ERROR').length;
  const otherCount = results.length - successCount - errorCount;

  console.log(`Load test completed in ${end - start} ms`);
  console.log(`Success (200 OK): ${successCount}`);
  console.log(`Errors (Network/Exception): ${errorCount}`);
  console.log(`Other Status Codes: ${otherCount}`);

  if (successCount === CONCURRENT_REQUESTS) {
    console.log('✅ Load test passed!');
  } else {
    console.error('❌ Load test failed. Not all requests succeeded.');
  }
}

// Only run directly
if (require.main === module) {
  runLoadTest();
}
