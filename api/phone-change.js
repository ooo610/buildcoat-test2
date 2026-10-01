import admin from 'firebase-admin';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
    })
  });
}

const db = admin.firestore();
const IDENTITY_TOOLKIT_URL =
  'https://identitytoolkit.googleapis.com/v1';

const API_KEY = process.env.FIREBASE_WEB_API_KEY;
const PHONE_OPERATION_TTL_MS = 15 * 60 * 1000;

function getPhoneOperationKey() {
  const secret = process.env.PHONE_OPERATION_TOKEN_SECRET || process.env.FIREBASE_PRIVATE_KEY;
  if (!secret) throw new Error('A phone operation token secret is not configured.');
  return createHash('sha256').update(secret).digest();
}

function sealPhoneOperation(operation) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getPhoneOperationKey(), iv);
  const payload = Buffer.from(JSON.stringify({
    ...operation,
    expiresAt: Date.now() + PHONE_OPERATION_TTL_MS
  }));
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
  return [iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}

function openPhoneOperation(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('Invalid phone operation token.');

  const [ivPart, tagPart, encryptedPart] = parts;
  const iv = Buffer.from(ivPart, 'base64url');
  const tag = Buffer.from(tagPart, 'base64url');
  const encrypted = Buffer.from(encryptedPart, 'base64url');
  if (iv.length !== 12 || tag.length !== 16 || !encrypted.length) {
    throw new Error('Invalid phone operation token.');
  }

  const decipher = createDecipheriv('aes-256-gcm', getPhoneOperationKey(), iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  const operation = JSON.parse(decrypted.toString('utf8'));
  if (!Number.isFinite(operation.expiresAt) || operation.expiresAt < Date.now()) {
    const error = new Error('Phone operation token expired.');
    error.code = 'PHONE_OPERATION_EXPIRED';
    throw error;
  }
  return operation;
}

function json(res, status, body) {
  return res.status(status).json(body);
}

function getBearerToken(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    return null;
  }
  return header.slice(7).trim();
}

function isValidE164(phone) {
  return /^\+[1-9]\d{7,14}$/.test(phone);
}

async function verifyCurrentUser(req) {
  const idToken = getBearerToken(req);

  if (!idToken) {
    const error = new Error('Missing Authorization token');
    error.code = 'MISSING_AUTH_TOKEN';
    error.status = 401;
    throw error;
  }

  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    return { idToken, decodedToken };
  } catch (error) {
    const authError = new Error('Invalid or expired authentication token.');
    authError.code = 'INVALID_AUTH_TOKEN';
    authError.status = 401;
    authError.cause = error;
    throw authError;
  }
}

