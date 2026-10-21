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
    const ref = db.collection('temporaryOrders').doc(temporaryOrderId);
    const snapshot = await ref.get();
    if (!snapshot.exists || snapshot.data().customer?.uid !== user.uid) return json(res, 404, { success: false, code: 'TEMPORARY_ORDER_NOT_FOUND' });
    const order = snapshot.data();
    if (order.status !== 'awaiting-payment') return json(res, 409, { success: false, code: 'ORDER_ALREADY_FINALIZED', error: 'This order is no longer awaiting payment selection.' });
    if (!order.expiresAt?.toMillis || order.expiresAt.toMillis() <= Date.now()) return json(res, 410, { success: false, code: 'ORDER_EXPIRED', error: 'Your order has expired. Please start again.' });
    const policies = await db.collection('orderPolicies').where('active', '==', true).get();
    const matches = policies.docs.filter(doc => {
      const policy = doc.data();
      const min = Number(policy.minOrderValue);
      const max = Number(policy.maxOrderValue);
      if (!Number.isFinite(min) || !Number.isFinite(max)) return false;
      return order.totalCost >= min && (policy.maxInclusive === true ? order.totalCost <= max : order.totalCost < max);
    });
    if (matches.length !== 1) return json(res, 422, { success: false, code: matches.length ? 'POLICY_AMBIGUOUS' : 'POLICY_NOT_FOUND', error: 'No unique payment policy matches this order total.' });
    const tier = matches[0];
    const policy = tier.data();
    await ref.update({ tier: tier.id });
    return json(res, 200, {
      success: true, temporaryOrderId, tier: tier.id,
      order: { totalCost: order.totalCost, currency: order.currency || 'EGP', expiresAt: order.expiresAt.toMillis() },
      methods: {
        allowCOD: policy.allowCOD === true && policy.depositRequired !== true,
        allowInstaPay: policy.allowInstaPay === true,
        allowEWallet: policy.allowEWallet === true,
        allowFullPayment: policy.allowFullPayment === true,
        depositRequired: policy.depositRequired === true,
        depositPercent: Number.isFinite(Number(policy.depositPercent)) ? Number(policy.depositPercent) : 0
      }
    });
  } catch (error) {
    console.error('Payment policy lookup failed:', error);
    return json(res, 500, { success: false, code: 'PAYMENT_POLICY_FAILED', error: 'Could not load payment options.' });
  }
}
