import { auth, db } from './firebase-config.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.17.1/firebase-auth.js';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js';

// Pages where an incomplete profile is allowed — the onboarding flow itself,
// plus the auth entry points. Both language versions are listed.
const EXEMPT_PAGES = [
  'login.html', 'login-ar.html',
  'signup.html', 'signup-ar.html',
  'complete-profile.html', 'complete-profile-ar.html',
  'phone-verify.html', 'phone-verify-ar.html'
];

function currentPageName() {
  const path = window.location.pathname;
  return path.substring(path.lastIndexOf('/') + 1) || 'index.html';
}

function isArabicPage() {
  return document.documentElement.lang === 'ar';
}

onAuthStateChanged(auth, async (user) => {
  // Not signed in — nothing to enforce. Anonymous browsing stays allowed.
  if (!user) return;

  const page = currentPageName();
  if (EXEMPT_PAGES.includes(page)) return;

  try {
    const snap = await getDoc(doc(db, 'users', user.uid));
    const profileComplete = snap.exists() && snap.data().profileComplete === true;

    if (!profileComplete) {
      window.location.replace(
        isArabicPage() ? './complete-profile-ar.html' : './complete-profile.html'
      );
    }
  } catch (err) {
    // Fail open rather than trap the user in a redirect loop if Firestore
    // is briefly unreachable — log it so it's visible during testing.
    console.error('Profile completeness check failed:', err);
  }
});