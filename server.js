const express = require('express');
const crypto = require('crypto');

const app = express();

app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

const PORT = process.env.PORT || 10000;
const SHOP = process.env.SHOPIFY_SHOP;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;

// Catch the Custom App Install Redirect
app.get('/', async (req, res) => {
  const code = req.query.code;
  
  if (!code) {
    return res.send('Server is running! If you are trying to install, please use the Custom Distribution link from Shopify.');
  }

  try {
    const tokenResponse = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code: code })
    });

    const data = await tokenResponse.json();
    
    if (data.access_token) {
        console.log('\n\n=== COPY THIS TOKEN TO RENDER ENV VARS ===');
        console.log(data.access_token);
        console.log('==========================================\n\n');
        return res.send('App installed successfully! Check Render logs to copy your permanent token, then add it as SHOPIFY_ACCESS_TOKEN in Render Environment variables.');
    } else {
        return res.send('Failed to get token. Make sure you uninstalled the app first before clicking the link.');
    }
  } catch (error) {
    res.status(500).send('Error during installation');
  }
});

// The Webhook Handler
app.post('/webhooks/inventory_levels/update', async (req, res) => {
  const hmacHeader = req.header('X-Shopify-Hmac-Sha256');
  const generatedHash = crypto.createHmac('sha256', process.env.SHOPIFY_WEBHOOK_SECRET).update(req.rawBody).digest('base64');

  if (generatedHash !== hmacHeader) return res.status(401).send('Unauthorized');
  res.status(200).send('Webhook verified');
  
  const inventoryItemId = req.body.inventory_item_id;
  const locationId = req.body.location_id;
  const newAvailable = req.body.available;

  const locationKeyMap = {
    21795077: "soul_drums", 
    107670536466: "backorder_warehouse",
    107670864146: "custom_orders"
  };

  const locationKey = locationKeyMap[locationId];
  if (!locationKey) return console.log('Unmapped location.');

  try {
    const token = process.env.SHOPIFY_ACCESS_TOKEN; 
    if (!token) return console.error('MISSING SHOPIFY_ACCESS_TOKEN in Render Environment');

    const getVariantQuery = `query { inventoryItem(id: "gid://shopify/InventoryItem/${inventoryItemId}") { variant { id, metafield(namespace: "custom", key: "location_lead_times") { value } } } }`;

    const variantResponse = await fetch(`https://${SHOP}/admin/api/2026-01/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify({ query: getVariantQuery })
    });

    const variantData = await variantResponse.json();
    const variant = variantData.data?.inventoryItem?.variant;
    if (!variant) return console.log('No variant attached.');

    let currentLeadTimes = { "soul_drums": 0, "backorder_warehouse": 0, "custom_orders": 0 };

    if (variant.metafield && variant.metafield.value) {
      try { currentLeadTimes = JSON.parse(variant.metafield.value); } catch (e) {}
    }

    currentLeadTimes[locationKey] = newAvailable;
    
    const updateResponse = await fetch(`https://${SHOP}/admin/api/2026-01/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify({
        query: `mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $metafields) { userErrors { message } } }`,
        variables: { metafields: [{ ownerId: variant.id, namespace: "custom", key: "location_lead_times", type: "json", value: JSON.stringify(currentLeadTimes) }] }
      })
    });

    const updateResult = await updateResponse.json();
    if (updateResult.data?.metafieldsSet?.userErrors?.length > 0) console.error('Error:', updateResult.data.metafieldsSet.userErrors);
    else console.log('Successfully updated Variant Metafield! New data:', JSON.stringify(currentLeadTimes));

  } catch (error) {
    console.error('Webhook error:', error);
  }
});

app.listen(PORT, () => console.log(`Listening on ${PORT}`));
