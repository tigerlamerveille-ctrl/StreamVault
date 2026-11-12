const express = require('express');
const cors = require('cors');

const app = express();
app.use(express.json({ limit: '32kb' }));
app.use(cors({
  origin: ['https://streamvault-3g9p.onrender.com'],
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type']
}));

const PORT = process.env.PORT || 10000;
const SITE_URL = 'https://streamvault-3g9p.onrender.com';
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const PAYPAL_MODE = (process.env.PAYPAL_MODE || 'live').toLowerCase();
const PAYPAL_API = PAYPAL_MODE === 'sandbox'
  ? 'https://api-m.sandbox.paypal.com'
  : 'https://api-m.paypal.com';

const CATALOG = {
  'netflix': { title: 'Netflix Ultra HD 4K', prices: { '6 mois': 10000, '1 an': 15000 } },
  'iptv-premium': { title: 'IPTV 4K +10 000 Chaînes', prices: { '6 mois': 15000, '1 an': 20000 } },
  'prime-video': { title: 'Amazon Prime Video 4K', prices: { '6 mois': 10000, '1 an': 15000 } }
};

function paypalReady() {
  return Boolean(PAYPAL_CLIENT_ID && PAYPAL_CLIENT_SECRET);
}

async function getAccessToken() {
  if (!paypalReady()) {
    const error = new Error('Les identifiants PayPal ne sont pas configurés sur le serveur.');
    error.status = 503;
    throw error;
  }
  const auth = Buffer.from(PAYPAL_CLIENT_ID + ':' + PAYPAL_CLIENT_SECRET).toString('base64');
  const response = await fetch(PAYPAL_API + '/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + auth,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  const data = await response.json();
  if (!response.ok || !data.access_token) {
    const error = new Error('PayPal refuse les identifiants API. Vérifie les clés Live.');
    error.status = 502;
    throw error;
  }
  return data.access_token;
}

function calculateOrder(items, currency) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 10) {
    const error = new Error('Panier invalide.');
    error.status = 400;
    throw error;
  }
  let totalXOF = 0;
  const lines = [];
  for (const item of items) {
    const product = CATALOG[item.productId];
    const quantity = Number(item.quantity);
    const price = product && product.prices[item.duration];
    if (!product || !price || !Number.isInteger(quantity) || quantity < 1 || quantity > 5) {
      const error = new Error('Un article du panier est invalide.');
      error.status = 400;
      throw error;
    }
    totalXOF += price * quantity;
    lines.push({ name: product.title + ' - ' + item.duration, quantity: String(quantity) });
  }

  // PayPal ne prend pas en charge le XOF dans tous les comptes marchands.
  // Pour un panier affiché en FCFA, le montant est converti en EUR.
  let amount;
  let paypalCurrency;
  if (currency === 'USD') {
    paypalCurrency = 'USD';
    amount = (totalXOF / 605).toFixed(2);
  } else {
    paypalCurrency = 'EUR';
    amount = (totalXOF / 655.957).toFixed(2);
  }
  return { amount, currency: paypalCurrency, lines };
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', paypalConfigured: paypalReady(), mode: PAYPAL_MODE });
});

app.post('/api/paypal/create-order', async (req, res) => {
  try {
    const contact = String(req.body.contact || '').trim().slice(0, 120);
    if (!contact) return res.status(400).json({ error: 'Indique ton nom et ton contact.' });

    const order = calculateOrder(req.body.items, req.body.currency);
    const accessToken = await getAccessToken();
    const response = await fetch(PAYPAL_API + '/v2/checkout/orders', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + accessToken,
        'Content-Type': 'application/json',
        'PayPal-Request-Id': require('crypto').randomUUID()
      },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{
          description: 'Commande StreamVault',
          custom_id: 'STREAMVAULT',
          invoice_id: 'SV-' + Date.now(),
          items: order.lines.map(line => ({
            name: line.name,
            quantity: line.quantity,
            unit_amount: { currency_code: order.currency, value: order.amount }
          })).slice(0, 1),
          amount: {
            currency_code: order.currency,
            value: order.amount
          }
        }],
        application_context: {
          brand_name: 'StreamVault',
          user_action: 'PAY_NOW',
          shipping_preference: 'NO_SHIPPING',
          return_url: SITE_URL + '/?paypal=success',
          cancel_url: SITE_URL + '/?paypal=cancel'
        }
      })
    });
    const data = await response.json();
    if (!response.ok) {
      console.error('PayPal create order error:', JSON.stringify(data));
      return res.status(502).json({ error: 'Impossible de créer le paiement PayPal pour le moment.' });
    }
    const approval = (data.links || []).find(link => link.rel === 'approve');
    if (!approval) return res.status(502).json({ error: 'PayPal n’a pas fourni de lien de paiement.' });
    res.json({ orderId: data.id, approvalUrl: approval.href, currency: order.currency, amount: order.amount });
  } catch (error) {
    console.error('Create order:', error.message);
    res.status(error.status || 500).json({ error: error.message || 'Erreur lors de la création du paiement.' });
  }
});

app.post('/api/paypal/capture-order', async (req, res) => {
  try {
    const orderId = String(req.body.orderId || '').trim();
    if (!/^\w{10,40}$/.test(orderId)) return res.status(400).json({ error: 'Référence PayPal invalide.' });
    const accessToken = await getAccessToken();
    const response = await fetch(PAYPAL_API + '/v2/checkout/orders/' + encodeURIComponent(orderId) + '/capture', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + accessToken,
        'Content-Type': 'application/json',
        'PayPal-Request-Id': 'capture-' + orderId
      },
      body: '{}'
    });
    const data = await response.json();
    if (!response.ok && data.status !== 'COMPLETED') {
      console.error('PayPal capture error:', JSON.stringify(data));
      return res.status(502).json({ error: 'Le paiement PayPal n’a pas pu être confirmé.' });
    }
    const capture = data.purchase_units?.[0]?.payments?.captures?.[0];
    if (data.status !== 'COMPLETED' || capture?.status !== 'COMPLETED') {
      return res.status(402).json({ error: 'Le paiement n’est pas confirmé.' });
    }
    res.json({
      status: 'COMPLETED',
      orderId: data.id,
      captureId: capture.id,
      amount: capture.amount?.value,
      currency: capture.amount?.currency_code
    });
  } catch (error) {
    console.error('Capture order:', error.message);
    res.status(error.status || 500).json({ error: error.message || 'Erreur lors de la vérification du paiement.' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('StreamVault PayPal API listening on port ' + PORT);
});
