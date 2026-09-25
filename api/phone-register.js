import admin from 'firebase-admin';
import { randomUUID } from 'node:crypto';

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
const OPERATION_TTL_MS = 15 * 60 * 1000;

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

function getOperationAgeMs(operation) {
  const createdAt = operation?.createdAt;

  if (!createdAt) {
    return Number.POSITIVE_INFINITY;
  }

  if (typeof createdAt.toMillis === 'function') {
    return Date.now() - createdAt.toMillis();
  }

  const parsed = new Date(createdAt).getTime();

  if (Number.isNaN(parsed)) {
    return Number.POSITIVE_INFINITY;
  }

  return Date.now() - parsed;
}

function isExpiredOperation(operation) {
  return getOperationAgeMs(operation) > OPERATION_TTL_MS;
}

async function writeOperation(collectionName, operationId, values) {
  await db.collection(collectionName).doc(operationId).set(
    {
      ...values,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    },
    { merge: true }
  );
}

async function getOperation(collectionName, operationId) {
  const ref = db.collection(collectionName).doc(operationId);
  const snap = await ref.get();

  return {
    ref,
    exists: snap.exists,
    data: snap.exists ? snap.data() : null
  };
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

  const phoneIndexSnap = await phoneIndexRef.get();

  if (phoneIndexSnap.exists) {
    const existingUid = phoneIndexSnap.data()?.uid || null;

    if (existingUid && existingUid !== operation.uid) {
      const error = new Error('Phone index belongs to another user.');
      error.code = 'PHONE_INDEX_CONFLICT';
      error.status = 409;
      throw error;
    }
  }

  const batch = db.batch();

  batch.set(
    userRef,
    {
      firstName: operation.firstName,
      middleName: operation.middleName,
      lastName: operation.lastName,
      fullName: operation.fullName,
      email: operation.email,
      phoneNumber: operation.phone,
      role: 'customer',
      profileComplete: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    },
    { merge: true }
  );

  batch.set(
    phoneIndexRef,
    {
      uid: operation.uid,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    },
    { merge: true }
  );

  await batch.commit();
}

async function commitSocialFirestore(operation, uid, newPhone) {
  const userRef = db.collection('users').doc(uid);
  const newIndexRef = db.collection('phoneIndex').doc(newPhone);
  const oldIndexRef = operation.oldPhone
    ? db.collection('phoneIndex').doc(operation.oldPhone)
    : null;

  const newIndexSnap = await newIndexRef.get();

  if (newIndexSnap.exists) {
    const indexedUid = newIndexSnap.data()?.uid || null;

    if (indexedUid && indexedUid !== uid) {
      const error = new Error('New phone index belongs to another user.');
      error.code = 'PHONE_INDEX_CONFLICT';
      error.status = 409;
      throw error;
    }
  }

  let oldIndexSnap = null;

  if (oldIndexRef && operation.oldPhone !== newPhone) {
    oldIndexSnap = await oldIndexRef.get();
  }

  const batch = db.batch();

  if (oldIndexRef && operation.oldPhone !== newPhone) {
    if (!oldIndexSnap?.exists) {
      // Nothing to delete.
    } else {
      const oldOwnerUid = oldIndexSnap.data()?.uid || null;

      if (!oldOwnerUid || oldOwnerUid === uid) {
        batch.delete(oldIndexRef);
      }
    }
  }

  batch.set(
    newIndexRef,
    {
      uid,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    },
    { merge: true }
  );

  batch.set(
    userRef,
    {
      phoneNumber: newPhone,
      firstName: operation.firstName,
      middleName: operation.middleName,
      lastName: operation.lastName,
      fullName: operation.fullName,
      email: operation.email || null,
      role: 'customer',
      profileComplete: true,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    },
    { merge: true }
  );

  await batch.commit();
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

  if (!validation.ok) {
    return json(res, 400, validation);
  }

  if (!recaptchaToken) {
    return json(res, 400, {
      ok: false,
      code: 'MISSING_RECAPTCHA',
      error: 'App verification is required.'
    });
  }

  const phoneUser = await userExistsByPhone(validation.phone);

  if (phoneUser) {
    return json(res, 409, {
      ok: false,
      code: 'PHONE_ALREADY_REGISTERED',
      error: 'This phone number is already registered.'
    });
  }

  const emailUser = await userExistsByEmail(validation.email);

  if (emailUser) {
    return json(res, 409, {
      ok: false,
      code: 'EMAIL_ALREADY_REGISTERED',
      error: 'This email address is already registered.'
    });
  }

  const operationId = randomUUID();

  await writeOperation('phoneSignupOperations', operationId, {
    flow: 'signup',
    status: 'pending',
    phone: validation.phone,
    email: validation.email,
    displayName: validation.displayName,
    firstName: validation.firstName,
    middleName: validation.middleName,
    lastName: validation.lastName,
    fullName: validation.fullName,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });

  try {
    const result = await callIdentityToolkit(
      'accounts:sendVerificationCode',
      {
        phoneNumber: validation.phone,
        recaptchaToken
      },
      locale
    );

    await writeOperation('phoneSignupOperations', operationId, {
      status: 'code-sent',
      sessionInfo: result.sessionInfo
    });

    return json(res, 200, {
      ok: true,
      operationId
    });
  } catch (error) {
    await writeOperation(
      'phoneSignupOperations',
      operationId,
      { status: 'failed' }
    ).catch((writeError) => {
      console.error(
        'Failed to mark signup operation as failed.',
        writeError
      );
    });

    console.error('Phone signup SMS send failed.', error);

    return json(res, 400, {
      ok: false,
      code: 'PHONE_VERIFICATION_START_FAILED',
      error: 'Could not start phone verification.'
    });
  }
}

