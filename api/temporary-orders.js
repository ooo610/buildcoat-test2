import { createHash } from 'node:crypto';
import { auth, db, FieldValue, getPriceRecords, getQuantity, json, setApiHeaders } from '../server/firebase-admin.js';

const TEMP_ORDER_TTL_MS = 30 * 60 * 1000;
const clean = (value, limit) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
const amount = value => Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;

async function verifyUser(req) {
  const token = (req.headers.authorization || '').startsWith('Bearer ') ? req.headers.authorization.slice(7).trim() : '';
  if (!token) return null;
  try { return await auth.verifyIdToken(token); } catch { return null; }
}

export default async function handler(req, res) {
  setApiHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return json(res, 405, { success: false, code: 'METHOD_NOT_ALLOWED' });
  const user = await verifyUser(req);
  if (!user) return json(res, 401, { success: false, code: 'AUTH_REQUIRED', error: 'Sign in to continue.' });

  const body = req.body || {};
  const productId = clean(body.productId, 150);
  const colorId = clean(body.colorId, 150);
  const governorateId = clean(body.governorateId, 150);
  const quantity = getQuantity(body.quantity);
  const city = clean(body.city, 120);
  const address = clean(body.address, 500);
  const locale = body.locale === 'ar' ? 'ar' : 'en';
  const idempotencyKey = clean(req.headers['idempotency-key'], 100);
  const expected = { cost: amount(body.quote?.cost), shippingCost: amount(body.quote?.shippingCost), totalCost: amount(body.quote?.totalCost) };
  if (!productId || !colorId || !governorateId || !quantity || city.length < 2 || address.length < 5 ||
      !/^[A-Za-z0-9_-]{12,100}$/.test(idempotencyKey) || Object.values(expected).some(value => value === null)) {
    return json(res, 400, { success: false, code: 'INVALID_INPUT', error: 'Complete all required order details with a valid quantity and price.' });
  }

  try {
    const [records, colorSnapshot] = await Promise.all([
      getPriceRecords(productId, governorateId), db.collection('colorPalettecms').doc(colorId).get()
    ]);
    if (records.error) return json(res, 422, { success: false, code: records.error, error: 'The selected product or delivery area is unavailable.' });
    if (!colorSnapshot.exists) return json(res, 422, { success: false, code: 'COLOR_NOT_FOUND', error: 'The selected color is no longer available.' });
    const cost = records.unitPrice * quantity;
    const shippingCost = records.shippingCost;
    const totalCost = cost + shippingCost;
    const price = { cost, shippingCost, totalCost, currency: 'EGP' };
    if (expected.cost !== cost || expected.shippingCost !== shippingCost || expected.totalCost !== totalCost) {
      return json(res, 409, { success: false, code: 'PRICE_CHANGED', error: 'The price changed. Review the updated total and continue again.', price });
    }

    const hash = createHash('sha256').update(`${user.uid}:${idempotencyKey}`).digest('hex');
    const tempRef = db.collection('temporaryOrders').doc(hash);
    const prior = await tempRef.get();
    if (prior.exists) {
      const data = prior.data();
      if (data.customer?.uid !== user.uid || data.idempotencyKey !== idempotencyKey) return json(res, 409, { success: false, code: 'IDEMPOTENCY_CONFLICT' });
      if (data.expiresAt?.toMillis?.() <= Date.now()) return json(res, 410, { success: false, code: 'ORDER_EXPIRED', error: 'This temporary order has expired.' });
      return json(res, 200, { success: true, temporaryOrderId: tempRef.id, expiresAt: data.expiresAt.toMillis(), price });
    }

    const productName = locale === 'ar' ? records.product.name_ar : records.product.name_en;
    const governorateName = locale === 'ar' ? records.governorate.nameAr : records.governorate.nameEn;
    const color = colorSnapshot.data();
    const order = {
      address, city,
      color: { colorCode: color.colorCode ?? null, colorName: color.colorName || '', colorNameAR: color.colorNameAR || '', img: color.img || '', colorId },
      cost, createdAt: FieldValue.serverTimestamp(), expiresAt: new Date(Date.now() + TEMP_ORDER_TTL_MS), currency: 'EGP',
      customer: { email: user.email || '', name: user.name || '', uid: user.uid },
      governorateId, governorateName: typeof governorateName === 'string' ? governorateName : '',
      idempotencyKey, locale, productId, productName: typeof productName === 'string' ? productName : '',
      quantity, shippingCost, source: 'website', status: 'awaiting-payment', totalCost, unitPrice: records.unitPrice
    };
    await tempRef.create(order);
    return json(res, 201, { success: true, temporaryOrderId: tempRef.id, expiresAt: Date.now() + TEMP_ORDER_TTL_MS, price });
  } catch (error) {
    console.error('Temporary order creation failed:', error);
    return json(res, 500, { success: false, code: 'TEMPORARY_ORDER_FAILED', error: 'Could not prepare your order. Please try again.' });
  }
}
