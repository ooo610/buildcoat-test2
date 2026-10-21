import admin from 'firebase-admin';

if (!admin.apps.length) {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
  if (!projectId || !clientEmail || !privateKey) {
    throw new Error('Firebase Admin credentials are not configured.');
  }
  admin.initializeApp({
    credential: admin.credential.cert({ projectId, clientEmail, privateKey })
  });
}

export const db = admin.firestore();
export const auth = admin.auth();
export const FieldValue = admin.firestore.FieldValue;

export function setApiHeaders(req, res) {
  const allowedOrigins = new Set([
    'https://ooo610.github.io',
    'https://buildcoat-test2.vercel.app'
  ]);
  const origin = req.headers.origin;
  if (origin && allowedOrigins.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Cache-Control', 'no-store');
}

export function json(res, status, body) {
  return res.status(status).json(body);
}

export async function getPriceRecords(productId, governorateId) {
  const [productSnapshot, governorateSnapshot] = await Promise.all([
    db.collection('inventorycms').doc(productId).get(),
    db.collection('shippingPrices').doc(governorateId).get()
  ]);
  if (!productSnapshot.exists) return { error: 'PRODUCT_NOT_FOUND' };
  if (!governorateSnapshot.exists) return { error: 'GOVERNORATE_NOT_FOUND' };
  const product = productSnapshot.data();
  const governorate = governorateSnapshot.data();
  if (product.active === false) return { error: 'PRODUCT_INACTIVE' };
  if (governorate.active === false) return { error: 'GOVERNORATE_INACTIVE' };
  const unitPrice = Number(product.unitPrice);
  const shippingCost = Number(governorate.shippingCost);
  if (!Number.isFinite(unitPrice) || unitPrice < 0 || !Number.isFinite(shippingCost) || shippingCost < 0) {
    return { error: 'PRICE_DATA_INVALID' };
  }
  return { product, governorate, unitPrice, shippingCost };
}

export function getQuantity(value) {
  const quantity = Number(value);
  return Number.isSafeInteger(quantity) && quantity > 0 ? quantity : null;
}
