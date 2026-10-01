import admin from 'firebase-admin';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

if (!admin.apps.length) {
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (!privateKey) {
    throw new Error('FIREBASE_PRIVATE_KEY is not configured.');
  }

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: privateKey.replace(/\\n/g, '\n')
    })
  });
}

const db = admin.firestore();
const auth = admin.auth();

const IDENTITY_TOOLKIT_URL =
  'https://identitytoolkit.googleapis.com/v1';

const API_KEY = process.env.FIREBASE_WEB_API_KEY;
const ALLOWED_ORIGIN = 'https://ooo610.github.io';
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isValidE164(phone) {
  return /^\+[1-9]\d{7,14}$/.test(phone);
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function cleanString(value, maxLength = 200) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function getBearerToken(req) {
  const header = req.headers.authorization || '';

  if (!header.startsWith('Bearer ')) {
    return null;
  }

  return header.slice(7).trim();
}

async function verifyCurrentUser(req) {
  const idToken = getBearerToken(req);

  if (!idToken) {
    const error = new Error('Missing Authorization token.');
    error.status = 401;
    error.code = 'MISSING_AUTH_TOKEN';
    throw error;
  }

  try {
    const decodedToken = await auth.verifyIdToken(idToken);
    return { idToken, decodedToken };
  } catch (error) {
    const authError = new Error(
      'Invalid or expired authentication token.'
    );
    authError.status = 401;
    authError.code = 'INVALID_AUTH_TOKEN';
    authError.cause = error;
    throw authError;
  }
}

async function callIdentityToolkit(path, body, locale = 'en') {
  if (!API_KEY) {
    const error = new Error(
      'FIREBASE_WEB_API_KEY is not configured.'
    );
    error.status = 500;
    error.code = 'SERVER_CONFIGURATION_ERROR';
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
    // Keep a generic error below.
  }

  if (!response.ok) {
    const providerCode =
      data?.error?.message || 'IDENTITY_TOOLKIT_ERROR';

    const error = new Error(providerCode);
    error.status = response.status;
    error.code = providerCode;
    error.providerResponse = data;
    throw error;
  }

  return data;
}

async function userExistsByPhone(phone) {
  try {
    const user = await auth.getUserByPhoneNumber(phone);
    return user;
  } catch (error) {
    if (error?.code === 'auth/user-not-found') {
      return null;
    }
    throw error;
  }
}

async function userExistsByEmail(email) {
  try {
    const user = await auth.getUserByEmail(email);
    return user;
  } catch (error) {
    if (error?.code === 'auth/user-not-found') {
      return null;
    }
    throw error;
  }
}

function validateSignupPayload(body) {
  const phone = cleanString(body.phone, 30);
  const email = cleanString(body.email, 254).toLowerCase();
  const displayName = cleanString(body.displayName, 256);
  const firstName = cleanString(body.firstName, 80);
  const middleName = cleanString(body.middleName, 80);
  const lastName = cleanString(body.lastName, 80);

  if (!isValidE164(phone)) {
    return {
      ok: false,
      code: 'INVALID_PHONE',
      error: 'Invalid phone number.'
    };
  }

  if (!isValidEmail(email)) {
    return {
      ok: false,
      code: 'INVALID_EMAIL',
      error: 'Invalid email address.'
    };
  }

  if (!displayName || !firstName || !lastName) {
    return {
      ok: false,
      code: 'INVALID_PROFILE',
      error: 'Required profile information is missing.'
    };
  }

  return {
    ok: true,
    phone,
    email,
    displayName,
    firstName,
    middleName,
    lastName,
    fullName: displayName
  };
}

function validateSocialProfile(body) {
  const firstName = cleanString(body.firstName, 80);
  const middleName = cleanString(body.middleName, 80);
  const lastName = cleanString(body.lastName, 80);
  const fullName = cleanString(body.fullName, 256);

  if (!firstName || !lastName || !fullName) {
    return {
      ok: false,
      code: 'INVALID_PROFILE',
      error: 'Required profile information is missing.'
    };
  }

  return {
    ok: true,
    firstName,
    middleName,
    lastName,
    fullName
  };
}

async function commitSignupFirestore(operation) {
  const userRef = db.collection('users').doc(operation.uid);
  const phoneIndexRef = db.collection('phoneIndex').doc(operation.phone);

  await db.runTransaction(async (transaction) => {
    const [userSnap, phoneIndexSnap] = await Promise.all([
      transaction.get(userRef),
      transaction.get(phoneIndexRef)
    ]);

    if (phoneIndexSnap.exists) {
      const existingUid = phoneIndexSnap.data()?.uid || null;

      if (existingUid && existingUid !== operation.uid) {
        const error = new Error(
          'Phone index belongs to another user.'
        );
        error.code = 'PHONE_INDEX_CONFLICT';
        error.status = 409;
        throw error;
      }
    }

    const userData = {
      firstName: operation.firstName,
      middleName: operation.middleName,
      lastName: operation.lastName,
      fullName: operation.fullName,
      email: operation.email,
      phoneNumber: operation.phone,
      role: 'customer',
      profileComplete: true
    };

    // createdAt is written ONLY when the users document
    // does not already exist.
    if (!userSnap.exists) {
      userData.createdAt =
        admin.firestore.FieldValue.serverTimestamp();
    }

    transaction.set(
      userRef,
      userData,
      { merge: true }
    );

    transaction.set(
      phoneIndexRef,
      {
        uid: operation.uid
      },
      { merge: true }
    );
  });
}

async function commitSocialFirestore(operation, uid, newPhone) {
  const userRef = db.collection('users').doc(uid);
  const newIndexRef = db.collection('phoneIndex').doc(newPhone);

  const oldIndexRef = operation.oldPhone
    ? db.collection('phoneIndex').doc(operation.oldPhone)
    : null;

  await db.runTransaction(async (transaction) => {
    const reads = [
      transaction.get(userRef),
      transaction.get(newIndexRef)
    ];

    if (
      oldIndexRef &&
      operation.oldPhone !== newPhone
    ) {
      reads.push(transaction.get(oldIndexRef));
    }

    const results = await Promise.all(reads);

    const userSnap = results[0];
    const newIndexSnap = results[1];
    const oldIndexSnap =
      oldIndexRef &&
      operation.oldPhone !== newPhone
        ? results[2]
        : null;

    if (newIndexSnap.exists) {
      const indexedUid =
        newIndexSnap.data()?.uid || null;

      if (
        indexedUid &&
        indexedUid !== uid
      ) {
        const error = new Error(
          'New phone index belongs to another user.'
        );
        error.code = 'PHONE_INDEX_CONFLICT';
        error.status = 409;
        throw error;
      }
    }

    if (
      oldIndexRef &&
      operation.oldPhone !== newPhone &&
      oldIndexSnap?.exists
    ) {
      const oldOwnerUid =
        oldIndexSnap.data()?.uid || null;

      if (
        !oldOwnerUid ||
        oldOwnerUid === uid
      ) {
        transaction.delete(oldIndexRef);
      }
    }

    const userData = {
      phoneNumber: newPhone,
      firstName: operation.firstName,
      middleName: operation.middleName,
      lastName: operation.lastName,
      fullName: operation.fullName,
      email: operation.email || null,
      role: 'customer',
      profileComplete: true
    };

    // Only the first creation gets createdAt.
    if (!userSnap.exists) {
      userData.createdAt =
        admin.firestore.FieldValue.serverTimestamp();
    }

    transaction.set(
      userRef,
      userData,
      { merge: true }
    );

    transaction.set(
      newIndexRef,
      {
        uid
      },
      { merge: true }
    );
  });
}


async function retryFirestoreWrite(fn) {
  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await fn();
      return;
    } catch (error) {
      lastError = error;

      if (attempt < 3) {
        await sleep(250 * attempt);
      }
    }
  }

  throw lastError;
}

