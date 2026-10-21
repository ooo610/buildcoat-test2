import { auth, db } from './firebase-config.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.17.1/firebase-auth.js';
import { collection, doc, getDocs, writeBatch } from 'https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js';

const isArabic = document.documentElement.lang === 'ar';
const apiBase = 'https://buildcoat-test2.vercel.app/api';
const text = isArabic ? {
  loading: 'جارٍ تحميل بيانات الطلب…', chooseProduct: 'اختر نوع المنتج', chooseColor: 'اختر اللون', chooseGovernorate: 'اختر المحافظة',
  noProducts: 'لا توجد منتجات متاحة.', noColors: 'لا توجد ألوان متاحة.', noGovernorates: 'لا توجد محافظات متاحة.',
  loadingProductsError: 'تعذر تحميل المنتجات. حاول تحديث الصفحة.', loadingColorsError: 'تعذر تحميل الألوان. حاول تحديث الصفحة.', loadingGovError: 'تعذر تحميل المحافظات. حاول تحديث الصفحة.',
  missingSelection: 'لم يعد الاختيار المحفوظ متاحًا. اختر قيمة متاحة من القوائم.', quantityInvalid: 'أدخل عددًا صحيحًا موجبًا من الشكاير.',
  addressInvalid: 'أدخل المدينة والعنوان بالتفصيل قبل المتابعة.', incomplete: 'أكمل جميع الحقول المطلوبة قبل المتابعة.', priceRequired: 'أكمل اختيار المنتج والكمية والمحافظة لعرض السعر.',
  priceLoading: 'جارٍ تحديث السعر…', priceError: 'تعذر حساب السعر الآن. حاول مرة أخرى.', priceErrorCode: code => `رمز الخطأ من الخادم: ${code}`, signIn: 'سجّل الدخول لإرسال الطلب.',
  submitting: 'جارٍ إرسال الطلب…', submitError: 'تعذر إرسال الطلب. بياناتك محفوظة، ويمكنك المحاولة مرة أخرى.', priceChanged: 'تغيّر السعر. راجع الإجمالي المحدّث ثم اضغط متابعة مرة أخرى.',
  success: 'تم إرسال طلبك بنجاح.', noFavoriteProducts: 'لا توجد منتجات متاحة لإضافتها للمفضلة.',
  favoriteLoad: 'تعذر تحميل المنتجات. حاول مرة أخرى.', selectFavoriteProduct: 'اختر منتجًا واحدًا على الأقل.', saved: 'تمت الإضافة إلى المفضلة.', deleted: 'تم حذف اللون من المفضلة.',
  calcInvalid: 'أدخل عرضًا وارتفاعًا صحيحين وعدد واجهات صحيحًا إن وُجد.', calcNeedInput: 'أدخل أبعاد الواجهة لحساب الكمية.',
  addFavorite: 'إضافة اللون للمفضلة', removeFavorite: 'حذف اللون من المفضلة', favoriteTitle: 'اختر المنتج', add: 'أضف إلى المفضلة', cancel: 'إلغاء', delete: 'حذف',
  alreadyDeleted: 'هل تريد حذف هذا اللون من قائمة المفضلة؟', deleteMessage: 'سيتم حذف هذا اللون من قائمتك للمفضلة ويمكنك إضافته مجددًا لاحقًا.',
  calcTitle: 'حاسبة الكمية المطلوبة', calcDone: 'تم', sacks: 'شكاير', calcQuantity: count => `الكمية المطلوبة: ${count} شيكارة (50 كجم لكل شيكارة)`
} : {
  loading: 'Loading order details…', chooseProduct: 'Select product type', chooseColor: 'Select color', chooseGovernorate: 'Select governorate',
  noProducts: 'No products are available.', noColors: 'No colors are available.', noGovernorates: 'No governorates are available.',
  loadingProductsError: 'Could not load products. Refresh the page and try again.', loadingColorsError: 'Could not load colors. Refresh the page and try again.', loadingGovError: 'Could not load governorates. Refresh the page and try again.',
  missingSelection: 'A saved selection is no longer available. Choose an available option from the lists.', quantityInvalid: 'Enter a positive whole number of sacks.',
  addressInvalid: 'Enter your city and full address before continuing.', incomplete: 'Complete all required fields before continuing.', priceRequired: 'Select a product, enter a quantity, and choose a governorate to see the price.',
  priceLoading: 'Updating price…', priceError: 'Could not calculate the price. Please try again.', priceErrorCode: code => `Server error code: ${code}`, signIn: 'Sign in to submit your order.',
  submitting: 'Submitting your order…', submitError: 'The order could not be submitted. Your details are saved; please try again.', priceChanged: 'The price changed. Review the updated total, then select Continue again.',
  success: 'Your order was submitted successfully.', noFavoriteProducts: 'No products are available to add to favorites.',
  favoriteLoad: 'Could not load products. Please try again.', selectFavoriteProduct: 'Select at least one product.', saved: 'Added to favorites.', deleted: 'Color removed from favorites.',
  calcInvalid: 'Enter a valid width and height, and a whole number of facades if provided.', calcNeedInput: 'Enter facade dimensions to calculate a quantity.',
  addFavorite: 'Add color to favorites', removeFavorite: 'Remove color from favorites', favoriteTitle: 'Select The Product', add: 'Add to Favorites', cancel: 'Cancel', delete: 'Delete',
  alreadyDeleted: 'Do you want to remove this color from your favorites?', deleteMessage: 'This color will be removed from your favorites. You can add it again later.',
  calcTitle: 'Required quantity calculator', calcDone: 'Done', sacks: 'Sacks', calcQuantity: count => `Estimated required quantity: ${count} sacks (50Kg each)`
};

