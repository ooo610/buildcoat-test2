import { getPriceRecords, getQuantity, json, setApiHeaders } from '../server/firebase-admin.js';

export default async function handler(req, res) {
  setApiHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return json(res, 405, { success: false, code: 'METHOD_NOT_ALLOWED' });

  const { productId, governorateId } = req.body || {};
  const quantity = getQuantity(req.body?.quantity);
  if (typeof productId !== 'string' || !productId.trim() || productId.length > 150 ||
      typeof governorateId !== 'string' || !governorateId.trim() || governorateId.length > 150 || !quantity) {
    return json(res, 400, { success: false, code: 'INVALID_INPUT', error: 'Select a product, governorate, and positive whole-number quantity.' });
  }

  try {
    const records = await getPriceRecords(productId, governorateId);
    if (records.error) return json(res, 422, { success: false, code: records.error, error: 'The selected product or delivery area is unavailable.' });
    const cost = records.unitPrice * quantity;
    const totalCost = cost + records.shippingCost;
    if (!Number.isFinite(cost) || !Number.isFinite(totalCost)) {
      return json(res, 422, { success: false, code: 'PRICE_DATA_INVALID', error: 'Could not calculate a valid price.' });
    }
    return json(res, 200, { success: true, cost, shippingCost: records.shippingCost, totalCost, currency: 'EGP' });
  } catch (error) {
    console.error('Order price API failed:', error);
    return json(res, 500, { success: false, code: 'PRICE_LOOKUP_FAILED', error: 'Price calculation is temporarily unavailable.' });
  }
}
