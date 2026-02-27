const express = require('express');
const crypto = require('crypto');
const fs = require('fs');

const app = express();

// This allows us to capture the raw body needed for Shopify HMAC verification
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
    res.send('App installed successfully! Token saved. You can close this window and set up your webhook in Shopify Admin.');
  } catch (error) {
    console.error(error);
    res.status(500).send('Error getting access token');
  }
});

// Step 3: Webhook Route
app.post('/webhooks/inventory_levels/update', (req, res) => {
  const hmacHeader = req.header('X-Shopify-Hmac-Sha256');
  
  // Verify Webhook matches your app
  const generatedHash = crypto
    .createHmac('sha256', SHOPIFY_WEBHOOK_SECRET)
    .update(req.rawBody)
    .digest('base64');

  if (generatedHash !== hmacHeader) {
    console.log('Webhook verification failed');
    return res.status(401).send('Unauthorized');
  }
  
  console.log('Webhook verified! Inventory Data:', req.body);
  
  // Here is where you will use your saved token to do whatever API calls you need later
  // const token = fs.readFileSync('token.txt', 'utf8');

  res.status(200).send('Webhook processed successfully');
});

// Health check
app.get('/', (req, res) => {
  res.send('Server is running! To install, go to: ' + HOST + '/auth');
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
