import { db, json, setApiHeaders } from '../server/firebase-admin.js';

const BATCH_LIMIT = 400;

export default async function handler(req, res) {
  setApiHeaders(req, res);
  if (req.method !== 'GET') return json(res, 405, { success: false, code: 'METHOD_NOT_ALLOWED' });

  const secret = process.env.CRON_SECRET;
  const authorization = req.headers.authorization || '';
  if (!secret || authorization !== `Bearer ${secret}`) {
    return json(res, 401, { success: false, code: 'UNAUTHORIZED' });
  }

  try {
    const expired = await db.collection('temporaryOrders')
      .where('expiresAt', '<=', new Date())
      .limit(BATCH_LIMIT)
      .get();

    if (expired.empty) return json(res, 200, { success: true, deleted: 0 });

    const batch = db.batch();
    expired.docs.forEach(document => batch.delete(document.ref));
    await batch.commit();
    return json(res, 200, { success: true, deleted: expired.size });
  } catch (error) {
    console.error('Expired temporary order cleanup failed:', error);
    return json(res, 500, { success: false, code: 'TEMPORARY_ORDER_CLEANUP_FAILED' });
  }
}