const $ = id => document.getElementById(id);
const status = $('page-status');
const orderError = $('order-error');
const form = $('order-form');
const productSelect = $('product-select');
const colorSelect = $('color-select');
const governorateSelect = $('governorate-select');
const quantityInput = $('quantity-input');
const continueButton = $('continue-button');
const breakdown = $('price-breakdown');
const favoriteModal = $('favorite-modal');
const calculatorModal = $('calculator-modal');
const productNames = new Map();
let products = [];
let colors = [];
let governorates = [];
let favorites = [];
let currentUser = auth.currentUser;
let latestPrice = null;
let latestPriceKey = '';
let quoteTimer = null;
let quoteSequence = 0;
let idempotencyKey = sessionStorage.getItem('orderSubmissionKey') || '';
let modalReturnFocus = null;
let favoriteColor = null;
let favoriteMode = 'add';

function announce(message = '') { status.textContent = message; }
function showError(message = '') { orderError.textContent = message; }
function addOption(select, value, label, disabled = false, selected = false) {
  const option = document.createElement('option');
  option.value = value; option.textContent = label; option.disabled = disabled; option.selected = selected;
  select.append(option);
}
function storedValue(key) {
  try { return JSON.parse(sessionStorage.getItem(key) || 'null'); }
  catch { return sessionStorage.getItem(key); }
}
function storedId(value, keys) {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  for (const key of keys) if (value?.[key] != null && String(value[key]).trim()) return String(value[key]);
  return '';
}
function money(value) { return Number(value).toLocaleString(isArabic ? 'ar-EG' : 'en-US'); }
function currentPriceKey() { return `${productSelect.value}|${quantityInput.value}|${governorateSelect.value}`; }
function validQuantity() { return /^[1-9]\d*$/.test(quantityInput.value.trim()) && Number.isSafeInteger(Number(quantityInput.value)); }
function formComplete() {
  return Boolean(productSelect.value && colorSelect.value && governorateSelect.value && validQuantity() && $('city-input').value.trim().length >= 2 && $('address-input').value.trim().length >= 5);
}
function updateContinue() {
  continueButton.disabled = !formComplete() || !latestPrice || latestPriceKey !== currentPriceKey() || !currentUser;
}
function updateSelectedColor() {
  const color = colors.find(item => item.id === colorSelect.value);
  if (!color) {
    $('live-color-swatch').style.backgroundColor = '#e5e7eb';
    $('live-color-code').textContent = '—'; $('live-color-name').textContent = text.chooseColor;
    $('inline-color-swatch').style.backgroundColor = 'transparent'; $('inline-color-name').textContent = text.chooseColor; $('inline-color-code').textContent = '';
    $('favorite-toggle').setAttribute('aria-pressed', 'false'); $('favorite-toggle').setAttribute('aria-label', text.addFavorite);
    return;
  }
  const colorName = isArabic ? color.colorNameAR : color.colorName;
  $('live-color-swatch').style.backgroundColor = color.img || '#e5e7eb';
  $('live-color-code').textContent = String(color.colorCode ?? ''); $('live-color-name').textContent = colorName || '';
  $('inline-color-swatch').style.backgroundColor = color.img || 'transparent'; $('inline-color-name').textContent = colorName || '';
  $('inline-color-code').textContent = color.colorCode == null ? '' : String(color.colorCode);
  const isFavorite = favorites.some(item => Number(item.colorCode) === Number(color.colorCode));
  $('favorite-toggle').setAttribute('aria-pressed', String(isFavorite));
  $('favorite-toggle').setAttribute('aria-label', isFavorite ? text.removeFavorite : text.addFavorite);
  try {
    sessionStorage.setItem('selectedColor', JSON.stringify({ id: color.id, img: color.img, colorName: color.colorName, colorNameAR: color.colorNameAR, colorCode: color.colorCode }));
  } catch (error) { console.error('Could not save selected color:', error); }
}

