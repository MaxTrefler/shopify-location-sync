require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const { URLSearchParams } = require('url');

const app = express();

const SHOPIFY_SHOP = process.env.SHOPIFY_SHOP;
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const LOCATION_SOUL_DRUMS = process.env.LOCATION_SOUL_DRUMS;
const LOCATION_BACKORDER_WAREHOUSE = process.env.LOCATION_BACKORDER_WAREHOUSE;
const LOCATION_CUSTOM_ORDERS = process.env.LOCATION_CUSTOM_ORDERS;

app.use('/webhooks/inventory', express.raw({ type: 'application/json' }));
app.use(express.json());

let cachedToken = null;
let tokenExpiresAt = 0;

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiresAt - 60000) return cachedToken;

  const url = `https://${SHOPIFY_SHOP}.myshopify.com/admin/oauth/access_token`;
  console.log('Requesting token from:', url);
  console.log('CLIENT_ID:', CLIENT_ID ? CLIENT_ID.substring(0, 8) + '...' : 'MISSING');
  console.log('CLIENT_SECRET:', CLIENT_SECRET ? CLIENT_SECRET.substring(0, 8) + '...' : 'MISSING');

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });

  const responseText = await response.text();
  console.log('Token response status:', response.status);
  console.log('Token response body:', responseText);

  if (!response.ok) throw new Error('Token request failed: ' + response.status);

  const { access_token, expires_in } = JSON.parse(responseText);
  cachedToken = access_token;
  tokenExpiresAt = Date.now() + expires_in * 1000;
  console.log('Got fresh access token');
  return cachedToken;
}

async function updateMetafield(inventoryItemId) {
  try {
    const token = await getToken();

    const query = `query {
      inventoryItem(id: "gid://shopify/InventoryItem/${inventoryItemId}") {
        variant { id }
        inventoryLevels(first: 10) {
          edges {
            node {
              location { id }
              quantities(names: ["available"]) { quantity }
            }
          }
        }
      }
    }`;

    const gqlResponse = await fetch(
      `https://${SHOPIFY_SHOP}.myshopify.com/admin/api/2025-01/graphql.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': token
        },
        body: JSON.stringify({ query })
      }
    );

    const json = await gqlResponse.json();
    console.log('GraphQL response:', JSON.stringify(json));

    if (!json.data || !json.data.inventoryItem) {
      console.log('No inventory item in response');
      return;
    }

    const item = json.data.inventoryItem;
    const variantId = item.variant.id.split('/').pop();
    const levels = item.inventoryLevels.edges;

    const leadTimes = {
      soul_drums: 0,
      backorder_warehouse: 0,
      custom_orders: 0
    };

    levels.forEach(({ node }) => {
      const locId = node.location.id;
      const qty = node.quantities[0]?.quantity || 0;
      if (locId === LOCATION_SOUL_DRUMS) leadTimes.soul_drums = qty;
      if (locId === LOCATION_BACKORDER_WAREHOUSE) leadTimes.backorder_warehouse = qty;
      if (locId === LOCATION_CUSTOM_ORDERS) leadTimes.custom_orders = qty;
    });

    const metafieldRes = await fetch(
      `https://${SHOPIFY_SHOP}.myshopify.com/admin/api/2025-01/variants/${variantId}/metafields.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': token
        },
        body: JSON.stringify({
          metafield: {
            namespace: 'custom',
            key: 'location_lead_times',
            value: JSON.stringify(leadTimes),
            type: 'json'
          }
        })
      }
    );

    const metafieldJson = await metafieldRes.json();
    console.log('Metafield response:', JSON.stringify(metafieldJson));
    console.log('Updated variant', variantId, leadTimes);

  } catch (e) {
    console.error('Error updating metafield:', e);
  }
}

app.post('/webhooks/inventory', async (req, res) => {
  const hmac = req.get('X-Shopify-Hmac-Sha256');

  const calculated = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(req.body)
    .digest('base64');

  if (hmac !== calculated) {
    console.log('HMAC mismatch - unauthorized');
    return res.status(401).send('Unauthorized');
  }

  res.status(200).send('OK');

  let payload;
  try {
    payload = JSON.parse(req.body);
  } catch (e) {
    console.log('Test webhook - null body, skipping');
    return;
  }

  console.log('Webhook payload:', JSON.stringify(payload));

  if (!payload || !payload.inventory_item_id) {
    console.log('No inventory data in payload, skipping');
    return;
  }

  await updateMetafield(payload.inventory_item_id);
});

app.get('/', (req, res) => res.send('Location Sync LIVE'));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log('Listening on port ' + port));
