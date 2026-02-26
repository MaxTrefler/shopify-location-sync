require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');

const app = express();
app.use(bodyParser.json());

const SHOPIFY_SHOP = process.env.SHOPIFY_SHOP;
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const LOCATION_SOUL_DRUMS = process.env.LOCATION_SOUL_DRUMS;
const LOCATION_BACKORDER_WAREHOUSE = process.env.LOCATION_BACKORDER_WAREHOUSE;
const LOCATION_CUSTOM_ORDERS = process.env.LOCATION_CUSTOM_ORDERS;

async function getAccessToken() {
  const response = await fetch(`https://${SHOPIFY_SHOP}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'client_credentials'
    })
  });
  const data = await response.json();
  return data.access_token;
}

async function updateMetafield(variantId, inventoryItemId) {
  try {
    const token = await getAccessToken();

    const query = `query {
      inventoryItem(id: "gid://shopify/InventoryItem/${inventoryItemId}") {
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

    const gqlResponse = await fetch(`https://${SHOPIFY_SHOP}/admin/api/2026-01/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token
      },
      body: JSON.stringify({ query })
    });

    const { data } = await gqlResponse.json();
    const levels = data.inventoryItem.inventoryLevels.edges;

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

    await fetch(`https://${SHOPIFY_SHOP}/admin/api/2026-01/variants/${variantId}/metafields.json`, {
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
    });

    console.log('Updated variant', variantId, leadTimes);

  } catch (e) {
    console.error('Error:', e);
  }
}

app.post('/webhooks/inventory', async (req, res) => {
  const hmac = req.get('X-Shopify-Hmac-Sha256');
  const body = JSON.stringify(req.body);
  const calculated = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(body, 'utf8')
    .digest('base64');

  if (hmac !== calculated) {
    return res.status(401).send('Unauthorized');
  }

  res.status(200).send('OK');

  const { inventory_item_id, variant_id } = req.body;
  if (variant_id && inventory_item_id) {
    await updateMetafield(variant_id, inventory_item_id);
  }
});

app.get('/', (req, res) => res.send('🚀 Location Sync LIVE'));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on port ${port}`));
