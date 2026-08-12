import { auth } from './firebase-config.js';
  import {
    onAuthStateChanged,
    signOut
  } from 'https://www.gstatic.com/firebasejs/12.17.1/firebase-auth.js';

  const signInBtn = document.getElementById('sign-in-btn');

  // ── نسخة الموبايل: زرارين منفصلين بدل dropdown ──
  const mobileSignInBtn = document.getElementById('mobile-sign-in-btn');
  const mobileAccountLinks = document.getElementById('mobile-account-links');
  const mobileLogoutBtn = document.getElementById('mobile-logout-btn');

  function updateMobileAuthUI(user) {
    if (!mobileSignInBtn || !mobileAccountLinks) return;
    if (user) {
      mobileSignInBtn.classList.add('hidden');
      mobileAccountLinks.classList.remove('hidden');
    } else {
      mobileSignInBtn.classList.remove('hidden');
      mobileAccountLinks.classList.add('hidden');
    }
  }

  if (mobileLogoutBtn) {
    mobileLogoutBtn.addEventListener('click', async function () {
      try {
        await signOut(auth);
        // onAuthStateChanged هيرجع الواجهة تلقائيًا لحالة "مسجل خروج".
        if (typeof closeMobileMenu === 'function') {
          closeMobileMenu(); // لو الدالة دي موجودة عندك في script.js
        }
      } catch (error) {
        alert('تعذر تسجيل الخروج. حاول مرة أخرى.');
      }
    });
  }

  if (signInBtn) {
    const originalHtml = signInBtn.innerHTML;
    const originalHref = signInBtn.getAttribute('href');
    let currentUser = null;

    // نضع الزر والقائمة داخل حاوية واحدة لضبط مكان القائمة تحته.
    const wrapper = document.createElement('div');
    wrapper.className = 'relative';

    signInBtn.parentNode.insertBefore(wrapper, signInBtn);
    wrapper.appendChild(signInBtn);

    const menu = document.createElement('div');
    menu.className = 'hidden absolute left-0 mt-3 w-48 overflow-hidden rounded-xl bg-white shadow-xl border border-gray-100 z-50 text-right';
    menu.innerHTML = `
      <a href="./settings-ar.html"
         class="block px-4 py-3 text-sm font-semibold text-bc-charcoal hover:bg-gray-50 transition-colors">
        الإعدادات
      </a>
      <button id="logout-btn"
              type="button"
              class="w-full px-4 py-3 text-right text-sm font-semibold text-red-600 hover:bg-red-50 transition-colors border-t border-gray-100">
        تسجيل الخروج
      </button>
    `;
    wrapper.appendChild(menu);

    function showSignedOutButton() {
      currentUser = null;
      menu.classList.add('hidden');
      signInBtn.innerHTML = originalHtml;
      signInBtn.setAttribute('href', originalHref);
      signInBtn.removeAttribute('aria-expanded');
    }

    function showSignedInButton(user) {
      currentUser = user;
      signInBtn.innerHTML = '';
      signInBtn.setAttribute('href', '#');
      signInBtn.setAttribute('aria-expanded', 'false');

      const name = user.displayName || user.email || 'حسابي';

      if (user.photoURL) {
        const image = document.createElement('img');
        image.src = user.photoURL;
        image.alt = '';
        image.referrerPolicy = 'no-referrer';
        image.className = 'w-7 h-7 rounded-full object-cover';
        signInBtn.appendChild(image);
      } else {
        const initials = document.createElement('span');
        initials.className = 'w-7 h-7 rounded-full bg-white/20 flex items-center justify-center text-xs';
        initials.textContent = name.trim().charAt(0);
        signInBtn.appendChild(initials);
      }

      const nameText = document.createElement('span');
      nameText.textContent = name;
      signInBtn.appendChild(nameText);
    }

    signInBtn.addEventListener('click', function (event) {
      if (!currentUser) return; // يترك زر Sign In يعمل طبيعيًا

      event.preventDefault();
      menu.classList.toggle('hidden');
      signInBtn.setAttribute(
        'aria-expanded',
        String(!menu.classList.contains('hidden'))
      );
    });

    document.getElementById('logout-btn').addEventListener('click', async function () {
      try {
        await signOut(auth);
        // onAuthStateChanged سيعيد الزر تلقائيًا إلى Sign In.
      } catch (error) {
        alert('تعذر تسجيل الخروج. حاول مرة أخرى.');
      }
    });

    document.addEventListener('click', function (event) {
      if (!wrapper.contains(event.target)) {
        menu.classList.add('hidden');
        signInBtn.setAttribute('aria-expanded', 'false');
      }
    });

    onAuthStateChanged(auth, function (user) {
      if (user) {
        showSignedInButton(user);
      } else {
        showSignedOutButton();
      }
      updateMobileAuthUI(user); // ← تحديث نسخة الموبايل مع كل تغيير في حالة الدخول
    });
  } else {
    // fallback: لو زرار الديسكتوب (sign-in-btn) مش موجود في الصفحة دي أصلاً،
    // نفضل نتابع حالة الموبايل بمفردها.
    onAuthStateChanged(auth, function (user) {
      updateMobileAuthUI(user);
    });
  }