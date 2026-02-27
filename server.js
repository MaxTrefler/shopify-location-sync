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

// This function processes the line of updates one by one
async function processQueue() {
  if (isProcessing) return; // Prevent multiple processing loops
  isProcessing = true;

  while (inventoryQueue.length > 0) {
    const job = inventoryQueue.shift(); // Grab the first item in line
    try {
      await processInventoryUpdate(job.inventoryItemId, job.locationId, job.newAvailable);
      
      // Wait 500 milliseconds (0.5 seconds) before processing the next one. 
      // This keeps us safely below Shopify's GraphQL API rate limit of 50 points/sec!
      await new Promise(resolve => setTimeout(resolve, 500)); 
    } catch (error) {
      console.error(`Error processing job for item ${job.inventoryItemId}:`, error.message);
    }
  }

  isProcessing = false; // Line is empty, go back to sleep
}

// The actual API logic (moved into a separate function)
async function processInventoryUpdate(inventoryItemId, locationId, newAvailable) {
  const locationKeyMap = {
    21795077: "soul_drums", 
    107670536466: "backorder_warehouse",
    107670864146: "custom_orders"
  };

  const locationKey = locationKeyMap[locationId];
  if (!locationKey) return console.log('Unmapped location ignored.');

  const token = process.env.SHOPIFY_ACCESS_TOKEN; 
  if (!token) throw new Error('MISSING SHOPIFY_ACCESS_TOKEN in Render Environment');

  // 1. Get the Variant ID and current metafields
  const getVariantQuery = `query { inventoryItem(id: "gid://shopify/InventoryItem/${inventoryItemId}") { variant { id, metafield(namespace: "custom", key: "location_lead_times") { value } } } }`;

  const variantResponse = await fetch(`https://${SHOP}/admin/api/2026-01/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query: getVariantQuery })
  });

  const variantData = await variantResponse.json();
  const variant = variantData.data?.inventoryItem?.variant;
  if (!variant) return console.log(`No variant attached to Inventory Item ${inventoryItemId}.`);

  let currentLeadTimes = { "soul_drums": 0, "backorder_warehouse": 0, "custom_orders": 0 };

  if (variant.metafield && variant.metafield.value) {
    try { currentLeadTimes = JSON.parse(variant.metafield.value); } catch (e) {}
  }

  // Update the specific location's inventory count
  currentLeadTimes[locationKey] = newAvailable;
  
  // 2. Write the new JSON object back to the Metafield
  const updateResponse = await fetch(`https://${SHOP}/admin/api/2026-01/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({
      query: `mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $metafields) { userErrors { message } } }`,
      variables: { metafields: [{ ownerId: variant.id, namespace: "custom", key: "location_lead_times", type: "json", value: JSON.stringify(currentLeadTimes) }] }
    })
  });

  const updateResult = await updateResponse.json();
  if (updateResult.data?.metafieldsSet?.userErrors?.length > 0) {
      console.error('GraphQL Error updating Metafield:', updateResult.data.metafieldsSet.userErrors);
  } else {
      console.log(`Successfully updated Variant ${variant.id}! New data:`, JSON.stringify(currentLeadTimes));
  }
}

// --- THE WEBHOOK HANDLER ---
app.post('/webhooks/inventory_levels/update', async (req, res) => {
  // 1. Verify the webhook is actually from Shopify
  const hmacHeader = req.header('X-Shopify-Hmac-Sha256');
  const generatedHash = crypto.createHmac('sha256', process.env.SHOPIFY_WEBHOOK_SECRET).update(req.rawBody).digest('base64');
  if (generatedHash !== hmacHeader) return res.status(401).send('Unauthorized');
  
  // 2. IMMEDIATELY tell Shopify "We got it!" so they don't timeout
  res.status(200).send('Webhook received');
  
  // 3. Add the data to our background queue
  inventoryQueue.push({
    inventoryItemId: req.body.inventory_item_id,
    locationId: req.body.location_id,
    newAvailable: req.body.available
  });

  // 4. Start processing the queue (if it isn't already running)
  processQueue();
});

// --- AUTH ROUTES (Keep these just in case you ever need to reinstall) ---
app.get('/', (req, res) => {
  const installUrl = `https://${SHOP}/admin/oauth/authorize?client_id=${CLIENT_ID}&scope=read_inventory,write_inventory,read_products,write_products&redirect_uri=${HOST}/auth/callback`;
  res.send(`<div style="font-family: sans-serif; padding: 40px; text-align: center;"><h2 style="color: #008060;">App is Running!</h2><p>Your webhooks are active.</p><br><br><a href="${installUrl}" target="_top" style="background: #008060; color: #fff; padding: 15px 30px; text-decoration: none; border-radius: 5px; font-weight: bold;">Regenerate Access Token</a></div>`);
});

app.get('/auth/callback', async (req, res) => { /* Kept brief, same as before */ });

app.listen(PORT, () => console.log(`Listening on ${PORT}`));
