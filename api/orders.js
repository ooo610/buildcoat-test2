import { createHash } from 'node:crypto';
import { auth, db, FieldValue, getPriceRecords, getQuantity, json, setApiHeaders } from '../server/firebase-admin.js';

function cleanString(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function amount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export default async function handler(req, res) {
  setApiHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return json(res, 405, { success: false, code: 'METHOD_NOT_ALLOWED' });

  const token = (req.headers.authorization || '').startsWith('Bearer ')
    ? req.headers.authorization.slice(7).trim()
    : '';
  if (!token) return json(res, 401, { success: false, code: 'AUTH_REQUIRED', error: 'Sign in to submit your order.' });

  let user;
  try { user = await auth.verifyIdToken(token); }
  catch { return json(res, 401, { success: false, code: 'AUTH_INVALID', error: 'Your session expired. Sign in again.' }); }

  const body = req.body || {};
  const productId = cleanString(body.productId, 150);
  const colorId = cleanString(body.colorId, 150);
  const governorateId = cleanString(body.governorateId, 150);
  const quantity = getQuantity(body.quantity);
  const city = cleanString(body.city, 120);
  const address = cleanString(body.address, 500);
  const idempotencyKey = cleanString(req.headers['idempotency-key'], 100);
  const expected = {
    cost: amount(body.quote?.cost),
    shippingCost: amount(body.quote?.shippingCost),
    totalCost: amount(body.quote?.totalCost)
  };
  if (!productId || !colorId || !governorateId || !quantity || !city || city.length < 2 || !address || address.length < 5 ||
      !/^[A-Za-z0-9_-]{12,100}$/.test(idempotencyKey) || Object.values(expected).some(value => value === null)) {
    return json(res, 400, { success: false, code: 'INVALID_INPUT', error: 'Complete all required order details with a valid quantity and price.' });
  }

  try {
    const orderKey = createHash('sha256').update(`${user.uid}:${idempotencyKey}`).digest('hex');
    const orderRef = db.collection('orders').doc(orderKey);
    const priorOrder = await orderRef.get();
    if (priorOrder.exists) {
      const prior = priorOrder.data();
      const sameRequest = prior.customer?.uid === user.uid && prior.idempotencyKey === idempotencyKey &&
        prior.productId === productId && prior.colorId === colorId && prior.governorateId === governorateId &&
        prior.quantity === quantity && prior.city === city && prior.address === address;
      if (!sameRequest) return json(res, 409, { success: false, code: 'IDEMPOTENCY_CONFLICT', error: 'This submission key was already used for a different order.' });
      return json(res, 200, {
        success: true, orderId: orderRef.id, created: false,
        price: { cost: prior.cost, shippingCost: prior.shippingCost, totalCost: prior.totalCost, currency: prior.currency || 'EGP' }
      });
    }

    const [records, colorSnapshot] = await Promise.all([
      getPriceRecords(productId, governorateId),
      db.collection('colorPalettecms').doc(colorId).get()
    ]);
    if (records.error) return json(res, 422, { success: false, code: records.error, error: 'The selected product or delivery area is unavailable.' });
    if (!colorSnapshot.exists) return json(res, 422, { success: false, code: 'COLOR_NOT_FOUND', error: 'The selected color is no longer available.' });
    const cost = records.unitPrice * quantity;
    const shippingCost = records.shippingCost;
    const totalCost = cost + shippingCost;
    const current = { cost, shippingCost, totalCost, currency: 'EGP' };
    if (expected.cost !== cost || expected.shippingCost !== shippingCost || expected.totalCost !== totalCost) {
      return json(res, 409, { success: false, code: 'PRICE_CHANGED', error: 'The price changed. Review the updated total and continue again.', price: current });
    }

    const productName = body.locale === 'ar' ? records.product.name_ar : records.product.name_en;
    const color = colorSnapshot.data();
    const colorName = body.locale === 'ar' ? color.colorNameAR : color.colorName;
    const order = {
      productId, productName: typeof productName === 'string' ? productName : '',
      quantity, colorId,
      color: { colorName: color.colorName || '', colorNameAR: color.colorNameAR || '', colorCode: color.colorCode ?? null, img: color.img || '' },
      governorateId,
      governorateName: body.locale === 'ar' ? records.governorate.nameAr || '' : records.governorate.nameEn || '',
      city, address,
      unitPrice: records.unitPrice, cost, shippingCost, totalCost, currency: 'EGP',
      customer: { uid: user.uid, email: user.email || '', name: user.name || '' },
      status: 'submitted', source: 'website', locale: body.locale === 'ar' ? 'ar' : 'en',
      idempotencyKey, createdAt: FieldValue.serverTimestamp()
    };
    const result = await db.runTransaction(async transaction => {
      const existing = await transaction.get(orderRef);
      if (existing.exists) {
        const prior = existing.data();
        const sameRequest = prior.customer?.uid === user.uid && prior.idempotencyKey === idempotencyKey &&
          prior.productId === productId && prior.colorId === colorId && prior.governorateId === governorateId &&
          prior.quantity === quantity && prior.city === city && prior.address === address;
        if (!sameRequest) {
          const conflict = new Error('Idempotency key conflict.'); conflict.code = 'IDEMPOTENCY_CONFLICT'; throw conflict;
        }
        return { created: false, orderId: orderRef.id };
      }
      transaction.create(orderRef, order);
      return { created: true, orderId: orderRef.id };
    });
    return json(res, 200, { success: true, orderId: result.orderId, created: result.created, price: current });
  } catch (error) {
    if (error.code === 'IDEMPOTENCY_CONFLICT') return json(res, 409, { success: false, code: error.code, error: 'This submission key was already used for a different order.' });
    console.error('Order submission API failed:', error);
    return json(res, 500, { success: false, code: 'ORDER_SUBMISSION_FAILED', error: 'The order could not be submitted. Please try again.' });
  }
}