function invalidatePrice(message = '') {
  latestPrice = null; latestPriceKey = ''; breakdown.classList.add('hidden');
  ['price-cost', 'price-shipping', 'price-total'].forEach(id => $(id).textContent = '—');
  updateContinue();
  if (message) announce(message);
}

async function fetchPrice(key) {
  const sequence = ++quoteSequence;
  latestPrice = null; latestPriceKey = ''; breakdown.classList.add('hidden'); updateContinue();
  announce(text.priceLoading);
  try {
    const response = await fetch(`${apiBase}/order-price`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: productSelect.value, governorateId: governorateSelect.value, quantity: Number(quantityInput.value) })
    });
    let data;
    try { data = await response.json(); }
    catch { data = {}; }
    if (sequence !== quoteSequence || key !== currentPriceKey()) return;
    if (!response.ok || !data.success) {
      const error = new Error(data.error || data.code || `Price request failed (HTTP ${response.status}).`);
      error.code = data.code || `HTTP_${response.status}`;
      throw error;
    }
    latestPrice = data; latestPriceKey = key;
    $('price-cost').textContent = money(data.cost); $('price-shipping').textContent = money(data.shippingCost); $('price-total').textContent = money(data.totalCost);
    breakdown.classList.remove('hidden'); announce(''); updateContinue();
  } catch (error) {
    if (sequence !== quoteSequence) return;
    console.error('Order price request failed:', error);
    invalidatePrice(error.code ? text.priceErrorCode(error.code) : text.priceError);
  }
}

function refreshPrice() {
  showError();
  const canQuote = Boolean(productSelect.value && governorateSelect.value && validQuantity());
  if (!canQuote) { clearTimeout(quoteTimer); ++quoteSequence; invalidatePrice(formComplete() ? '' : text.priceRequired); return; }
  const key = currentPriceKey();
  if (latestPrice && latestPriceKey === key) { announce(''); updateContinue(); return; }
  clearTimeout(quoteTimer);
  quoteTimer = setTimeout(() => fetchPrice(key), 300);
  announce(text.priceLoading); updateContinue();
}