async function deleteCreatedAuthUser(uid) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await auth.deleteUser(uid);
      return true;
    } catch (error) {
      if (error?.code === 'auth/user-not-found') {
        return true;
      }

      console.error(
        `Failed to delete newly-created Auth user (attempt ${attempt}).`,
        error
      );

      if (attempt < 3) {
        await sleep(300 * attempt);
      }
    }
  }

  return false;
}

async function rollbackSocialAuth(
  uid,
  expectedNewPhone,
  oldPhone,
  oldDisplayName
) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const currentUser = await auth.getUser(uid);
      const currentPhone = currentUser.phoneNumber || null;

      // Do not overwrite a different/newer phone change.
      if (currentPhone !== expectedNewPhone) {
        return (
          currentPhone === (oldPhone || null) &&
          (currentUser.displayName || null) === (oldDisplayName || null)
        );
      }

      await auth.updateUser(uid, {
        phoneNumber: oldPhone || null,
        displayName: oldDisplayName || null
      });

      const restoredUser = await auth.getUser(uid);

      return (
        (restoredUser.phoneNumber || null) === (oldPhone || null) &&
        (restoredUser.displayName || null) === (oldDisplayName || null)
      );
    } catch (error) {
      console.error(
        `Auth rollback attempt ${attempt} failed.`,
        error
      );

      if (attempt < 3) {
        await sleep(300 * attempt);
      }
    }
  }

  return false;
}

