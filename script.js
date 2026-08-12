/**
 * BuildCoat – Vanilla JavaScript
 * Handles: hero slideshow, hamburger menu, scroll reveal, active nav links, header shadow
 */

'use strict';

/* ══════════════════════════════════════════════════════════
   HERO SLIDESHOW – crossfade between the two banner images
══════════════════════════════════════════════════════════ */
(function initHeroSlideshow() {
  const slides     = document.querySelectorAll('.hero-slide');
  const dots       = document.querySelectorAll('.hero-dot');
  const prevBtn    = document.getElementById('hero-prev');
  const nextBtn    = document.getElementById('hero-next');
  let   current    = 0;
  let   autoTimer  = null;
  const INTERVAL   = 5500; // ms between auto-advances

  if (!slides.length) return;

  function goTo(index) {
    // Deactivate current
    slides[current].classList.remove('hero-slide--active');
    slides[current].setAttribute('aria-hidden', 'true');
    dots[current].classList.remove('hero-dot--active');
    dots[current].setAttribute('aria-selected', 'false');

    // Activate target
    current = (index + slides.length) % slides.length;
    slides[current].classList.add('hero-slide--active');
    slides[current].setAttribute('aria-hidden', 'false');
    dots[current].classList.add('hero-dot--active');
    dots[current].setAttribute('aria-selected', 'true');
  }

  function startAuto() {
    stopAuto();
    autoTimer = setInterval(() => goTo(current + 1), INTERVAL);
  }

  function stopAuto() {
    if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
  }

  // Prev / Next buttons
  if (prevBtn) prevBtn.addEventListener('click', () => { goTo(current - 1); startAuto(); });
  if (nextBtn) nextBtn.addEventListener('click', () => { goTo(current + 1); startAuto(); });

  // Dot buttons
  dots.forEach((dot) => {
    dot.addEventListener('click', () => {
      goTo(parseInt(dot.dataset.slide, 10));
      startAuto();
    });
  });

  // Keyboard support
  document.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft')  { goTo(current - 1); startAuto(); }
    if (e.key === 'ArrowRight') { goTo(current + 1); startAuto(); }
  });

  // Pause on hover
  const slideshow = document.getElementById('hero-slideshow');
  if (slideshow) {
    slideshow.addEventListener('mouseenter', stopAuto);
    slideshow.addEventListener('mouseleave', startAuto);
  }

  // Kick off auto-play
  startAuto();
})();



/* ══════════════════════════════════════════════════════════
   DOM REFERENCES
══════════════════════════════════════════════════════════ */
const hamburgerBtn  = document.getElementById('hamburger-btn');
const mobileMenu    = document.getElementById('mobile-menu');
const siteHeader    = document.getElementById('site-header');
const navLinks      = document.querySelectorAll('.nav-link');
const revealEls     = document.querySelectorAll('.reveal-on-scroll');
const checklistEls  = document.querySelectorAll('.checklist-item');
const sections      = document.querySelectorAll('section[id]');

/* ══════════════════════════════════════════════════════════
   HAMBURGER MENU – toggle open/close
══════════════════════════════════════════════════════════ */
function closeMobileMenu() {
  mobileMenu.classList.remove('open');
  hamburgerBtn.setAttribute('aria-expanded', 'false');
}

hamburgerBtn.addEventListener('click', () => {
  const isOpen = mobileMenu.classList.toggle('open');
  hamburgerBtn.setAttribute('aria-expanded', String(isOpen));
});

// Close menu when clicking outside
document.addEventListener('click', (e) => {
  if (!hamburgerBtn.contains(e.target) && !mobileMenu.contains(e.target)) {
    closeMobileMenu();
  }
});

// Close on Escape key
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMobileMenu();
});

// Expose globally for inline onclick handlers
window.closeMobileMenu = closeMobileMenu;

/* ══════════════════════════════════════════════════════════
   HEADER – add shadow on scroll
══════════════════════════════════════════════════════════ */
function handleHeaderScroll() {
  if (window.scrollY > 20) {
    siteHeader.classList.add('scrolled');
  } else {
    siteHeader.classList.remove('scrolled');
  }
}
window.addEventListener('scroll', handleHeaderScroll, { passive: true });
handleHeaderScroll(); // run once on load

/* ══════════════════════════════════════════════════════════
   ACTIVE NAV LINK – highlight based on scroll position
══════════════════════════════════════════════════════════ */
function updateActiveNavLink() {
  let currentSection = '';

  sections.forEach((section) => {
    const sectionTop    = section.offsetTop - 80;  // header offset
    const sectionBottom = sectionTop + section.offsetHeight;

    if (window.scrollY >= sectionTop && window.scrollY < sectionBottom) {
      currentSection = section.getAttribute('id');
    }
  });

  navLinks.forEach((link) => {
    link.classList.remove('active');
    const href = link.getAttribute('href');
    if (href === `#${currentSection}`) {
      link.classList.add('active');
    }
  });
}
window.addEventListener('scroll', updateActiveNavLink, { passive: true });
updateActiveNavLink();

