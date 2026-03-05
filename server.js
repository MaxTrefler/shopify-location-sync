const express = require('express');
const crypto = require('crypto');

const app = express();
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

const PORT = process.env.PORT || 10000;
const SHOP = process.env.SHOPIFY_SHOP || 'soul-drums.myshopify.com';
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const HOST = 'https://shopify-location-sync.onrender.com';

// --- BACKGROUND QUEUE SYSTEM ---
const inventoryQueue = [];
let isProcessing = false;

// Full refresh: Fetch ALL locations every time, overwrite metafield
async function processInventoryUpdate(inventoryItemId, locationId, newAvailable) {
  const token = process.env.SHOPIFY_ACCESS_TOKEN; 
  if (!token) throw new Error('MISSING SHOPIFY_ACCESS_TOKEN');

  // 1. GraphQL: Get variant + ALL inventory levels across locations
  const query = `
    query getInventory($inventoryItemId: ID!) {
      inventoryItem(id: $inventoryItemId) {
        id
        inventoryLevels(first: 10) {
          edges {
            node {
              id
              location {
                id
                legacyResourceId
              }
              quantities(names: ["available"]) {
                name
                quantity
              }
            }
          }
        }
      }
    }
  `;

  const response = await fetch(`https://${SHOP}/admin/api/2026-01/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables: { inventoryItemId: `gid://shopify/InventoryItem/${inventoryItemId}` } })
  });

  const data = await response.json();
  const item = data.data?.inventoryItem;
  if (!item) return console.log(`No inventory data for item ${inventoryItemId}`);

  // Extract variant ID
  const variantId = item.inventoryLevels.edges[0]?.node.id.split('/')[3];

  // Build complete snapshot
  const leadTimes = { soul_drums: 0, backorder_warehouse: 0, custom_orders: 0 };
  for (const edge of item.inventoryLevels.edges) {
    const locId = edge.node.location.legacyResourceId;
    const available = edge.node.quantities.find(q => q.name === 'available')?.quantity || 0;
    if (locId == '21795077') leadTimes.soul_drums = available;
    if (locId == '107670536466') leadTimes.backorder_warehouse = available;
    if (locId == '107670864146') leadTimes.custom_orders = available;
  }

  // 2. ALWAYS overwrite metafield with full current state
  const updateResponse = await fetch(`https://${SHOP}/admin/api/2026-01/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({
      query: `mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $metafields) { userErrors { message } } }`,
      variables: { metafields: [{ 
        ownerId: `gid://shopify/ProductVariant/${variantId}`, 
        namespace: "custom", 
        key: "location_lead_times", 
        type: "json", 
        value: JSON.stringify(leadTimes) 
      }] }
    })
  });

  const updateResult = await updateResponse.json();
  if (updateResult.data?.metafieldsSet?.userErrors?.length > 0) {
    console.error('Error:', updateResult.data.metafieldsSet.userErrors);
  } else {
    console.log(`✅ Full sync variant ${variantId}:`, leadTimes);
  }
}

// This function processes the line of updates one by one
async function processQueue() {
  if (isProcessing) return;
  isProcessing = true;

  while (inventoryQueue.length > 0) {
    const job = inventoryQueue.shift();
    try {
      await processInventoryUpdate(job.inventoryItemId, job.locationId, job.newAvailable);
      await new Promise(resolve => setTimeout(resolve, 500)); 
    } catch (error) {
      console.error(`Error processing job for item ${job.inventoryItemId}:`, error.message);
    }
  }

  isProcessing = false;
}

// --- WEBHOOK HANDLER (Triggers full refresh every time) ---
app.post('/webhooks/inventory_levels/update', async (req, res) => {
  // Verify Shopify
  const hmacHeader = req.header('X-Shopify-Hmac-Sha256');
  const generatedHash = crypto.createHmac('sha256', process.env.SHOPIFY_WEBHOOK_SECRET).update(req.rawBody).digest('base64');
  if (generatedHash !== hmacHeader) return res.status(401).send('Unauthorized');
  
  res.status(200).send('OK');  // Respond instantly
  
  // Queue the full refresh
  inventoryQueue.push({
    inventoryItemId: req.body.inventory_item_id,
    locationId: req.body.location_id,
    newAvailable: req.body.available
  });
  processQueue();
});

// --- AUTH ROUTES ---
app.get('/', (req, res) => {
  const installUrl = `https://${SHOP}/admin/oauth/authorize?client_id=${CLIENT_ID}&scope=read_inventory,write_inventory,read_products,write_products&redirect_uri=${HOST}/auth/callback`;
  res.send(`<div style="font-family: sans-serif; padding: 40px; text-align: center;"><h2 style="color: #008060;">App is Running!</h2><p>Your webhooks are active.</p><br><br><a href="${installUrl}" target="_top" style="background: #008060; color: #fff; padding: 15px 30px; text-decoration: none; border-radius: 5px; font-weight: bold;">Regenerate Access Token</a></div>`);
});

app.get('/auth/callback', async (req, res) => { /* Kept brief, same as before */ });

app.listen(PORT, () => console.log(`Listening on ${PORT}`));