async function handleSignupStart(req, res, locale) {
  const recaptchaToken = cleanString(req.body?.recaptchaToken, 5000);
  const validation = validateSignupPayload(req.body || {});

  if (!validation.ok) return json(res, 400, validation);
  if (!recaptchaToken) {
    return json(res, 400, { ok: false, code: 'MISSING_RECAPTCHA', error: 'App verification is required.' });
  }

  if (await userExistsByPhone(validation.phone)) {
    return json(res, 409, { ok: false, code: 'PHONE_ALREADY_REGISTERED', error: 'This phone number is already registered.' });
  }
  if (await userExistsByEmail(validation.email)) {
    return json(res, 409, { ok: false, code: 'EMAIL_ALREADY_REGISTERED', error: 'This email address is already registered.' });
  }

  try {
    const result = await callIdentityToolkit('accounts:sendVerificationCode', {
      phoneNumber: validation.phone,
      recaptchaToken
    }, locale);

    const operationId = sealPhoneOperation({
      flow: 'signup',
      phone: validation.phone,
      email: validation.email,
      displayName: validation.displayName,
      firstName: validation.firstName,
      middleName: validation.middleName,
      lastName: validation.lastName,
      fullName: validation.fullName,
      sessionInfo: result.sessionInfo
    });

    return json(res, 200, { ok: true, operationId });
  } catch (error) {
    console.error('Phone signup SMS send failed.', error);
    return json(res, 400, {
      ok: false,
      code: 'PHONE_VERIFICATION_START_FAILED',
      error: 'Could not start phone verification.'
    });
  }
}

async function handleSignupConfirm(req, res, locale) {
  const operationId = cleanString(req.body?.operationId, 10000);
  const code = cleanString(req.body?.code, 20);
  const password = String(req.body?.password ?? '');

  if (!operationId || !/^\d{6}$/.test(code)) {
    return json(res, 400, { ok: false, code: 'INVALID_VERIFICATION_INPUT', error: 'Invalid verification data.' });
  }
  if (password.length < 6) {
    return json(res, 400, { ok: false, code: 'WEAK_PASSWORD', error: 'Password must be at least 6 characters.' });
  }

  let operation;
  try {
    operation = openPhoneOperation(operationId);
  } catch (error) {
    return json(res, 409, {
      ok: false,
      code: error.code || 'PHONE_OPERATION_INVALID',
      error: 'This verification session expired or is invalid. Please start again.'
    });
  }
  if (operation.flow !== 'signup' || !operation.sessionInfo || !operation.phone || !operation.email) {
    return json(res, 400, { ok: false, code: 'INVALID_VERIFICATION_INPUT', error: 'Invalid verification data.' });
  }

  let createdUid = null;
  let authConfigured = false;
  try {
    const result = await callIdentityToolkit('accounts:signInWithPhoneNumber', {
      sessionInfo: operation.sessionInfo,
      code
    }, locale);

    if (!result.localId || !result.isNewUser) {
      return json(res, 409, { ok: false, code: 'PHONE_ALREADY_REGISTERED', error: 'This phone number is already registered.' });
    }

    createdUid = result.localId;
    const createdUser = await auth.getUser(createdUid);
    if ((createdUser.phoneNumber || null) !== operation.phone) {
      const deleted = await deleteCreatedAuthUser(createdUid);
      return json(res, 500, {
        ok: false,
        code: deleted ? 'ACCOUNT_CREATE_REJECTED' : 'ACCOUNT_CREATE_UNCERTAIN',
        error: deleted ? 'The phone verification could not be completed safely.' : 'The account could not be completed or safely restored.'
      });
    }

    const emailUser = await userExistsByEmail(operation.email);
    if (emailUser && emailUser.uid !== createdUid) {
      await deleteCreatedAuthUser(createdUid);
      return json(res, 409, { ok: false, code: 'EMAIL_ALREADY_REGISTERED', error: 'This email address is already registered.' });
    }

    await auth.updateUser(createdUid, {
      email: operation.email,
      emailVerified: false,
      password,
      displayName: operation.displayName
    });
    authConfigured = true;

    await retryFirestoreWrite(() => commitSignupFirestore({ ...operation, uid: createdUid }));
    const customToken = await auth.createCustomToken(createdUid);
    return json(res, 200, { ok: true, customToken, phoneNumber: operation.phone });
  } catch (error) {
    console.error('Phone signup confirmation failed.', error);

    if (createdUid && authConfigured) {
      try {
        await retryFirestoreWrite(() => commitSignupFirestore({ ...operation, uid: createdUid }));
        const customToken = await auth.createCustomToken(createdUid);
        return json(res, 200, { ok: true, customToken, phoneNumber: operation.phone });
      } catch (resumeError) {
        console.error('Signup synchronization retry failed.', resumeError);
      }
    }

    if (createdUid) {
      const deleted = await deleteCreatedAuthUser(createdUid);
      if (!deleted) {
        return json(res, 500, { ok: false, code: 'ACCOUNT_CREATE_UNCERTAIN', error: 'The account could not be completed or safely restored.' });
      }
    }

    if (error?.code === 'INVALID_CODE' || error?.code === 'INVALID_VERIFICATION_CODE' || error?.code === 'SESSION_EXPIRED') {
      return json(res, 400, { ok: false, code: 'INVALID_OR_EXPIRED_CODE', error: 'The verification code is invalid or expired.' });
    }
    if (error?.code === 'EMAIL_EXISTS') {
      return json(res, 409, { ok: false, code: 'EMAIL_ALREADY_REGISTERED', error: 'This email address is already registered.' });
    }
    if (error?.code === 'PASSWORD_DOES_NOT_MEET_REQUIREMENTS' || error?.code === 'auth/password-does-not-meet-requirements') {
      return json(res, 400, { ok: false, code: 'WEAK_PASSWORD', error: 'The password does not meet the account password policy.' });
    }
    if (error?.code === 'PHONE_INDEX_CONFLICT') {
      return json(res, 409, { ok: false, code: 'PHONE_ALREADY_REGISTERED', error: 'This phone number is already registered.' });
    }

    return json(res, 400, { ok: false, code: 'PHONE_CHANGE_CONFIRM_FAILED', error: 'Could not complete the phone verification.' });
  }
}

