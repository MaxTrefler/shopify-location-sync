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

// The App Home Page (Inside Shopify Admin)
app.get('/', (req, res) => {
  // We explicitly tell Shopify exactly where to send the code
  const installUrl = `https://${SHOP}/admin/oauth/authorize?client_id=${CLIENT_ID}&scope=read_inventory,write_inventory,read_products,write_products&redirect_uri=${HOST}/auth/callback`;
  
  res.send(`
    <div style="font-family: sans-serif; padding: 40px; text-align: center;">
      <h2 style="color: #008060;">App is Running!</h2>
      <p>We just need to generate your permanent access token for Render.</p>
      <br><br>
      <a href="${installUrl}" target="_top" style="background: #008060; color: #fff; padding: 15px 30px; text-decoration: none; border-radius: 5px; font-weight: bold; font-size: 16px;">
        Generate Access Token
      </a>
    </div>
  `);
});

// The OAuth Callback (Where the button sends you)
app.get('/auth/callback', async (req, res) => {
  const code = req.query.code;
  
  if (!code) {
    return res.send('No authorization code provided by Shopify.');
  }

  try {
    const tokenResponse = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code: code })
    });

    const data = await tokenResponse.json();
    
    if (data.access_token) {
        return res.send(`
          <div style="font-family: sans-serif; padding: 40px; text-align: center;">
            <h1 style="color: #008060;">Success!</h1>
            <p>Please copy this permanent token and add it to your <b>Render Environment Variables</b> as <b>SHOPIFY_ACCESS_TOKEN</b>:</p>
            <h2 style="background: #f4f6f8; padding: 20px; border: 1px solid #dfe3e8; word-break: break-all; border-radius: 8px;">${data.access_token}</h2>
            <p>Once you save it in Render and Render restarts, your webhook will work perfectly.</p>
          </div>
        `);
    } else {
        return res.send('Failed to get token. Shopify response: ' + JSON.stringify(data));
    }
  } catch (error) {
    res.status(500).send('Error during installation: ' + error.message);
  }
});

// Your Webhook Handler
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
