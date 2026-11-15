import { auth, db, FieldValue, json, setApiHeaders } from '../server/firebase-admin.js';

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
  const senderInfo = typeof req.body?.senderInfo === 'string' ? req.body.senderInfo.trim().slice(0, 120) : '';
  const receiptUrl = typeof req.body?.receiptUrl === 'string' ? req.body.receiptUrl.trim() : '';
  if (!/^[A-Za-z0-9_-]{12,150}$/.test(temporaryOrderId) || senderInfo.length < 3 || !/^https:\/\/res\.cloudinary\.com\/bpndfgos\/image\/upload\//.test(receiptUrl)) {
    return json(res, 400, { success: false, code: 'INVALID_INPUT' });
  }

  try {
    const tempRef = db.collection('temporaryOrders').doc(temporaryOrderId);
    const userOrderRef = db.collection('users').doc(user.uid).collection('orders').doc(temporaryOrderId);
    const result = await db.runTransaction(async transaction => {
      const tempSnapshot = await transaction.get(tempRef);
      if (!tempSnapshot.exists || tempSnapshot.data().customer?.uid !== user.uid) throw Object.assign(new Error('Order not found.'), { code: 'TEMPORARY_ORDER_NOT_FOUND' });
      const temp = tempSnapshot.data();
      if (temp.status === 'Pending Approval' && temp.finalOrderId) return { orderId: temp.finalOrderId, created: false };
      if (temp.status !== 'awaiting-payment') throw Object.assign(new Error('Order is already finalized.'), { code: 'ORDER_ALREADY_FINALIZED' });
      if (!temp.expiresAt?.toMillis || temp.expiresAt.toMillis() <= Date.now()) throw Object.assign(new Error('Order expired.'), { code: 'ORDER_EXPIRED' });
      if (!['instapay', 'ewallet'].includes(temp.paymentMethod) || !['full', 'deposit'].includes(temp.paymentType) || !(Number(temp.payableAmount) > 0)) {
        throw Object.assign(new Error('Payment option is missing.'), { code: 'PAYMENT_NOT_SELECTED' });
      }

      const existingOrder = await transaction.get(userOrderRef);
      if (existingOrder.exists) throw Object.assign(new Error('Order already exists.'), { code: 'ORDER_ALREADY_FINALIZED' });

      const { expiresAt, ...orderDetails } = temp;
      const finalOrder = {
        ...orderDetails,
        paymentReceiptUrl: receiptUrl,
        paymentSenderInfo: senderInfo,
        paymentSubmittedAt: FieldValue.serverTimestamp(),
        status: 'Pending Approval',
        createdAt: FieldValue.serverTimestamp()
      };
      transaction.create(userOrderRef, finalOrder);
      transaction.update(tempRef, {
        status: 'Pending Approval', finalOrderId: userOrderRef.id,
        paymentReceiptUrl: receiptUrl, paymentSenderInfo: senderInfo,
        paymentSubmittedAt: FieldValue.serverTimestamp()
      });
      return { orderId: userOrderRef.id, created: true };
    });
    return json(res, 200, { success: true, ...result });
  } catch (error) {
    const known = {
      TEMPORARY_ORDER_NOT_FOUND: [404, 'TEMPORARY_ORDER_NOT_FOUND'],
      ORDER_EXPIRED: [410, 'ORDER_EXPIRED'],
      PAYMENT_NOT_SELECTED: [409, 'PAYMENT_NOT_SELECTED'],
      ORDER_ALREADY_FINALIZED: [409, 'ORDER_ALREADY_FINALIZED']
    };
    if (known[error.code]) return json(res, known[error.code][0], { success: false, code: error.code });
    console.error('Payment proof submission failed:', error);
    return json(res, 500, { success: false, code: 'PAYMENT_PROOF_SUBMISSION_FAILED' });
  }
}
