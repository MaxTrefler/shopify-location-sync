const express = require('express');
const Shopify = require('@shopify/shopify-api').default;
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 10000;

app.use(express.json());
app.use(express.raw({type: 'application/json'}));

// Shopify config
Shopify.Context.initialize({
  API_KEY: process.env.SHOPIFY_CLIENT_ID,
  API_SECRET_KEY: process.env.SHOPIFY_CLIENT_SECRET,
  SCOPES: process.env.SCOPES.split(','),
  HOST_NAME: process.env.HOST.replace(/https?:\/\//, ''),
  IS_EMBEDDED_APP: false,
  API_VERSION: '2026-01',
});

// OAuth - Start auth
app.get('/auth', async (req, res) => {
  console.log('OAuth auth start for shop:', req.query.shop);
  const authRoute = await Shopify.Auth.beginAuth(
    req,
    res,
    req.query.shop || process.env.SHOPIFY_SHOP,
    '/auth/callback',
    false // offline/permanent token
  );
});

// OAuth - Callback (stores token)
app.get('/auth/callback', async (req, res) => {
  try {
    const session = await Shopify.Auth.validateAuthCallback(req, res, req.query);
    const tokenPath = path.join(__dirname, 'token.txt');
    fs.writeFileSync(tokenPath, session.accessToken);
    console.log('Token saved:', session.accessToken.substring(0, 10) + '...');
    res.redirect('https://admin.shopify.com/store/soul-drums/apps/inventory-sync-49');
  } catch (error) {
    console.error('OAuth callback error:', error);
    res.status(500).send('Auth failed: ' + error.message);
  }
});

// Get stored token
function getToken() {
  const tokenPath = path.join(__dirname, 'token.txt');
  if (!fs.existsSync(tokenPath)) {
    throw new Error('No token - install app first via /auth');
  }
  return fs.readFileSync(tokenPath, 'utf8').trim();
}

// Webhook - Inventory update
app.post('/webhooks/inventories/update', async (req, res) => {
  console.log('Inventory webhook received');
  
  // Verify HMAC
  const hmac = req.get('X-Shopify-Hmac-Sha256');
  const calculatedHmac = crypto
    .createHmac('sha256', process.env.SHOPIFY_CLIENT_SECRET)
    .update(req.body, 'utf8')
    .digest('base64');
  
  if (hmac !== calculatedHmac) {
    console.error('Webhook HMAC failed');
    return res.status(401).send('Unauthorized');
  }
  
  const token = getToken();
  const inventory = JSON.parse(req.body);
  console.log('Inventory ID:', inventory.payload.inventory_item_id, 'Quantity:', inventory.payload.new_quantity);
  
  // Your sync logic (example: update metafield)
  try {
    const response = await fetch(`https://${process.env.SHOPIFY_SHOP}/admin/api/2026-01/products.json`, {
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json'
      }
    });
    console.log('API test OK:', response.status);
  } catch (error) {
    console.error('API error:', error);
  }
  
  res.status(200).send('OK');
});

// Health check
app.get('/', (req, res) => {
  res.send('Shopify Location Sync Ready. Install: /auth?shop=soul-drums.myshopify.com');
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  console.log('Install: https://shopify-location-sync.onrender.com/auth?shop=soul-drums.myshopify.com');
});