async function loadOptions() {
  announce(text.loading);
  const savedProduct = storedValue('selectedProduct');
  const savedProductId = storedId(savedProduct, ['id', 'productId', 'productID', 'docId']);
  const savedColor = storedValue('selectedColor');
  const savedColorId = storedId(savedColor, ['id', 'colorId', 'docId']);
  const savedColorCode = Number(savedColor?.colorCode);
  const savedQuantity = storedValue('selectedQuantity');
  if (savedQuantity != null && savedQuantity !== '') quantityInput.value = String(savedQuantity);

  const results = await Promise.allSettled([
    getDocs(collection(db, 'inventorycms')),
    getDocs(collection(db, 'colorPalettecms')),
    getDocs(collection(db, 'shippingPrices'))
  ]);
  if (results[0].status === 'fulfilled') {
    products = results[0].value.docs.map(snapshot => ({ ...snapshot.data(), id: snapshot.id }));
    products.forEach(product => productNames.set(product.id, isArabic ? product.name_ar : product.name_en));
    productSelect.replaceChildren();
    addOption(productSelect, '', products.length ? text.chooseProduct : text.noProducts, true, true);
    products.forEach(product => {
      const name = isArabic ? product.name_ar : product.name_en;
      if (typeof name === 'string' && name.trim()) addOption(productSelect, product.id, name.trim(), product.active === false);
    });
    const chosen = products.find(product => product.id === savedProductId && product.active !== false);
    if (chosen) productSelect.value = chosen.id;
    else if (savedProductId) showError(text.missingSelection);
  } else {
    productSelect.replaceChildren(); addOption(productSelect, '', text.loadingProductsError, true, true); showError(text.loadingProductsError);
    console.error('Product options failed:', results[0].reason);
  }

  if (results[1].status === 'fulfilled') {
    colors = results[1].value.docs.map(snapshot => ({ id: snapshot.id, ...snapshot.data() }));
    colorSelect.replaceChildren(); addOption(colorSelect, '', colors.length ? text.chooseColor : text.noColors, true, true);
    colors.forEach(color => {
      const name = isArabic ? color.colorNameAR : color.colorName;
      if (typeof name === 'string' && name.trim()) addOption(colorSelect, color.id, `${name.trim()}${color.colorCode == null ? '' : ` ${color.colorCode}`}`);
    });
    let chosen = colors.find(color => color.id === savedColorId);
    if (!chosen && Number.isFinite(savedColorCode)) chosen = colors.find(color => Number(color.colorCode) === savedColorCode);
    if (chosen) colorSelect.value = chosen.id;
    else if (savedColorId || Number.isFinite(savedColorCode)) showError(text.missingSelection);
  } else {
    colorSelect.replaceChildren(); addOption(colorSelect, '', text.loadingColorsError, true, true); showError(text.loadingColorsError);
    console.error('Color options failed:', results[1].reason);
  }

  if (results[2].status === 'fulfilled') {
    governorates = results[2].value.docs.map(snapshot => ({ ...snapshot.data(), id: snapshot.id }));
    governorateSelect.replaceChildren(); addOption(governorateSelect, '', governorates.length ? text.chooseGovernorate : text.noGovernorates, true, true);
    governorates.forEach(governorate => {
      const name = isArabic ? governorate.nameAr : governorate.nameEn;
      if (typeof name === 'string' && name.trim()) addOption(governorateSelect, governorate.id, name.trim(), governorate.active === false);
    });
  } else {
    governorateSelect.replaceChildren(); addOption(governorateSelect, '', text.loadingGovError, true, true); showError(text.loadingGovError);
    console.error('Governorate options failed:', results[2].reason);
  }

  updateSelectedColor();
  if (productSelect.value && governorateSelect.value && validQuantity()) refreshPrice();
  else { announce(''); updateContinue(); }
}

