import { auth, db, json, setApiHeaders } from '../server/firebase-admin.js';

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
  if (!user) return json(res, 401, { success: false, code: 'AUTH_REQUIRED' });

  const temporaryOrderId = typeof req.body?.temporaryOrderId === 'string' ? req.body.temporaryOrderId.trim() : '';
  if (!/^[A-Za-z0-9_-]{12,150}$/.test(temporaryOrderId)) return json(res, 400, { success: false, code: 'INVALID_ORDER_ID' });

  try {
    const orderSnapshot = await db.collection('temporaryOrders').doc(temporaryOrderId).get();
    if (!orderSnapshot.exists || orderSnapshot.data().customer?.uid !== user.uid) return json(res, 404, { success: false, code: 'TEMPORARY_ORDER_NOT_FOUND' });
    const order = orderSnapshot.data();
    if (order.status !== 'awaiting-payment') return json(res, 409, { success: false, code: 'ORDER_ALREADY_FINALIZED' });
    if (!order.expiresAt?.toMillis || order.expiresAt.toMillis() <= Date.now()) return json(res, 410, { success: false, code: 'ORDER_EXPIRED' });
    if (!['instapay', 'ewallet'].includes(order.paymentMethod) || !['full', 'deposit'].includes(order.paymentType)) {
      return json(res, 409, { success: false, code: 'PAYMENT_NOT_SELECTED' });
    }

    const infoId = order.paymentMethod === 'instapay' ? 'instaPay' : 'vodaCash';
    const infoSnapshot = await db.collection('paymentInfo').doc(infoId).get();
    const info = infoSnapshot.exists ? infoSnapshot.data() : {};
    const phoneNumber = [info.phonenumber, info.phoneNumber, info.phone, info.number]
      .find(value => typeof value === 'string' && value.trim());
    if (!phoneNumber) return json(res, 503, { success: false, code: 'PAYMENT_INFO_UNAVAILABLE' });

    return json(res, 200, {
      success: true,
      order: {
        totalCost: order.totalCost,
        payableAmount: order.payableAmount,
        currency: order.currency || 'EGP',
        paymentMethod: order.paymentMethod,
        paymentType: order.paymentType
      },
      recipientPhone: phoneNumber.trim()
    });
  } catch (error) {
    console.error('Payment confirmation data lookup failed:', error);
    return json(res, 500, { success: false, code: 'PAYMENT_CONFIRMATION_LOAD_FAILED' });
  }
}