async function handleSignupConfirm(req, res, locale) {
  const operationId = cleanString(req.body?.operationId, 100);
  const code = cleanString(req.body?.code, 20);
  const password = String(req.body?.password ?? '');

  if (!operationId || !/^\d{6}$/.test(code)) {
    return json(res, 400, {
      ok: false,
      code: 'INVALID_VERIFICATION_INPUT',
      error: 'Invalid verification data.'
    });
  }

  if (password.length < 6) {
    return json(res, 400, {
      ok: false,
      code: 'WEAK_PASSWORD',
      error: 'Password must be at least 6 characters.'
    });
  }

  const { ref: operationRef, exists, data: operation } =
    await getOperation('phoneSignupOperations', operationId);

  if (!exists || !operation) {
    return json(res, 404, {
      ok: false,
      code: 'PHONE_OPERATION_NOT_FOUND',
      error: 'The verification operation was not found.'
    });
  }

  if (operation.status === 'completed') {
    return json(res, 200, {
      ok: true,
      alreadyCompleted: true
    });
  }

  if (isExpiredOperation(operation)) {
    await writeOperation(
      'phoneSignupOperations',
      operationId,
      { status: 'expired' }
    ).catch(() => {});

    return json(res, 409, {
      ok: false,
      code: 'PHONE_OPERATION_EXPIRED',
      error: 'This verification session has expired. Please start again.'
    });
  }

  if (operation.status === 'auth-created') {
    // A previous request already created Auth successfully.
    // Resume the Firestore phase without asking for the SMS code again.
    try {
      await retryFirestoreWrite(() =>
        commitSignupFirestore(operation)
      );

      await writeOperation(
        'phoneSignupOperations',
        operationId,
        {
          status: 'completed',
          completedAt: admin.firestore.FieldValue.serverTimestamp()
        }
      );

      const customToken = await auth.createCustomToken(operation.uid);

      return json(res, 200, {
        ok: true,
        customToken
      });
    } catch (error) {
      console.error(
        'Failed to resume signup after Auth creation.',
        error
      );

      return json(res, 500, {
        ok: false,
        code: 'ACCOUNT_CREATE_UNCERTAIN',
        error:
          'The account was created, but final database synchronization is still pending.'
      });
    }
  }

  if (operation.status !== 'code-sent') {
    return json(res, 409, {
      ok: false,
      code: 'PHONE_VERIFICATION_NOT_PENDING',
      error: 'No active phone verification operation was found.'
    });
  }

  let createdUid = null;
  let authConfigured = false;

  try {
    // No Firebase Auth account is changed by the browser.
    // Identity Toolkit verifies the SMS code on the server.
    const result = await callIdentityToolkit(
      'accounts:signInWithPhoneNumber',
      {
        sessionInfo: operation.sessionInfo,
        code
      },
      locale
    );

    if (!result.localId || !result.isNewUser) {
      return json(res, 409, {
        ok: false,
        code: 'PHONE_ALREADY_REGISTERED',
        error: 'This phone number is already registered.'
      });
    }

    createdUid = result.localId;

    const createdUser = await auth.getUser(createdUid);

    if ((createdUser.phoneNumber || null) !== operation.phone) {
      const deleted = await deleteCreatedAuthUser(createdUid);

      await writeOperation(
        'phoneSignupOperations',
        operationId,
        { status: deleted ? 'rolled-back' : 'uncertain', uid: createdUid }
      ).catch(() => {});

      return json(res, 500, {
        ok: false,
        code: deleted
          ? 'ACCOUNT_CREATE_REJECTED'
          : 'ACCOUNT_CREATE_UNCERTAIN',
        error: deleted
          ? 'The phone verification could not be completed safely.'
          : 'The account could not be completed or safely restored.'
      });
    }

    const emailUser = await userExistsByEmail(operation.email);

    if (emailUser && emailUser.uid !== createdUid) {
      const deleted = await deleteCreatedAuthUser(createdUid);

      await writeOperation(
        'phoneSignupOperations',
        operationId,
        { status: deleted ? 'rolled-back' : 'uncertain', uid: createdUid }
      ).catch(() => {});

      return json(res, 409, {
        ok: false,
        code: 'EMAIL_ALREADY_REGISTERED',
        error: 'This email address is already registered.'
      });
    }

    // The server now owns the rest of the Auth account creation.
    await auth.updateUser(createdUid, {
      email: operation.email,
      emailVerified: false,
      password,
      displayName: operation.displayName
    });

    authConfigured = true;

    await writeOperation(
      'phoneSignupOperations',
      operationId,
      {
        status: 'auth-created',
        uid: createdUid
      }
    );

    const operationForFirestore = {
      ...operation,
      uid: createdUid
    };

    try {
      await retryFirestoreWrite(() =>
        commitSignupFirestore(operationForFirestore)
      );
    } catch (firestoreError) {
      console.error(
        'Signup Firestore synchronization failed.',
        firestoreError
      );

      const deleted = await deleteCreatedAuthUser(createdUid);

      await writeOperation(
        'phoneSignupOperations',
        operationId,
        {
          status: deleted ? 'rolled-back' : 'uncertain'
        }
      ).catch(() => {});

      if (!deleted) {
        return json(res, 500, {
          ok: false,
          code: 'ACCOUNT_CREATE_UNCERTAIN',
          error:
            'The account could not be completed or safely restored.'
        });
      }

      return json(res, 500, {
        ok: false,
        code: 'ACCOUNT_CREATE_REJECTED',
        error:
          'The account could not be completed. No account was kept.'
      });
    }

    await writeOperation(
      'phoneSignupOperations',
      operationId,
      {
        status: 'completed',
        completedAt: admin.firestore.FieldValue.serverTimestamp()
      }
    );

    // The account is now complete. This token only signs the browser in;
    // it is not used to perform the phone/Firestore mutations.
    const customToken = await auth.createCustomToken(createdUid);

    return json(res, 200, {
      ok: true,
      customToken,
      phoneNumber: operation.phone
    });
  } catch (error) {
    console.error('Phone signup confirmation failed.', error);

    // If the phone-auth user was created but the server failed before
    // finishing its Auth configuration, remove that partial signup.
    if (createdUid && !authConfigured) {
      const deleted = await deleteCreatedAuthUser(createdUid);

      await writeOperation(
        'phoneSignupOperations',
        operationId,
        {
          status: deleted ? 'rolled-back' : 'uncertain',
          uid: createdUid
        }
      ).catch(() => {});

      if (!deleted) {
        return json(res, 500, {
          ok: false,
          code: 'ACCOUNT_CREATE_UNCERTAIN',
          error:
            'The account could not be completed or safely restored.'
        });
      }

      if (error?.code === 'EMAIL_EXISTS') {
        return json(res, 409, {
          ok: false,
          code: 'EMAIL_ALREADY_REGISTERED',
          error: 'This email address is already registered.'
        });
      }

      if (
        error?.code === 'PASSWORD_DOES_NOT_MEET_REQUIREMENTS' ||
        error?.code === 'auth/password-does-not-meet-requirements'
      ) {
        return json(res, 400, {
          ok: false,
          code: 'WEAK_PASSWORD',
          error: 'The password does not meet the account password policy.'
        });
      }

      return json(res, 400, {
        ok: false,
        code: 'ACCOUNT_CREATE_REJECTED',
        error: 'The account could not be completed. Please try again.'
      });
    }

    // If the Auth user was created before the request failed unexpectedly,
    // determine the real server-side state before deciding what to do.
    if (createdUid) {
      try {
        const currentUser = await auth.getUser(createdUid);

        if (
          currentUser.phoneNumber === operation.phone &&
          currentUser.email === operation.email
        ) {
          try {
            const operationData = {
              ...operation,
              uid: createdUid
            };

            await retryFirestoreWrite(() =>
              commitSignupFirestore(operationData)
            );

            await writeOperation(
              'phoneSignupOperations',
              operationId,
              {
                status: 'completed',
                completedAt: admin.firestore.FieldValue.serverTimestamp(),
                uid: createdUid
              }
            );

            const customToken = await auth.createCustomToken(createdUid);

            return json(res, 200, {
              ok: true,
              customToken,
              phoneNumber: operation.phone
            });
          } catch (resumeError) {
            console.error(
              'Signup recovery after unexpected error failed.',
              resumeError
            );

            await writeOperation(
              'phoneSignupOperations',
              operationId,
              {
                status: 'uncertain',
                uid: createdUid
              }
            ).catch(() => {});

            return json(res, 500, {
              ok: false,
              code: 'ACCOUNT_CREATE_UNCERTAIN',
              error:
                'The account was created, but final synchronization could not be confirmed.'
            });
          }
        }
      } catch {
        // Continue to normal error handling below.
      }
    }

    if (
      error?.code === 'INVALID_CODE' ||
      error?.code === 'INVALID_VERIFICATION_CODE' ||
      error?.code === 'SESSION_EXPIRED'
    ) {
      await writeOperation(
        'phoneSignupOperations',
        operationId,
        { status: 'code-failed' }
      ).catch(() => {});

      return json(res, 400, {
        ok: false,
        code: 'INVALID_OR_EXPIRED_CODE',
        error: 'The verification code is invalid or expired.'
      });
    }

    if (error?.code === 'EMAIL_EXISTS') {
      return json(res, 409, {
        ok: false,
        code: 'EMAIL_ALREADY_REGISTERED',
        error: 'This email address is already registered.'
      });
    }

    if (error?.code === 'PASSWORD_DOES_NOT_MEET_REQUIREMENTS') {
      return json(res, 400, {
        ok: false,
        code: 'WEAK_PASSWORD',
        error: 'The password does not meet the account password policy.'
      });
    }

    return json(res, 400, {
      ok: false,
      code: 'PHONE_CHANGE_CONFIRM_FAILED',
      error: 'Could not complete the phone verification.'
    });
  }
}