async function callIdentityToolkit(path, body, locale = 'en') {
  if (!API_KEY) {
    const error = new Error('FIREBASE_WEB_API_KEY is not configured.');
    error.code = 'SERVER_CONFIGURATION_ERROR';
    error.status = 500;
    throw error;
  }

  const response = await fetch(
    `${IDENTITY_TOOLKIT_URL}/${path}?key=${encodeURIComponent(API_KEY)}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Firebase-Locale': locale
      },
      body: JSON.stringify(body)
    }
  );

  let data = {};

  try {
    data = await response.json();
  } catch {
    // Keep the generic error below.
  }

  if (!response.ok) {
    const providerCode =
      data?.error?.message || 'IDENTITY_TOOLKIT_ERROR';

    const error = new Error(providerCode);
    error.code = providerCode;
    error.status = response.status;
    error.providerResponse = data;
    throw error;
  }

  return data;
}

async function commitPhoneFirestore(uid, oldPhone, newPhone) {
  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const userRef = db.collection('users').doc(uid);
      const oldIndexRef = oldPhone
        ? db.collection('phoneIndex').doc(oldPhone)
        : null;
      const newIndexRef = db.collection('phoneIndex').doc(newPhone);

      const batch = db.batch();

      if (oldIndexRef && oldPhone !== newPhone) {
        batch.delete(oldIndexRef);
      }

      batch.set(newIndexRef, { exists: true });

      batch.set(
        userRef,
        {
          phoneNumber: newPhone,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        },
        { merge: true }
      );

      await batch.commit();
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await new Promise((resolve) =>
          setTimeout(resolve, 250 * attempt)
        );
      }
    }
  }

  throw lastError;
}

async function rollbackAuthPhone(uid, expectedNewPhone, oldPhone) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const currentUser = await admin.auth().getUser(uid);
      const currentPhone = currentUser.phoneNumber || null;

      // Never overwrite a different/newer server-side change.
      if (currentPhone !== expectedNewPhone) {
        return currentPhone === (oldPhone || null);
      }

      await admin.auth().updateUser(uid, {
        phoneNumber: oldPhone || null
      });

      const restoredUser = await admin.auth().getUser(uid);

      if ((restoredUser.phoneNumber || null) === (oldPhone || null)) {
        return true;
      }
    } catch (error) {
      console.error(`Auth rollback attempt ${attempt} failed:`, error);

      if (attempt < 3) {
        await new Promise((resolve) =>
          setTimeout(resolve, 300 * attempt)
        );
      }
    }
  }

  return false;
}

async function handleStart(req, res, locale) {
  const { decodedToken } = await verifyCurrentUser(req);
  const phone = String(req.body?.phone || '').trim();
  const recaptchaToken = String(req.body?.recaptchaToken || '').trim();

  if (!isValidE164(phone)) {
    return json(res, 400, {
      ok: false,
      code: 'INVALID_PHONE',
      error: 'Invalid phone number.'
    });
  }

  if (!recaptchaToken) {
    return json(res, 400, {
      ok: false,
      code: 'MISSING_RECAPTCHA',
      error: 'App verification is required.'
    });
  }

  const uid = decodedToken.uid;
  const userRecord = await admin.auth().getUser(uid);
  const oldPhone = userRecord.phoneNumber || null;

  if (oldPhone === phone) {
    return json(res, 400, {
      ok: false,
      code: 'PHONE_UNCHANGED',
      error: 'The new phone number is the same as the current one.'
    });
  }

  try {
    const result = await callIdentityToolkit(
      'accounts:sendVerificationCode',
      {
        phoneNumber: phone,
        recaptchaToken
      },
      locale
    );

    const operationId = sealPhoneOperation({
      flow: 'phone-change', uid, oldPhone, newPhone: phone,
      sessionInfo: result.sessionInfo
    });

    return json(res, 200, {
      ok: true,
      operationId
    });
  } catch (error) {
    console.error('Phone verification SMS send failed:', error);

    return json(res, 400, {
      ok: false,
      code: 'PHONE_VERIFICATION_START_FAILED',
      error: 'Could not start phone verification.'
    });
  }
}

async function handleConfirm(req, res, locale) {
  const { idToken, decodedToken } = await verifyCurrentUser(req);
  let operation;
  try {
    operation = openPhoneOperation(req.body?.operationId);
  } catch (error) {
    return json(res, 409, {
      ok: false,
      code: error.code || 'PHONE_OPERATION_INVALID',
      error: 'The phone verification session expired or is invalid. Start again.'
    });
  }
  const code = String(req.body?.code || '').trim();

  if (
    operation.flow !== 'phone-change' ||
    operation.uid !== decodedToken.uid ||
    !operation.sessionInfo ||
    !operation.newPhone ||
    !/^\d{6}$/.test(code)
  ) {
    return json(res, 400, {
      ok: false,
      code: 'INVALID_VERIFICATION_INPUT',
      error: 'Invalid verification data.'
    });
  }

  const uid = decodedToken.uid;
  const oldPhone = operation.oldPhone || null;
  const expectedNewPhone = operation.newPhone || null;

  const currentUser = await admin.auth().getUser(uid);
  if ((currentUser.phoneNumber || null) !== oldPhone) {
    return json(res, 409, {
      ok: false,
      code: 'PHONE_CHANGE_STATE_CHANGED',
      error: 'The account phone number changed. Start verification again.'
    });
  }

  let authUpdated = false;
  let actualNewPhone = null;

  try {
    /*
     * IMPORTANT:
     * The browser does NOT change Firebase Auth here.
     * Identity Platform verifies the SMS code and performs
     * the UPDATE operation on the server side.
     */
    const result = await callIdentityToolkit(
      'accounts:signInWithPhoneNumber',
      {
        sessionInfo: operation.sessionInfo,
        code,
        idToken,
        operation: 'UPDATE'
      },
      locale
    );

    actualNewPhone = result.phoneNumber || null;
    authUpdated = true;

    if (result.localId !== uid || !actualNewPhone || actualNewPhone !== expectedNewPhone) {
      const rolledBack = await rollbackAuthPhone(
        uid,
        actualNewPhone,
        oldPhone
      );

      return json(res, 500, {
        ok: false,
        code: rolledBack
          ? 'PHONE_CHANGE_REJECTED'
          : 'PHONE_CHANGE_UNCERTAIN',
        error: rolledBack
          ? 'The phone change was rejected and the previous number was restored.'
          : 'The phone change could not be completed or safely restored.'
      });
    }

    try {
      await commitPhoneFirestore(
        uid,
        oldPhone,
        actualNewPhone
      );
    } catch (firestoreError) {
      console.error(
        'Firestore phone synchronization failed:',
        firestoreError
      );

      const rolledBack = await rollbackAuthPhone(
        uid,
        actualNewPhone,
        oldPhone
      );

      if (!rolledBack) {
        return json(res, 500, {
          ok: false,
          code: 'PHONE_CHANGE_UNCERTAIN',
          error:
            'The phone number was verified, but the account could not be synchronized or safely restored.'
        });
      }

      return json(res, 500, {
        ok: false,
        code: 'PHONE_CHANGE_REJECTED',
        error:
          'The phone number was verified, but the account update could not be completed. The previous number was restored.'
      });
    }

    return json(res, 200, {
      ok: true,
      phoneNumber: actualNewPhone
    });
  } catch (error) {
    console.error('Phone change confirmation failed:', error);

    // Identity Toolkit failed before Auth was changed.
    if (!authUpdated) {
      if (error.code === 'CREDENTIAL_TOO_OLD_LOGIN_AGAIN') {
        return json(res, 401, {
          ok: false,
          code: 'RECENT_LOGIN_REQUIRED',
          error: 'Recent authentication is required.'
        });
      }

      if (
        error.code === 'INVALID_CODE' ||
        error.code === 'INVALID_VERIFICATION_CODE' ||
        error.code === 'SESSION_EXPIRED'
      ) {
        return json(res, 400, {
          ok: false,
          code: 'INVALID_OR_EXPIRED_CODE',
          error: 'The verification code is invalid or expired.'
        });
      }

      return json(res, 400, {
        ok: false,
        code: 'PHONE_CHANGE_CONFIRM_FAILED',
        error: 'Could not verify the phone number.'
      });
    }

    // Auth changed, but an unexpected server-side error happened afterwards.
    const rolledBack = await rollbackAuthPhone(
      uid,
      actualNewPhone,
      oldPhone
    );

    if (!rolledBack) {
      return json(res, 500, {
        ok: false,
        code: 'PHONE_CHANGE_UNCERTAIN',
        error:
          'The phone number was verified, but the account could not be synchronized or safely restored.'
      });
    }

    return json(res, 500, {
      ok: false,
      code: 'PHONE_CHANGE_REJECTED',
      error:
        'The phone number was verified, but the account update failed. The previous number was restored.'
    });
  }
}

export default async function handler(req, res) {
  res.setHeader(
    'Access-Control-Allow-Origin',
    'https://ooo610.github.io'
  );
  res.setHeader(
    'Access-Control-Allow-Methods',
    'POST, OPTIONS'
  );
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Authorization, Content-Type'
  );

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return json(res, 405, {
      ok: false,
      code: 'METHOD_NOT_ALLOWED',
      error: 'Method not allowed.'
    });
  }

  const action = req.body?.action;
  const locale = req.body?.locale === 'ar' ? 'ar' : 'en';

  try {
    if (action === 'start') {
      return await handleStart(req, res, locale);
    }

    if (action === 'confirm') {
      return await handleConfirm(req, res, locale);
    }

    return json(res, 400, {
      ok: false,
      code: 'INVALID_ACTION',
      error: 'Invalid phone change action.'
    });
  } catch (error) {
    console.error('Phone change API error:', error);

    return json(res, error.status || 500, {
      ok: false,
      code: error.code || 'INTERNAL_ERROR',
      error:
        error.status === 401
          ? 'Authentication is required.'
          : 'The phone change could not be completed.'
    });
  }
}