function favoriteKey(item) { return `${Number(item.colorCode)}|${item.productName}`; }
function favoriteDocId(item) { return `color-${Number(item.colorCode)}-product-${encodeURIComponent(item.productName)}`; }
function readSessionFavorites() {
  try { const parsed = JSON.parse(sessionStorage.getItem('favoriteList') || '[]'); return Array.isArray(parsed) ? parsed : []; }
  catch { return []; }
}
async function refreshFavorites() {
  if (currentUser) {
    try {
      const ref = collection(db, 'users', currentUser.uid, 'favoriteList');
      const snapshot = await getDocs(ref);
      const known = new Set(snapshot.docs.map(item => favoriteKey(item.data())));
      const batch = writeBatch(db);
      let changed = false;
      readSessionFavorites().forEach(item => {
        const key = favoriteKey(item);
        if (!known.has(key)) { known.add(key); batch.set(doc(ref, favoriteDocId(item)), item); changed = true; }
      });
      if (changed) { await batch.commit(); sessionStorage.removeItem('favoriteList'); }
      const updated = changed ? await getDocs(ref) : snapshot;
      favorites = updated.docs.map(item => item.data());
    } catch (error) { console.error('Could not load saved favorites:', error); favorites = readSessionFavorites(); }
  } else favorites = readSessionFavorites();
  updateSelectedColor();
}

function openModal(modal, trigger) {
  modalReturnFocus = trigger;
  modal.classList.remove('hidden'); modal.classList.add('flex'); document.body.classList.add('overflow-hidden');
  const first = modal.querySelector('button:not(:disabled), input:not(:disabled)'); first?.focus();
}
function closeModal(modal) {
  modal.classList.add('hidden'); modal.classList.remove('flex');
  if (favoriteModal.classList.contains('hidden') && calculatorModal.classList.contains('hidden')) document.body.classList.remove('overflow-hidden');
  modalReturnFocus?.focus(); modalReturnFocus = null;
}
function wireModalAccessibility(modal, closeButton) {
  closeButton.addEventListener('click', () => closeModal(modal));
  modal.addEventListener('click', event => { if (event.target === modal) closeModal(modal); });
  modal.addEventListener('keydown', event => {
    if (event.key === 'Escape') { closeModal(modal); return; }
    if (event.key !== 'Tab') return;
    const focusable = [...modal.querySelectorAll('button:not(:disabled), input:not(:disabled)')];
    if (!focusable.length) return;
    if (event.shiftKey && document.activeElement === focusable[0]) { event.preventDefault(); focusable.at(-1).focus(); }
    else if (!event.shiftKey && document.activeElement === focusable.at(-1)) { event.preventDefault(); focusable[0].focus(); }
  });
}

function renderFavoriteProductOptions() {
  const list = $('favorite-products'); list.replaceChildren();
  const available = products.filter(product => product.status === 'available');
  if (!available.length) { $('favorite-modal-message').textContent = text.noFavoriteProducts; $('favorite-confirm').disabled = true; return; }
  $('favorite-modal-message').textContent = '';
  $('favorite-confirm').disabled = false;
  available.forEach(product => {
    const label = document.createElement('label'); label.className = 'flex cursor-pointer items-center gap-3 rounded-lg border border-gray-200 p-3 hover:border-bc-green';
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.value = product.id; checkbox.className = 'h-5 w-5 accent-[#5A7343]';
    const name = document.createElement('span'); name.className = 'font-medium text-bc-charcoal'; name.textContent = isArabic ? product.name_ar || '' : product.name_en || '';
    label.append(checkbox, name); list.append(label);
  });
}

async function toggleFavorite() {
  const color = colors.find(item => item.id === colorSelect.value);
  if (!color) return;
  favoriteColor = color;
  const existing = favorites.some(item => Number(item.colorCode) === Number(color.colorCode));
  favoriteMode = existing ? 'delete' : 'add';
  $('favorite-modal-title').textContent = existing ? text.alreadyDeleted : text.favoriteTitle;
  $('favorite-modal-message').textContent = existing ? text.deleteMessage : '';
  $('favorite-products').classList.toggle('hidden', existing);
  $('favorite-confirm').textContent = existing ? text.delete : text.add;
  $('favorite-cancel').textContent = text.cancel;
  if (!existing) renderFavoriteProductOptions();
  openModal(favoriteModal, $('favorite-toggle'));
}