async function handleSocialStart(req, res, locale) {
  const { decodedToken } = await verifyCurrentUser(req);
  const recaptchaToken = cleanString(req.body?.recaptchaToken, 5000);
  const phone = cleanString(req.body?.phone, 30);
  const profileValidation = validateSocialProfile(req.body || {});

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

  if (!profileValidation.ok) {
    return json(res, 400, profileValidation);
  }

  const uid = decodedToken.uid;
  const userRecord = await auth.getUser(uid);
  const oldPhone = userRecord.phoneNumber || null;

  if (oldPhone === phone) {
    return json(res, 400, {
      ok: false,
      code: 'PHONE_UNCHANGED',
      error: 'The new phone number is the same as the current one.'
    });
  }

  const phoneUser = await userExistsByPhone(phone);

  if (phoneUser && phoneUser.uid !== uid) {
    return json(res, 409, {
      ok: false,
      code: 'PHONE_ALREADY_REGISTERED',
      error: 'This phone number is already registered to another account.'
    });
  }

  const operationId = uid;
  const existing = await getOperation(
    'phoneSocialOperations',
    operationId
  );

  if (
    existing.exists &&
    existing.data &&
    ['pending', 'code-sent', 'auth-updated'].includes(
      existing.data.status
    ) &&
    !isExpiredOperation(existing.data)
  ) {
    return json(res, 409, {
      ok: false,
      code: 'PHONE_CHANGE_ALREADY_PENDING',
      error: 'A phone verification operation is already in progress.'
    });
  }

  await writeOperation('phoneSocialOperations', operationId, {
    flow: 'social',
    status: 'pending',
    uid,
    oldPhone,
    phone,
    oldDisplayName: userRecord.displayName || null,
    firstName: profileValidation.firstName,
    middleName: profileValidation.middleName,
    lastName: profileValidation.lastName,
    fullName: profileValidation.fullName,
    email: userRecord.email || null,
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

    await writeOperation('phoneSocialOperations', operationId, {
      status: 'code-sent',
      sessionInfo: result.sessionInfo
    });

    return json(res, 200, {
      ok: true,
      operationId
    });
  } catch (error) {
    await writeOperation(
      'phoneSocialOperations',
      operationId,
      { status: 'failed' }
    ).catch(() => {});

    console.error('Social phone SMS send failed.', error);

    return json(res, 400, {
      ok: false,
      code: 'PHONE_VERIFICATION_START_FAILED',
      error: 'Could not start phone verification.'
    });
  }
}

async function handleSocialConfirm(req, res, locale) {
  const { idToken, decodedToken } = await verifyCurrentUser(req);
  const operationId = cleanString(req.body?.operationId, 100);
  const code = cleanString(req.body?.code, 20);

  if (!operationId || !/^\d{6}$/.test(code)) {
    return json(res, 400, {
      ok: false,
      code: 'INVALID_VERIFICATION_INPUT',
      error: 'Invalid verification data.'
    });
  }

  if (operationId !== decodedToken.uid) {
    return json(res, 403, {
      ok: false,
      code: 'OPERATION_OWNER_MISMATCH',
      error: 'This verification operation does not belong to this account.'
    });
  }

  const { data: operation, exists } = await getOperation(
    'phoneSocialOperations',
    operationId
  );

  if (!exists || !operation) {
    return json(res, 404, {
      ok: false,
      code: 'PHONE_OPERATION_NOT_FOUND',
      error: 'The verification operation was not found.'
    });
  }

  if (operation.status === 'completed') {
    return json(res, 200, {
      ok: true,
      alreadyCompleted: true
    });
  }

  if (isExpiredOperation(operation)) {
    await writeOperation(
      'phoneSocialOperations',
      operationId,
      { status: 'expired' }
    ).catch(() => {});

    return json(res, 409, {
      ok: false,
      code: 'PHONE_OPERATION_EXPIRED',
      error: 'This verification session has expired. Please start again.'
    });
  }

  const uid = decodedToken.uid;
  const oldPhone = operation.oldPhone || null;
  const expectedNewPhone = operation.phone || null;
  const oldDisplayName = operation.oldDisplayName || null;

  let authChanged = false;

  if (operation.status === 'auth-updated') {
    try {
      const currentUser = await auth.getUser(uid);

      if ((currentUser.phoneNumber || null) !== expectedNewPhone) {
        return json(res, 409, {
          ok: false,
          code: 'PHONE_CHANGE_UNCERTAIN',
          error: 'The account phone state could not be confirmed safely.'
        });
      }

      await retryFirestoreWrite(() =>
        commitSocialFirestore(operation, uid, expectedNewPhone)
      );

      await writeOperation(
        'phoneSocialOperations',
        operationId,
        {
          status: 'completed',
          completedAt: admin.firestore.FieldValue.serverTimestamp()
        }
      );

      return json(res, 200, {
        ok: true,
        phoneNumber: expectedNewPhone
      });
    } catch (error) {
      console.error('Failed to resume social phone synchronization.', error);
      return json(res, 500, {
        ok: false,
        code: 'PHONE_CHANGE_UNCERTAIN',
        error:
          'The phone was changed, but final synchronization could not be confirmed.'
      });
    }
  }

  if (operation.status !== 'code-sent') {
    return json(res, 409, {
      ok: false,
      code: 'PHONE_VERIFICATION_NOT_PENDING',
      error: 'No active phone verification operation was found.'
    });
  }

  try {
    // The browser does not call updatePhoneNumber/linkWithPhoneNumber.
    // Identity Toolkit performs the verified phone update server-side.
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

    if (result.localId !== uid || result.phoneNumber !== expectedNewPhone) {
      const rolledBack = await rollbackSocialAuth(
        uid,
        result.phoneNumber || expectedNewPhone,
        oldPhone,
        oldDisplayName
      );

      await writeOperation(
        'phoneSocialOperations',
        operationId,
        { status: rolledBack ? 'rolled-back' : 'uncertain' }
      ).catch(() => {});

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

    authChanged = true;

    // Keep display-name update server-owned too.
    await auth.updateUser(uid, {
      displayName: operation.fullName
    });

    await writeOperation(
      'phoneSocialOperations',
      operationId,
      { status: 'auth-updated' }
    );

    try {
      await retryFirestoreWrite(() =>
        commitSocialFirestore(operation, uid, expectedNewPhone)
      );
    } catch (firestoreError) {
      console.error(
        'Social Firestore synchronization failed.',
        firestoreError
      );

      const rolledBack = await rollbackSocialAuth(
        uid,
        expectedNewPhone,
        oldPhone,
        oldDisplayName
      );

      await writeOperation(
        'phoneSocialOperations',
        operationId,
        { status: rolledBack ? 'rolled-back' : 'uncertain' }
      ).catch(() => {});

      if (!rolledBack) {
        return json(res, 500, {
          ok: false,
          code: 'PHONE_CHANGE_UNCERTAIN',
          error:
            'The phone was verified, but the account could not be synchronized or safely restored.'
        });
      }

      return json(res, 500, {
        ok: false,
        code: 'PHONE_CHANGE_REJECTED',
        error:
          'The phone was verified, but the account update could not be completed. The previous number was restored.'
      });
    }

    await writeOperation(
      'phoneSocialOperations',
      operationId,
      {
        status: 'completed',
        completedAt: admin.firestore.FieldValue.serverTimestamp()
      }
    );

    return json(res, 200, {
      ok: true,
      phoneNumber: expectedNewPhone
    });
  } catch (error) {
    console.error('Social phone verification failed.', error);

    // A network/error response from Identity Toolkit can be ambiguous:
    // verify Auth directly before deciding whether the SMS update happened.
    try {
      const currentUser = await auth.getUser(uid);
      const currentPhone = currentUser.phoneNumber || null;

      if (currentPhone === expectedNewPhone) {
        authChanged = true;

        try {
          await auth.updateUser(uid, {
            displayName: operation.fullName
          });

          await writeOperation(
            'phoneSocialOperations',
            operationId,
            { status: 'auth-updated' }
          );

          await retryFirestoreWrite(() =>
            commitSocialFirestore(operation, uid, expectedNewPhone)
          );

          await writeOperation(
            'phoneSocialOperations',
            operationId,
            {
              status: 'completed',
              completedAt: admin.firestore.FieldValue.serverTimestamp()
            }
          );

          return json(res, 200, {
            ok: true,
            phoneNumber: expectedNewPhone
          });
        } catch (resumeError) {
          console.error(
            'Social recovery after confirmed Auth update failed.',
            resumeError
          );

          const rolledBack = await rollbackSocialAuth(
            uid,
            expectedNewPhone,
            oldPhone,
            oldDisplayName
          );

          await writeOperation(
            'phoneSocialOperations',
            operationId,
            { status: rolledBack ? 'rolled-back' : 'uncertain' }
          ).catch(() => {});

          return json(res, 500, {
            ok: false,
            code: rolledBack
              ? 'PHONE_CHANGE_REJECTED'
              : 'PHONE_CHANGE_UNCERTAIN',
            error: rolledBack
              ? 'The phone change failed and the previous number was restored.'
              : 'The phone change could not be completed or safely restored.'
          });
        }
      }
    } catch {
      // Continue with the regular error handling below.
    }

    if (!authChanged) {
      if (error?.code === 'INVALID_CODE' ||
          error?.code === 'INVALID_VERIFICATION_CODE' ||
          error?.code === 'SESSION_EXPIRED') {
        return json(res, 400, {
          ok: false,
          code: 'INVALID_OR_EXPIRED_CODE',
          error: 'The verification code is invalid or expired.'
        });
      }

      if (error?.code === 'CREDENTIAL_TOO_OLD_LOGIN_AGAIN') {
        return json(res, 401, {
          ok: false,
          code: 'RECENT_LOGIN_REQUIRED',
          error: 'Recent authentication is required.'
        });
      }

      return json(res, 400, {
        ok: false,
        code: 'PHONE_CHANGE_CONFIRM_FAILED',
        error: 'Could not verify the phone number.'
      });
    }

    return json(res, 500, {
      ok: false,
      code: 'PHONE_CHANGE_UNCERTAIN',
      error:
        'The phone was verified, but the account state could not be confirmed safely.'
    });
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
