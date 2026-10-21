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
  const { temporaryOrderId, tier } = req.body || {};
  const method = req.body?.method;
  const paymentType = req.body?.paymentType;
  if (typeof temporaryOrderId !== 'string' || !/^[A-Za-z0-9_-]{12,150}$/.test(temporaryOrderId) || typeof tier !== 'string' || !/^[A-Za-z0-9_-]{1,150}$/.test(tier)) {
    return json(res, 400, { success: false, code: 'INVALID_INPUT' });
  }
  if (!['instapay', 'ewallet'].includes(method) || !['full', 'deposit'].includes(paymentType)) return json(res, 400, { success: false, code: 'INVALID_PAYMENT_SELECTION' });
  try {
    const tempRef = db.collection('temporaryOrders').doc(temporaryOrderId);
    const policyRef = db.collection('orderPolicies').doc(tier);
    const result = await db.runTransaction(async transaction => {
      const [tempSnapshot, policySnapshot] = await Promise.all([transaction.get(tempRef), transaction.get(policyRef)]);
      if (!tempSnapshot.exists || tempSnapshot.data().customer?.uid !== user.uid) throw Object.assign(new Error('Temporary order not found.'), { code: 'TEMPORARY_ORDER_NOT_FOUND' });
      const temp = tempSnapshot.data();
      if (temp.status !== 'awaiting-payment') throw Object.assign(new Error('Order is no longer awaiting payment.'), { code: 'ORDER_ALREADY_FINALIZED' });
      if (!temp.expiresAt?.toMillis || temp.expiresAt.toMillis() <= Date.now()) throw Object.assign(new Error('Order expired.'), { code: 'ORDER_EXPIRED' });
      if (!policySnapshot.exists || policySnapshot.data().active !== true) throw Object.assign(new Error('Policy unavailable.'), { code: 'POLICY_NOT_FOUND' });
      const policy = policySnapshot.data();
      const min = Number(policy.minOrderValue), max = Number(policy.maxOrderValue);
      const matches = Number.isFinite(min) && Number.isFinite(max) && temp.totalCost >= min && (policy.maxInclusive === true ? temp.totalCost <= max : temp.totalCost < max);
      if (!matches) throw Object.assign(new Error('Policy does not apply.'), { code: 'POLICY_MISMATCH' });
      if (method === 'instapay' && policy.allowInstaPay !== true || method === 'ewallet' && policy.allowEWallet !== true) throw Object.assign(new Error('Payment method unavailable.'), { code: 'PAYMENT_NOT_ALLOWED' });
      const depositPercent = Number(policy.depositPercent) || 0;
      if (paymentType === 'full' && policy.allowFullPayment !== true) throw Object.assign(new Error('Full payment unavailable.'), { code: 'PAYMENT_NOT_ALLOWED' });
      if (paymentType === 'deposit' && !(depositPercent > 0)) throw Object.assign(new Error('Deposit unavailable.'), { code: 'PAYMENT_NOT_ALLOWED' });
      const payableAmount = paymentType === 'deposit' ? Math.ceil(temp.totalCost * depositPercent / 100) : temp.totalCost;
      transaction.update(tempRef, {
        tier, paymentMethod: method, paymentType, depositPercent: paymentType === 'deposit' ? depositPercent : 0,
        payableAmount, updatedAt: FieldValue.serverTimestamp()
      });
      return { payableAmount, currency: temp.currency || 'EGP' };
    });
    return json(res, 200, { success: true, ...result });
  } catch (error) {
    const known = {
      TEMPORARY_ORDER_NOT_FOUND: [404, 'Temporary order not found.'],
      ORDER_EXPIRED: [410, 'Your order has expired. Please start again.'],
      POLICY_NOT_FOUND: [422, 'The payment policy is unavailable.'],
      POLICY_MISMATCH: [422, 'This payment policy no longer applies to the order.'],
      PAYMENT_NOT_ALLOWED: [422, 'This payment option is unavailable for the order.'],
      ORDER_ALREADY_FINALIZED: [409, 'This order is no longer awaiting payment selection.']
    };
    if (known[error.code]) return json(res, known[error.code][0], { success: false, code: error.code, error: known[error.code][1] });
    console.error('Payment selection failed:', error);
    return json(res, 500, { success: false, code: 'PAYMENT_SELECTION_FAILED', error: 'Could not save this payment selection.' });
  }
}