/* ══════════════════════════════════════════════════════════
   SCROLL REVEAL – IntersectionObserver
══════════════════════════════════════════════════════════ */
const revealObserver = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        revealObserver.unobserve(entry.target); // animate once
      }
    });
  },
  { threshold: 0.12, rootMargin: '0px 0px -40px 0px' }
);

revealEls.forEach((el) => revealObserver.observe(el));

/* ══════════════════════════════════════════════════════════
   CHECKLIST ITEMS – staggered reveal
══════════════════════════════════════════════════════════ */
const checklistObserver = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        const items = entry.target.querySelectorAll('.checklist-item');
        items.forEach((item, i) => {
          setTimeout(() => item.classList.add('visible'), i * 100);
        });
        checklistObserver.unobserve(entry.target);
      }
    });
  },
  { threshold: 0.1 }
);

// Observe all parent containers of checklist items
const checkLists = document.querySelectorAll('ul');
checkLists.forEach((ul) => {
  if (ul.querySelector('.checklist-item')) {
    checklistObserver.observe(ul);
  }
});

/* ══════════════════════════════════════════════════════════
   SMOOTH ANCHOR SCROLL (polyfill for browsers without native)
══════════════════════════════════════════════════════════ */
document.querySelectorAll('a[href^="#"]').forEach((anchor) => {
  anchor.addEventListener('click', function (e) {
    const targetId = this.getAttribute('href');
    if (targetId === '#') return;
    const target = document.querySelector(targetId);
    if (target) {
      e.preventDefault();
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });
});

/* ══════════════════════════════════════════════════════════
   BUTTON RIPPLE EFFECT – micro-interaction on all CTAs
══════════════════════════════════════════════════════════ */
document.querySelectorAll('a[id$="-btn"], a[id$="-now-btn"]').forEach((btn) => {
  btn.addEventListener('click', function (e) {
    const ripple = document.createElement('span');
    const rect   = btn.getBoundingClientRect();
    const size   = Math.max(rect.width, rect.height);
    const x      = e.clientX - rect.left - size / 2;
    const y      = e.clientY - rect.top  - size / 2;

    Object.assign(ripple.style, {
      position:  'absolute',
      width:     `${size}px`,
      height:    `${size}px`,
      left:      `${x}px`,
      top:       `${y}px`,
      background: 'rgba(255,255,255,0.25)',
      borderRadius: '50%',
      transform:  'scale(0)',
      animation:  'rippleEffect 0.5s ease-out forwards',
      pointerEvents: 'none',
    });

    // Ensure button has position: relative for ripple positioning
    const currentPosition = getComputedStyle(btn).position;
    if (currentPosition === 'static') btn.style.position = 'relative';
    btn.style.overflow = 'hidden';
    btn.appendChild(ripple);

    setTimeout(() => ripple.remove(), 600);
  });
});

// Inject ripple keyframe once
const rippleStyle = document.createElement('style');
rippleStyle.textContent = `
  @keyframes rippleEffect {
    to { transform: scale(3); opacity: 0; }
  }
`;
document.head.appendChild(rippleStyle);

/* ══════════════════════════════════════════════════════════
   PRODUCT CARD TILT – subtle mouse-parallax on hover
══════════════════════════════════════════════════════════ */
document.querySelectorAll('.product-card').forEach((card) => {
  card.addEventListener('mousemove', (e) => {
    const rect  = card.getBoundingClientRect();
    const cx    = rect.left + rect.width  / 2;
    const cy    = rect.top  + rect.height / 2;
    const dx    = (e.clientX - cx) / (rect.width  / 2);
    const dy    = (e.clientY - cy) / (rect.height / 2);
    const rotX  = dy * -6;
    const rotY  = dx *  6;

    card.style.transform = `perspective(800px) rotateX(${rotX}deg) rotateY(${rotY}deg) translateY(-6px) scale(1.02)`;
  });

  card.addEventListener('mouseleave', () => {
    card.style.transform = '';
    card.style.transition = 'transform 0.5s cubic-bezier(0.22, 0.61, 0.36, 1)';
  });

  card.addEventListener('mouseenter', () => {
    card.style.transition = 'transform 0.1s linear';
  });
});

/* ══════════════════════════════════════════════════════════
   BEFORE / AFTER SLIDER LOGIC
══════════════════════════════════════════════════════════ */
(function initBeforeAfterSlider() {
  const slider = document.getElementById('special-slider');
  if (!slider) return;

  const beforeImg = slider.querySelector('.slider-before-img');
  const divider = slider.querySelector('.slider-divider');
  let isDragging = false;

  function moveDivider(e) {
    if (!isDragging) return;

    // Get the slider's bounding rectangle
    const rect = slider.getBoundingClientRect();
    
    // Calculate mouse position relative to the slider container
    // Use clientX for mouse, touches[0].clientX for touch devices
    let clientX = e.type.includes('mouse') ? e.clientX : e.touches[0].clientX;
    let x = clientX - rect.left;

    // Constrain x to be within the slider bounds (0 to width)
    x = Math.max(0, Math.min(x, rect.width));

    // Calculate percentage
    const percent = (x / rect.width) * 100;

    // Apply to DOM via clip-path
    const rightClip = 100 - percent;
    beforeImg.style.clipPath = `inset(0 ${rightClip}% 0 0)`;
    divider.style.left = `${percent}%`;
  }

  // Mouse Events
  divider.addEventListener('mousedown', () => { isDragging = true; });
  window.addEventListener('mouseup', () => { isDragging = false; });
  window.addEventListener('mousemove', moveDivider);

  // Touch Events (for mobile)
  divider.addEventListener('touchstart', (e) => {
    isDragging = true;
    // Prevent default scrolling behavior when starting to drag
    e.preventDefault(); 
  }, { passive: false });
  window.addEventListener('touchend', () => { isDragging = false; });
  window.addEventListener('touchmove', (e) => {
    if (isDragging) {
      moveDivider(e);
      // Prevent scrolling while dragging
      e.preventDefault();
    }
  }, { passive: false });
})();

/* ══════════════════════════════════════════════════════════
   SOCIAL ICON TOOLTIP (accessible aria labels already set)
══════════════════════════════════════════════════════════ */
// Nothing extra needed – aria-labels handle accessibility

/* ══════════════════════════════════════════════════════════
   FAQ ACCORDION LOGIC
══════════════════════════════════════════════════════════ */
(function initAccordion() {
  const faqItems = document.querySelectorAll('.faq-item');

  faqItems.forEach(item => {
    const btn = item.querySelector('.faq-btn');
    const content = item.querySelector('.faq-content');
    const icon = item.querySelector('.faq-icon');

    btn.addEventListener('click', () => {
      const isOpen = !content.classList.contains('hidden');

      // Close all accordions first (Exclusive state)
      faqItems.forEach(otherItem => {
        otherItem.querySelector('.faq-content').classList.add('hidden');
        const otherIcon = otherItem.querySelector('.faq-icon');
        otherIcon.textContent = '+';
        otherIcon.style.transform = 'rotate(0deg)';
      });

      // If the clicked one wasn't already open, open it
      if (!isOpen) {
        content.classList.remove('hidden');
        icon.textContent = '−'; // minus sign
        icon.style.transform = 'rotate(180deg)';
      }
    });
  });
})();

console.log('%c🏗️  BuildCoat loaded successfully!', 'color: #5A7343; font-weight: bold; font-size: 14px;');

// Calculate BuildCoat Logic
function calculateBuildCoat() {
    const areaInput = document.getElementById('area-input');
    const resultQuantity = document.getElementById('result-quantity');
    const resultCost = document.getElementById('result-cost');
    const resultShipping = document.getElementById('result-shipping');
    const resultTotal = document.getElementById('result-total');
    const resultsSection = document.getElementById('results-section');
    if (!areaInput || !resultQuantity) return;

    // Retrieve and parse input area
    const area = parseFloat(areaInput.value) || 0;

    // Formula: Area * 0.2, rounded up to the nearest whole integer
    const sacks = Math.ceil(area * 0.2);

    // Costs
    const costPerSack = 900;
    const shippingCost = 500;
    
    const totalCost = (sacks * costPerSack);
    const finalTotal = totalCost + shippingCost;

    // Format output (add commas for thousands)
    resultQuantity.innerText = sacks.toLocaleString();
    resultCost.innerText = totalCost.toLocaleString();
    resultShipping.innerText = shippingCost.toLocaleString();
    resultTotal.innerText = finalTotal.toLocaleString();
    if (resultsSection) {
    resultsSection.classList.remove('hidden');
}

  }





// Attach listener to input for real-time calculation
document.addEventListener('DOMContentLoaded', () => {
    const areaInput = document.getElementById('area-input');
    if (areaInput) {
        areaInput.addEventListener('input', calculateBuildCoat);
    }
});