async function handleSocialStart(req, res, locale) {
  const { decodedToken } = await verifyCurrentUser(req);
  const recaptchaToken = cleanString(req.body?.recaptchaToken, 5000);
  const phone = cleanString(req.body?.phone, 30);
  const profile = validateSocialProfile(req.body || {});

  if (!isValidE164(phone)) {
    return json(res, 400, { ok: false, code: 'INVALID_PHONE', error: 'Invalid phone number.' });
  }
  if (!recaptchaToken) {
    return json(res, 400, { ok: false, code: 'MISSING_RECAPTCHA', error: 'App verification is required.' });
  }
  if (!profile.ok) return json(res, 400, profile);

  const uid = decodedToken.uid;
  const userRecord = await auth.getUser(uid);
  const oldPhone = userRecord.phoneNumber || null;
  if (oldPhone === phone) {
    return json(res, 400, { ok: false, code: 'PHONE_UNCHANGED', error: 'The new phone number is the same as the current one.' });
  }

  const phoneUser = await userExistsByPhone(phone);
  if (phoneUser && phoneUser.uid !== uid) {
    return json(res, 409, { ok: false, code: 'PHONE_ALREADY_REGISTERED', error: 'This phone number is already registered to another account.' });
  }

  try {
    const result = await callIdentityToolkit('accounts:sendVerificationCode', {
      phoneNumber: phone,
      recaptchaToken
    }, locale);

    const operationId = sealPhoneOperation({
      flow: 'social',
      uid,
      oldPhone,
      phone,
      oldDisplayName: userRecord.displayName || null,
      firstName: profile.firstName,
      middleName: profile.middleName,
      lastName: profile.lastName,
      fullName: profile.fullName,
      email: userRecord.email || null,
      sessionInfo: result.sessionInfo
    });

    return json(res, 200, { ok: true, operationId });
  } catch (error) {
    console.error('Social phone SMS send failed.', error);
    return json(res, 400, { ok: false, code: 'PHONE_VERIFICATION_START_FAILED', error: 'Could not start phone verification.' });
  }
}

