require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });
const axios = require('axios');
const mongoose = require('mongoose');
const DhanTokenCache = require('../models/DhanTokenCache');

const baseUrl = process.env.DHAN_API_BASE_URL || 'https://api.dhan.co/v2';

function fail(message, details) {
  console.error(`Token test failed: ${message}`);
  if (details) console.error(details);
  process.exit(1);
}

async function main() {
  let accessToken = String(process.env.DHAN_ACCESS_TOKEN || '').trim();
  let clientId = String(process.env.DHAN_CLIENT_ID || '').trim();

  const uri = process.env.MONGODB_URI;
  if (uri && (!accessToken || !clientId)) {
    await mongoose.connect(uri);
    try {
      const doc = await DhanTokenCache.findOne({ key: 'singleton' }).lean();
      if (!accessToken) accessToken = String(doc?.accessToken || '').trim();
      if (!clientId) clientId = String(doc?.dhanClientId || '').trim();
    } finally {
      await mongoose.disconnect();
    }
  }

  if (!clientId) fail('DHAN_CLIENT_ID is missing in .env and not stored in Mongo.');
  if (!accessToken) {
    fail(
      'No JWT: use JWT stored in Mongo (POST /api/dhan/access-token) or set DHAN_ACCESS_TOKEN temporarily for this script.'
    );
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

main();