async function saveFavoriteAction() {
  if (!favoriteColor) return;
  const confirm = $('favorite-confirm'); confirm.disabled = true;
  try {
    if (favoriteMode === 'delete') {
      if (currentUser) {
        const ref = collection(db, 'users', currentUser.uid, 'favoriteList');
        const snapshot = await getDocs(ref); const batch = writeBatch(db); let count = 0;
        snapshot.docs.forEach(item => { if (Number(item.data().colorCode) === Number(favoriteColor.colorCode)) { batch.delete(doc(ref, item.id)); count++; } });
        if (count) await batch.commit();
      } else {
        const remaining = readSessionFavorites().filter(item => Number(item.colorCode) !== Number(favoriteColor.colorCode));
        sessionStorage.setItem('favoriteList', JSON.stringify(remaining));
      }
      $('favorite-modal-message').textContent = text.deleted;
    } else {
      const chosenIds = [...$('favorite-products').querySelectorAll('input:checked')].map(input => input.value);
      const chosen = products.filter(product => chosenIds.includes(product.id));
      if (!chosen.length) { $('favorite-modal-message').textContent = text.selectFavoriteProduct; confirm.disabled = false; return; }
      const additions = chosen.map(product => ({
        img: favoriteColor.img, colorCode: Number(favoriteColor.colorCode),
        colorName: favoriteColor.colorName || '', colorNameAR: favoriteColor.colorNameAR || '',
        productName: product.name_en || '', productNameAR: product.name_ar || ''
      }));
      if (currentUser) {
        const ref = collection(db, 'users', currentUser.uid, 'favoriteList');
        const snapshot = await getDocs(ref); const existing = new Set(snapshot.docs.map(item => favoriteKey(item.data())));
        const batch = writeBatch(db); let count = 0;
        additions.forEach(item => { const key = favoriteKey(item); if (!existing.has(key)) { existing.add(key); batch.set(doc(ref, favoriteDocId(item)), item); count++; } });
        if (count) await batch.commit();
      } else {
        const combined = readSessionFavorites(); const existing = new Set(combined.map(favoriteKey));
        additions.forEach(item => { const key = favoriteKey(item); if (!existing.has(key)) { existing.add(key); combined.push(item); } });
        sessionStorage.setItem('favoriteList', JSON.stringify(combined));
      }
      $('favorite-modal-message').textContent = text.saved;
    }
    await refreshFavorites();
    setTimeout(() => closeModal(favoriteModal), 600);
  } catch (error) {
    console.error('Could not update favorites:', error);
    $('favorite-modal-message').textContent = text.favoriteLoad;
    confirm.disabled = false;
  }
}

function openCalculator() {
  $('calculator-title').textContent = text.calcTitle;
  $('calculator-done').textContent = text.calcDone;
  $('calc-error').textContent = ''; $('calc-result').textContent = '';
  $('calc-width').value = ''; $('calc-height').value = ''; $('calc-facades').value = '';
  openModal(calculatorModal, $('open-calculator'));
}
function computeCalculator() {
  const width = Number($('calc-width').value); const height = Number($('calc-height').value);
  const countRaw = $('calc-facades').value.trim(); const count = countRaw ? Number(countRaw) : 1;
  if (!(width > 0) || !(height > 0) || !(count >= 1) || !Number.isInteger(count)) {
    $('calc-result').textContent = ''; $('calc-error').textContent = text.calcNeedInput; return null;
  }
  $('calc-error').textContent = '';
  const sacks = Math.ceil(width * height * count / 5);
  $('calc-result').textContent = text.calcQuantity(sacks);
  return sacks;
}