async function handleSocialConfirm(req, res, locale) {
  const { idToken, decodedToken } = await verifyCurrentUser(req);
  const operationId = cleanString(req.body?.operationId, 10000);
  const code = cleanString(req.body?.code, 20);

  if (!operationId || !/^\d{6}$/.test(code)) {
    return json(res, 400, { ok: false, code: 'INVALID_VERIFICATION_INPUT', error: 'Invalid verification data.' });
  }

  let operation;
  try {
    operation = openPhoneOperation(operationId);
  } catch (error) {
    return json(res, 409, {
      ok: false,
      code: error.code || 'PHONE_OPERATION_INVALID',
      error: 'This verification session expired or is invalid. Please start again.'
    });
  }

  const uid = decodedToken.uid;
  if (operation.flow !== 'social' || operation.uid !== uid || !operation.sessionInfo || !operation.phone) {
    return json(res, 403, { ok: false, code: 'OPERATION_OWNER_MISMATCH', error: 'This verification operation does not belong to this account.' });
  }

  const expectedNewPhone = operation.phone;
  const oldPhone = operation.oldPhone || null;
  const oldDisplayName = operation.oldDisplayName || null;

  async function restoreAndRespond(error) {
    console.error('Social phone synchronization failed.', error);
    const rolledBack = await rollbackSocialAuth(uid, expectedNewPhone, oldPhone, oldDisplayName);
    return json(res, 500, {
      ok: false,
      code: rolledBack ? 'PHONE_CHANGE_REJECTED' : 'PHONE_CHANGE_UNCERTAIN',
      error: rolledBack
        ? 'The phone change could not be completed. The previous number was restored.'
        : 'The phone change could not be completed or safely restored.'
    });
  }

  try {
    const currentUser = await auth.getUser(uid);
    const currentPhone = currentUser.phoneNumber || null;
    if (currentPhone !== oldPhone) {
      return json(res, 409, { ok: false, code: 'PHONE_CHANGE_STATE_CHANGED', error: 'The account phone number changed. Start verification again.' });
    }

    const result = await callIdentityToolkit('accounts:signInWithPhoneNumber', {
      sessionInfo: operation.sessionInfo,
      code,
      idToken,
      operation: 'UPDATE'
    }, locale);

    if (result.localId !== uid || result.phoneNumber !== expectedNewPhone) {
      const rolledBack = await rollbackSocialAuth(uid, result.phoneNumber || expectedNewPhone, oldPhone, oldDisplayName);
      return json(res, 500, {
        ok: false,
        code: rolledBack ? 'PHONE_CHANGE_REJECTED' : 'PHONE_CHANGE_UNCERTAIN',
        error: rolledBack
          ? 'The phone change was rejected and the previous number was restored.'
          : 'The phone change could not be completed or safely restored.'
      });
    }

    try {
      await auth.updateUser(uid, { displayName: operation.fullName });
      await retryFirestoreWrite(() => commitSocialFirestore(operation, uid, expectedNewPhone));
      return json(res, 200, { ok: true, phoneNumber: expectedNewPhone });
    } catch (error) {
      return await restoreAndRespond(error);
    }
  } catch (error) {
    console.error('Social phone verification failed.', error);

    if (error?.code === 'INVALID_CODE' || error?.code === 'INVALID_VERIFICATION_CODE' || error?.code === 'SESSION_EXPIRED') {
      return json(res, 400, { ok: false, code: 'INVALID_OR_EXPIRED_CODE', error: 'The verification code is invalid or expired.' });
    }
    if (error?.code === 'CREDENTIAL_TOO_OLD_LOGIN_AGAIN') {
      return json(res, 401, { ok: false, code: 'RECENT_LOGIN_REQUIRED', error: 'Recent authentication is required.' });
    }
    return json(res, 400, { ok: false, code: 'PHONE_CHANGE_CONFIRM_FAILED', error: 'Could not complete the phone verification.' });
  }
}
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Authorization, Content-Type'
  );

  if (req.headers.origin && req.headers.origin !== ALLOWED_ORIGIN) {
    return json(res, 403, {
      ok: false,
      code: 'ORIGIN_NOT_ALLOWED',
      error: 'Origin not allowed.'
    });
  }

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

  const flow = req.body?.flow;
  const action = req.body?.action;
  const locale = req.body?.locale === 'ar' ? 'ar' : 'en';

  try {
    if (flow === 'signup') {
      if (action === 'start') {
        return await handleSignupStart(req, res, locale);
      }

      if (action === 'confirm') {
        return await handleSignupConfirm(req, res, locale);
      }
    }

    if (flow === 'social') {
      if (action === 'start') {
        return await handleSocialStart(req, res, locale);
      }

      if (action === 'confirm') {
        return await handleSocialConfirm(req, res, locale);
      }
    }

    return json(res, 400, {
      ok: false,
      code: 'INVALID_ACTION',
      error: 'Invalid phone verification action.'
    });
  } catch (error) {
    console.error('Phone register API error.', error);

    return json(res, error.status || 500, {
      ok: false,
      code: error.code || 'INTERNAL_ERROR',
      error:
        error.status === 401
          ? 'Authentication is required.'
          : 'The phone verification could not be completed.'
    });
  }
}
