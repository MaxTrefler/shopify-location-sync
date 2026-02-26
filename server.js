require('dotenv').config();
const express = require('express');
const crypto = require('crypto');

const app = express();

const SHOPIFY_SHOP = process.env.SHOPIFY_SHOP;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const LOCATION_SOUL_DRUMS = process.env.LOCATION_SOUL_DRUMS;
const LOCATION_BACKORDER_WAREHOUSE = process.env.LOCATION_BACKORDER_WAREHOUSE;
const LOCATION_CUSTOM_ORDERS = process.env.LOCATION_CUSTOM_ORDERS;

app.use('/webhooks/inventory', express.raw({ type: 'application/json' }));
app.use(express.json());

async function updateMetafield(inventoryItemId) {
  try {
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

    const gqlResponse = await fetch(`https://${SHOPIFY_SHOP}/admin/api/2025-01/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': ACCESS_TOKEN
      },
      body: JSON.stringify({ query })
    });

    const { data } = await gqlResponse.json();
    const item = data.inventoryItem;
    const variantGid = item.variant.id;
    const variantId = variantGid.split('/').pop();
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

    await fetch(`https://${SHOPIFY_SHOP}/admin/api/2025-01/variants/${variantId}/metafields.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': ACCESS_TOKEN
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

  const { inventory_item_id } = payload;
  if (inventory_item_id) {
    await updateMetafield(inventory_item_id);
  }
});

app.get('/', (req, res) => res.send('Location Sync LIVE'));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log('Listening on port ' + port));
