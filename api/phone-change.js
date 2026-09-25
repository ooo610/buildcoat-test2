import admin from 'firebase-admin';

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

async function writeOperation(uid, values) {
  await db.collection('phoneChangeOperations').doc(uid).set(
    {
      uid,
      ...values,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    },
    { merge: true }
  );
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
  const { idToken, decodedToken } = await verifyCurrentUser(req);
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

  const operationRef = db.collection('phoneChangeOperations').doc(uid);
  const operationSnap = await operationRef.get();
  const operation = operationSnap.exists ? operationSnap.data() : null;

  if (operation?.status === 'pending') {
    return json(res, 409, {
      ok: false,
      code: 'PHONE_CHANGE_ALREADY_PENDING',
      error: 'A phone number change is already in progress.'
    });
  }

  // Persist the intended operation BEFORE Auth is allowed to change.
  await writeOperation(uid, {
    status: 'pending',
    oldPhone,
    newPhone: phone,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });

  try {
    const result = await callIdentityToolkit(
      'accounts:sendVerificationCode',
      {
        phoneNumber: phone,
        recaptchaToken
      },
      locale
    );

    await writeOperation(uid, {
      status: 'code-sent'
    });

    return json(res, 200, {
      ok: true,
      sessionInfo: result.sessionInfo
    });
  } catch (error) {
    await writeOperation(uid, {
      status: 'failed'
    }).catch((writeError) => {
      console.error('Failed to mark phone operation as failed:', writeError);
    });

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
  const sessionInfo = String(req.body?.sessionInfo || '').trim();
  const code = String(req.body?.code || '').trim();

  if (!sessionInfo || !/^\d{6}$/.test(code)) {
    return json(res, 400, {
      ok: false,
      code: 'INVALID_VERIFICATION_INPUT',
      error: 'Invalid verification data.'
    });
  }

  const uid = decodedToken.uid;
  const operationRef = db.collection('phoneChangeOperations').doc(uid);
  const operationSnap = await operationRef.get();
  const operation = operationSnap.exists ? operationSnap.data() : null;

  if (!operation || operation.status !== 'code-sent') {
    return json(res, 409, {
      ok: false,
      code: 'PHONE_CHANGE_NOT_PENDING',
      error: 'No active phone change operation was found.'
    });
  }

  const oldPhone = operation.oldPhone || null;
  const expectedNewPhone = operation.newPhone || null;

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
        sessionInfo,
        code,
        idToken,
        operation: 'UPDATE'
      },
      locale
    );

    actualNewPhone = result.phoneNumber || null;
    authUpdated = true;

    if (!actualNewPhone || actualNewPhone !== expectedNewPhone) {
      const rolledBack = await rollbackAuthPhone(
        uid,
        actualNewPhone,
        oldPhone
      );

      await writeOperation(uid, {
        status: rolledBack ? 'rolled-back' : 'uncertain'
      }).catch(() => {});

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

    await writeOperation(uid, {
      status: 'auth-updated'
    });

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

      await writeOperation(uid, {
        status: rolledBack ? 'rolled-back' : 'uncertain'
      }).catch(() => {});

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

    await writeOperation(uid, {
      status: 'completed',
      completedAt: admin.firestore.FieldValue.serverTimestamp()
    });

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

      await writeOperation(uid, {
        status: 'code-failed'
      }).catch(() => {});

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

    await writeOperation(uid, {
      status: rolledBack ? 'rolled-back' : 'uncertain'
    }).catch(() => {});

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
