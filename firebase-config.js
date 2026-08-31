import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.17.1/firebase-app.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/12.17.1/firebase-auth.js';
import { getFirestore, initializeFirestore } from 'https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js';

const firebaseConfig = {
  apiKey: 'AIzaSyCUkWudLdS-LbMOZY0zqvFm-Td73eaNjL4',
  authDomain: 'buildcoat-4b519.firebaseapp.com',
  projectId: 'buildcoat-4b519',
  storageBucket: 'buildcoat-4b519.firebasestorage.app',
  messagingSenderId: '163630785238',
  appId: '1:163630785238:web:48a4df37df902980f31f77',
  measurementId: 'G-2YC6CPGJNK'
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = initializeFirestore(app, {
  experimentalForceLongPolling: true
});