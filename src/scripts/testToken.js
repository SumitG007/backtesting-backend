require('dotenv').config();
const axios = require('axios');

const baseUrl = process.env.DHAN_API_BASE_URL || 'https://api.dhan.co/v2';
const clientId = process.env.DHAN_CLIENT_ID;
const accessToken = process.env.DHAN_ACCESS_TOKEN;

function fail(message, details) {
  console.error(`Token test failed: ${message}`);
  if (details) {
    console.error(details);
  }
  process.exit(1);
}

async function testDhanToken() {
  if (!clientId) {
    fail('DHAN_CLIENT_ID is missing in .env');
  }
  if (!accessToken) {
    fail('DHAN_ACCESS_TOKEN is missing in .env');
  }

  const url = `${baseUrl}/profile`;
  try {
    const response = await axios.get(url, {
      headers: {
        'access-token': accessToken,
        'client-id': clientId,
      },
      timeout: 10000,
    });

    console.log('Token is valid.');
    console.log(`Status: ${response.status}`);
    console.log(`Client ID: ${clientId}`);
    if (response.data && typeof response.data === 'object') {
      const keys = Object.keys(response.data);
      console.log(`Response keys: ${keys.join(', ')}`);
    }
  } catch (error) {
    if (error.response) {
      fail(
        `HTTP ${error.response.status} from Dhan profile endpoint`,
        `Response: ${JSON.stringify(error.response.data)}`
      );
    }
    fail(error.message);
  }
}

testDhanToken();
