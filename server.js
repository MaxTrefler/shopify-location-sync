const express = require('express');
const crypto = require('crypto');
const fs = require('fs');

const app = express();

// This captures the raw body needed for Shopify HMAC verification
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

const PORT = process.env.PORT || 10000;
const SHOP = process.env.SHOPIFY_SHOP;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const HOST = process.env.HOST;

// Step 1: Install Route
app.get('/auth', (req, res) => {
  const authUrl = `https://${SHOP}/admin/oauth/authorize?client_id=${CLIENT_ID}&scope=${process.env.SCOPES}&redirect_uri=${HOST}/auth/callback`;
  res.redirect(authUrl);
});

// Step 2: Callback Route (Saves the permanent token)
app.get('/auth/callback', async (req, res) => {
  const code = req.query.code;
  
  if (!code) {
    return res.status(400).send('No authorization code provided.');
  }

  try {
    const tokenResponse = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code: code
      })
    });

    const data = await tokenResponse.json();
    
    // Save token locally
    fs.writeFileSync('token.txt', data.access_token);
    res.send('App installed successfully! Token saved. You can close this window.');
  } catch (error) {
    console.error(error);
    res.status(500).send('Error getting access token');
  }
});

// Step 3: Webhook Route for Inventory Updates
app.post('/webhooks/inventory_levels/update', async (req, res) => {
  const hmacHeader = req.header('X-Shopify-Hmac-Sha256');
  
  // Verify Webhook matches your app using the STORE WEBHOOK SECRET
  const generatedHash = crypto
    .createHmac('sha256', process.env.SHOPIFY_WEBHOOK_SECRET)
    .update(req.rawBody)
    .digest('base64');

  if (generatedHash !== hmacHeader) {
    console.log('Webhook verification failed');
    return res.status(401).send('Unauthorized');
  }
  
  // Always respond 200 OK immediately so Shopify doesn't timeout the webhook
  res.status(200).send('Webhook verified');
  
  const inventoryData = req.body;
  const inventoryItemId = inventoryData.inventory_item_id;
  const locationId = inventoryData.location_id;
  const newAvailable = inventoryData.available;

  console.log(`Processing inventory update for Item ID: ${inventoryItemId} at Location: ${locationId}`);

  // Map your Shopify Location IDs to your JSON keys
  // Note: 107670864146 is soul_drums based on your previous logs
  const locationKeyMap = {
    21795077: "soul_drums",
    107670536466: "backorder_warehouse",
    107670864146: "custom_orders"
  };

  const locationKey = locationKeyMap[locationId];
  if (!locationKey) {
    console.log('Update for an unmapped location. Ignoring.');
    return;
  }

  try {
    const token = fs.readFileSync('token.txt', 'utf8');

    // 1. Get Variant ID from Inventory Item ID & get current Metafield
    const getVariantQuery = `
      query {
        inventoryItem(id: "gid://shopify/InventoryItem/${inventoryItemId}") {
          variant {
            id
            metafield(namespace: "custom", key: "location_lead_times") {
              value
            }
          }
        }
      }
    `;

    const variantResponse = await fetch(`https://${SHOP}/admin/api/2026-01/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token
      },
      body: JSON.stringify({ query: getVariantQuery })
    });

    const variantData = await variantResponse.json();
    const variant = variantData.data?.inventoryItem?.variant;

    if (!variant) {
      console.log('No variant attached to this inventory item.');
      return;
    }

    const variantId = variant.id;
    
    // Default fallback if no metafield exists yet
    let currentLeadTimes = {
      "soul_drums": 0,
      "backorder_warehouse": 0,
      "custom_orders": 0
    };

    // If the metafield already exists, parse its current data so we don't overwrite it
    if (variant.metafield && variant.metafield.value) {
      try {
        currentLeadTimes = JSON.parse(variant.metafield.value);
      } catch (e) {
        console.log('Error parsing current metafield data, starting fresh.');
      }
    }

    // 2. Update ONLY the specific location's inventory count in the JSON object
    currentLeadTimes[locationKey] = newAvailable;
    const newMetafieldString = JSON.stringify(currentLeadTimes);

    // 3. Save the new JSON string back to the Variant Metafield
    const updateMetafieldMutation = `
      mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields {
            key
            value
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const updateVariables = {
      metafields: [
        {
          ownerId: variantId,
          namespace: "custom",
          key: "location_lead_times",
          type: "json", 
          value: newMetafieldString
        }
      ]
    };

    const updateResponse = await fetch(`https://${SHOP}/admin/api/2026-01/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token
      },
      body: JSON.stringify({
        query: updateMetafieldMutation,
        variables: updateVariables
      })
    });

    const updateResult = await updateResponse.json();
    
    if (updateResult.data?.metafieldsSet?.userErrors?.length > 0) {
      console.error('Metafield update error:', updateResult.data.metafieldsSet.userErrors);
    } else {
      console.log('Successfully updated Variant Metafield! New data:', newMetafieldString);
    }

  } catch (error) {
    console.error('Error during webhook processing:', error);
  }
});

// Health check
app.get('/', (req, res) => {
  res.send('Server is running! To install, go to: ' + HOST + '/auth');
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
