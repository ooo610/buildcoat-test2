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
  if (!/^[A-Za-z0-9_-]{12,150}$/.test(temporaryOrderId)) return json(res, 400, { success: false, code: 'INVALID_ORDER_ID' });
  try {
    const tempRef = db.collection('temporaryOrders').doc(temporaryOrderId);
    const userOrderRef = db.collection('users').doc(user.uid).collection('orders').doc(temporaryOrderId);
    const result = await db.runTransaction(async transaction => {
      const tempSnapshot = await transaction.get(tempRef);
      if (!tempSnapshot.exists || tempSnapshot.data().customer?.uid !== user.uid) {
        const notFound = new Error('Temporary order not found.'); notFound.code = 'TEMPORARY_ORDER_NOT_FOUND'; throw notFound;
      }
      const temp = tempSnapshot.data();
      if (temp.status === 'Pending Approval' && temp.finalOrderId) return { orderId: temp.finalOrderId, created: false };
      if (temp.status !== 'awaiting-payment') { const finalized = new Error('Order is no longer awaiting payment.'); finalized.code = 'ORDER_ALREADY_FINALIZED'; throw finalized; }
      if (!temp.expiresAt?.toMillis || temp.expiresAt.toMillis() <= Date.now()) {
        const expired = new Error('Temporary order expired.'); expired.code = 'ORDER_EXPIRED'; throw expired;
      }
      const tier = typeof req.body?.tier === 'string' && /^[A-Za-z0-9_-]{1,150}$/.test(req.body.tier) ? req.body.tier : '';
      if (!tier) { const invalid = new Error('Payment policy id is invalid.'); invalid.code = 'POLICY_NOT_FOUND'; throw invalid; }
      const policySnapshot = await transaction.get(db.collection('orderPolicies').doc(tier));
      if (!policySnapshot.exists || policySnapshot.data().active !== true) {
        const policyError = new Error('Payment policy unavailable.'); policyError.code = 'POLICY_NOT_FOUND'; throw policyError;
      }
      const policy = policySnapshot.data();
      const min = Number(policy.minOrderValue);
      const max = Number(policy.maxOrderValue);
      const policyMatches = Number.isFinite(min) && Number.isFinite(max) && temp.totalCost >= min &&
        (policy.maxInclusive === true ? temp.totalCost <= max : temp.totalCost < max);
      if (!policyMatches) { const mismatch = new Error('Payment policy does not match this order.'); mismatch.code = 'POLICY_MISMATCH'; throw mismatch; }
      if (policy.allowCOD !== true || policy.depositRequired === true) { const denied = new Error('COD is unavailable.'); denied.code = 'PAYMENT_NOT_ALLOWED'; throw denied; }
      const existingTier = typeof temp.tier === 'string' ? temp.tier : '';
      if (existingTier && existingTier !== tier) { const mismatch = new Error('Payment tier changed.'); mismatch.code = 'POLICY_MISMATCH'; throw mismatch; }
      const existing = await transaction.get(userOrderRef);
      if (existing.exists) return { orderId: userOrderRef.id, created: false };
      const { expiresAt, ...orderDetails } = temp;
      const finalOrder = {
        ...orderDetails, tier, paymentMethod: 'cod', paymentType: 'cod', payableAmount: temp.totalCost,
        status: 'Pending Approval', createdAt: FieldValue.serverTimestamp()
      };
      transaction.create(userOrderRef, finalOrder);
      transaction.update(tempRef, { status: 'Pending Approval', tier, finalOrderId: userOrderRef.id, completedAt: FieldValue.serverTimestamp() });
      return { orderId: userOrderRef.id, created: true };
    });
    return json(res, 200, { success: true, orderId: result.orderId, created: result.created });
  } catch (error) {
    const known = {
      TEMPORARY_ORDER_NOT_FOUND: [404, 'Temporary order not found.'],
      ORDER_EXPIRED: [410, 'Your order has expired. Please start again.'],
      POLICY_NOT_FOUND: [422, 'The payment policy is no longer available.'],
      POLICY_MISMATCH: [422, 'The payment policy no longer matches this order.'],
      PAYMENT_NOT_ALLOWED: [422, 'Cash on delivery is unavailable for this order.'],
      ORDER_ALREADY_FINALIZED: [409, 'This order is no longer awaiting payment selection.']
    };
    if (known[error.code]) return json(res, known[error.code][0], { success: false, code: error.code, error: known[error.code][1] });
    console.error('Final order creation failed:', error);
    return json(res, 500, { success: false, code: 'ORDER_CREATION_FAILED', error: 'Could not create your order.' });
  }
}
