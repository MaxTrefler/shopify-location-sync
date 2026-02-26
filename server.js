require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');

const app = express();
app.use(bodyParser.json());

// Load from .env
const SHOPIFY_SHOP = process.env.SHOPIFY_SHOP;
const CLIENT_ID