function createIdempotencyKey() {
  if (!idempotencyKey) {
    idempotencyKey = globalThis.crypto?.randomUUID?.() || `order_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    sessionStorage.setItem('orderSubmissionKey', idempotencyKey);
  }
  return idempotencyKey;
}

async function submitOrder(event) {
  event.preventDefault(); showError();
  if (!formComplete()) {
    showError(!validQuantity() ? text.quantityInvalid : (!$('city-input').value.trim() || !$('address-input').value.trim()) ? text.addressInvalid : text.incomplete);
    return;
  }
  if (!latestPrice || latestPriceKey !== currentPriceKey()) { refreshPrice(); showError(text.priceRequired); return; }
  if (!currentUser) { showError(text.signIn); return; }
  continueButton.disabled = true; continueButton.textContent = text.submitting;
  const requestQuote = { cost: latestPrice.cost, shippingCost: latestPrice.shippingCost, totalCost: latestPrice.totalCost };
  try {
    const token = await currentUser.getIdToken();
    const response = await fetch(`${apiBase}/temporary-orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'Idempotency-Key': createIdempotencyKey() },
      body: JSON.stringify({
        locale: isArabic ? 'ar' : 'en', productId: productSelect.value, colorId: colorSelect.value,
        governorateId: governorateSelect.value, quantity: Number(quantityInput.value),
        city: $('city-input').value.trim(), address: $('address-input').value.trim(), quote: requestQuote
      })
    });
    const data = await response.json();
    if (response.status === 409 && data.code === 'PRICE_CHANGED' && data.price) {
      latestPrice = data.price; latestPriceKey = currentPriceKey();
      $('price-cost').textContent = money(data.price.cost); $('price-shipping').textContent = money(data.price.shippingCost); $('price-total').textContent = money(data.price.totalCost);
      breakdown.classList.remove('hidden'); showError(text.priceChanged); return;
    }
    if (!response.ok || !data.success) throw new Error(data.error || data.code || 'Order submission failed.');
    sessionStorage.clear();
    const paymentPage = isArabic ? './payment-method-ar.html' : './payment-method.html';
    window.location.assign(`${paymentPage}?orderId=${encodeURIComponent(data.temporaryOrderId)}`);
  } catch (error) {
    console.error('Order submission failed:', error);
    showError(error.message === 'AUTH_REQUIRED' ? text.signIn : text.submitError);
  } finally {
    if (!form.classList.contains('hidden')) { continueButton.textContent = isArabic ? 'متابعة' : 'Continue'; updateContinue(); }
  }
}

productSelect.addEventListener('change', () => {
  const product = products.find(item => item.id === productSelect.value);
  if (product) sessionStorage.setItem('selectedProduct', JSON.stringify(product));
  refreshPrice();
});
colorSelect.addEventListener('change', () => { updateSelectedColor(); updateContinue(); showError(); });
governorateSelect.addEventListener('change', refreshPrice);
quantityInput.addEventListener('input', () => {
  if (validQuantity()) sessionStorage.setItem('selectedQuantity', quantityInput.value);
  refreshPrice();
});
['city-input', 'address-input'].forEach(id => $(id).addEventListener('input', () => { showError(); updateContinue(); }));
form.addEventListener('submit', submitOrder);
$('open-calculator').addEventListener('click', openCalculator);
$('calculator-done').addEventListener('click', () => {
  const count = computeCalculator();
  if (count == null) return;
  quantityInput.value = String(count); sessionStorage.setItem('selectedQuantity', String(count));
  closeModal(calculatorModal); refreshPrice(); updateContinue();
});
['calc-width', 'calc-height', 'calc-facades'].forEach(id => $(id).addEventListener('input', computeCalculator));
$('favorite-toggle').addEventListener('click', toggleFavorite);
$('favorite-confirm').addEventListener('click', saveFavoriteAction);
wireModalAccessibility(favoriteModal, $('favorite-close'));
wireModalAccessibility(calculatorModal, $('calculator-close'));
onAuthStateChanged(auth, user => {
  currentUser = user; refreshFavorites(); updateContinue();
  if (!user && formComplete()) showError(text.signIn);
});
loadOptions().catch(error => {
  console.error('Order option loading failed:', error);
  announce(text.loadingProductsError);
});
