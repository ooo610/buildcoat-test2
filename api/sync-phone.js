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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://ooo610.github.io');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({
      error: 'Method not allowed'
    });
  }

  try {
    const authHeader = req.headers.authorization || '';

    if (!authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        error: 'Missing Authorization token'
      });
    }

    const idToken = authHeader.slice(7);

    const decodedToken = await admin.auth().verifyIdToken(idToken);
    const uid = decodedToken.uid;

    // Get the authenticated user's actual phone number
    // directly from Firebase Authentication.
    const userRecord = await admin.auth().getUser(uid);
    const newPhone = userRecord.phoneNumber;

    if (!newPhone) {
      return res.status(400).json({
        error: 'User does not have a phone number'
      });
    }

    // Get the old phone number from Firestore.
    const db = admin.firestore();
    const userRef = db.collection('users').doc(uid);
    const userSnap = await userRef.get();

    const oldPhone = userSnap.exists
      ? userSnap.data().phoneNumber
      : null;

    const batch = db.batch();

    // Remove the old phone index if the number actually changed.
    if (oldPhone && oldPhone !== newPhone) {
      batch.delete(
        db.collection('phoneIndex').doc(oldPhone)
      );
    }

    // Create/update the new phone index.
    batch.set(
      db.collection('phoneIndex').doc(newPhone),
      { exists: true }
    );

    // Update the user's Firestore document.
    batch.set(
      userRef,
      {
        phoneNumber: newPhone,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );

    await batch.commit();

    return res.status(200).json({
      ok: true
    });

  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error: 'Phone synchronization failed'
    });
  }
}