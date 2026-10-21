import { auth } from './firebase-config.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.17.1/firebase-auth.js';

const isArabic = document.documentElement.lang === 'ar';
const api = 'https://buildcoat-test2.vercel.app/api';
const orderId = new URLSearchParams(location.search).get('orderId') || '';
const $ = id => document.getElementById(id);
const text = isArabic ? {
  loading: 'جارٍ تحميل طرق الدفع…', noId: 'بيانات الطلب غير موجودة. ارجع لصفحة تأكيد الطلب وحاول مرة أخرى.', signIn: 'سجّل الدخول لعرض طرق الدفع.',
  expired: 'انتهت صلاحية طلبك، يرجى إعادة المحاولة.', loadError: 'تعذر تحميل طرق الدفع. حاول مرة أخرى.', total: 'إجمالي الطلب',
  cod: 'الدفع عند الاستلام (COD)', insta: 'إنستا باي', wallet: 'المحفظة الإلكترونية (فودافون كاش)', full: 'دفع كامل المبلغ', deposit: 'دفع مقدم',
  noMethods: 'لا توجد طريقة دفع متاحة لهذا الطلب.', choose: 'اختر طريقة الدفع للمتابعة.', saving: 'جارٍ تأكيد الاختيار…',
  createError: 'تعذر إنشاء الطلب. حاول مرة أخرى.', redirectError: 'تعذر حفظ طريقة الدفع. حاول مرة أخرى.',
  successTitle: 'تم إنشاء طلبك بنجاح', orderNumber: 'رقم الطلب:', successMessage: 'يستغرق تأكيد الطلب من قبل الإدارة يومًا أو يومين عمل.',
  amount: value => `المبلغ المستحق الآن: ${money(value)} ج.م`,
  codAmount: 'الدفع عند الاستلام',
  expiredCode: 'ORDER_EXPIRED'
} : {
  loading: 'Loading payment options…', noId: 'Order details are missing. Return to order confirmation and try again.', signIn: 'Sign in to view payment options.',
  expired: 'Your order has expired. Please try again.', loadError: 'Could not load payment options. Please try again.', total: 'Order total',
  cod: 'COD (Cash on delivery)', insta: 'InstaPay', wallet: 'E-Wallet (Vodafone Cash)', full: 'Full Price Payment', deposit: 'Down Payment',
  noMethods: 'No payment method is available for this order.', choose: 'Choose a payment option to continue.', saving: 'Confirming your selection…',
  createError: 'Could not create the order. Please try again.', redirectError: 'Could not save the payment option. Please try again.',
  successTitle: 'Your order was created successfully', orderNumber: 'Order number:', successMessage: 'Order confirmation by our team takes one or two business days.',
  amount: value => `Amount due now: ${money(value)} EGP`, codAmount: 'Pay on delivery', expiredCode: 'ORDER_EXPIRED'
};
let currentUser = null;
let paymentData = null;

function money(value) { return Number(value).toLocaleString(isArabic ? 'ar-EG' : 'en-US'); }
function setError(message = '') { $('payment-error').textContent = message; }
function showStatus(message) { $('payment-status').textContent = message; }
function apiError(data, fallback) {
  if (data?.code === 'ORDER_EXPIRED') return text.expired;
  if (isArabic) {
    const messages = {
      AUTH_REQUIRED: 'سجّل الدخول لعرض طرق الدفع.', TEMPORARY_ORDER_NOT_FOUND: 'لم يتم العثور على الطلب المؤقت.',
      POLICY_NOT_FOUND: 'لا توجد سياسة دفع مناسبة لهذا الطلب.', POLICY_AMBIGUOUS: 'إعدادات شرائح الدفع تحتاج إلى مراجعة.',
      POLICY_MISMATCH: 'تغيّرت سياسة الدفع لهذا الطلب. أعد تحميل الصفحة.', PAYMENT_NOT_ALLOWED: 'طريقة الدفع المختارة غير متاحة لهذا الطلب.',
      ORDER_ALREADY_FINALIZED: 'تم إنهاء هذا الطلب بالفعل.'
    };
    if (messages[data?.code]) return messages[data.code];
  }
  return data?.error || fallback;
}

function optionCard({ method, type, label, amountLabel, checked = false }) {
  const id = `option-${method}-${type || 'none'}`;
  const labelEl = document.createElement('label');
  labelEl.htmlFor = id;
  labelEl.className = 'block cursor-pointer rounded-xl border border-gray-300 px-5 py-4 text-xl text-gray-600 transition hover:border-bc-green has-[:checked]:border-bc-green has-[:checked]:bg-green-50 sm:px-7 sm:py-5 sm:text-2xl';
  const row = document.createElement('span'); row.className = 'flex items-center gap-3';
  const input = document.createElement('input'); input.type = 'radio'; input.name = 'payment-choice'; input.id = id; input.value = `${method}:${type || ''}`; input.checked = checked; input.className = 'h-5 w-5 accent-[#5A7343]';
  const title = document.createElement('span'); title.textContent = label;
  row.append(input, title); labelEl.append(row);
  if (amountLabel) { const amount = document.createElement('span'); amount.className = 'ms-8 mt-2 block text-base font-medium text-bc-gray'; amount.textContent = amountLabel; labelEl.append(amount); }
  input.addEventListener('change', () => { setError(''); updateContinue(); });
  return labelEl;
}

function updateContinue() {
  $('payment-continue').disabled = !$('payment-choices').querySelector('input:checked') || !paymentData;
}

function renderOptions(data) {
  paymentData = data;
  const list = $('payment-choices'); list.replaceChildren();
  const legend = document.createElement('legend'); legend.className = 'mb-6 text-xl font-semibold text-bc-charcoal';
  legend.textContent = `${text.total}: ${money(data.order.totalCost)} ${isArabic ? 'ج.م' : 'EGP'}`; list.append(legend);
  const methods = data.methods;
  let first = true;
  if (methods.allowCOD) { list.append(optionCard({ method: 'cod', label: text.cod, amountLabel: text.codAmount, checked: first })); first = false; }
  const depositAllowed = methods.depositPercent > 0;
  const fullAllowed = methods.allowFullPayment && !methods.depositRequired;
  const addDigital = (method, title) => {
    if (method === 'instapay' ? !methods.allowInstaPay : !methods.allowEWallet) return;
    const group = document.createElement('div'); group.className = 'space-y-3';
    const heading = document.createElement('h2'); heading.className = 'flex items-center gap-3 px-1 text-xl text-gray-600 sm:text-2xl';
    const marker = document.createElement('span'); marker.className = 'inline-block h-5 w-5 rounded-full border-2 border-gray-400';
    const headingText = document.createElement('span'); headingText.textContent = title; heading.append(marker, headingText); group.append(heading);
    const subOptions = document.createElement('div'); subOptions.className = 'grid gap-3 ps-8 sm:grid-cols-2';
    if (fullAllowed) subOptions.append(optionCard({ method, type: 'full', label: text.full, amountLabel: text.amount(data.order.totalCost), checked: first }));
    if (depositAllowed) {
      const due = Math.ceil(data.order.totalCost * methods.depositPercent / 100);
      subOptions.append(optionCard({ method, type: 'deposit', label: `${text.deposit} (${methods.depositPercent}%)`, amountLabel: text.amount(due), checked: first && !fullAllowed }));
    }
    group.append(subOptions); list.append(group);
    if (subOptions.querySelector('input:checked')) first = false;
  };
  addDigital('instapay', text.insta);
  addDigital('ewallet', text.wallet);
  if (!list.querySelector('input')) {
    const empty = document.createElement('p'); empty.className = 'text-center text-red-700'; empty.textContent = text.noMethods; list.append(empty);
  }
  $('payment-form').hidden = false;
  showStatus(''); updateContinue();
}

async function loadPaymentOptions() {
  if (!orderId) { showStatus(text.noId); return; }
  if (!currentUser) { showStatus(text.signIn); return; }
  showStatus(text.loading); setError('');
  try {
    const token = await currentUser.getIdToken();
    const response = await fetch(`${api}/payment-options`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ temporaryOrderId: orderId }) });
    const data = await response.json();
    if (!response.ok || !data.success) {
      showStatus(apiError(data, text.loadError));
      return;
    }
    renderOptions(data);
  } catch (error) {
    console.error('Payment options request failed:', error); showStatus(text.loadError);
  }
}

async function continuePayment(event) {
  event.preventDefault(); setError('');
  const selected = $('payment-choices').querySelector('input:checked');
  if (!selected || !paymentData || !currentUser) { setError(text.choose); return; }
  const [method, paymentType] = selected.value.split(':');
  $('payment-continue').disabled = true; $('payment-continue').textContent = text.saving;
  try {
    const token = await currentUser.getIdToken();
    let response, data;
    if (method === 'cod') {
      response = await fetch(`${api}/complete-order`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ temporaryOrderId: orderId, tier: paymentData.tier }) });
      data = await response.json();
      if (!response.ok || !data.success) throw new Error(apiError(data, text.createError));
      $('payment-form').hidden = true;
      const success = document.createElement('section'); success.className = 'mx-auto mt-8 max-w-2xl rounded-2xl bg-green-50 p-6 text-center text-bc-charcoal'; success.setAttribute('role', 'status'); success.setAttribute('aria-live', 'polite');
      const title = document.createElement('h2'); title.className = 'mb-2 text-2xl font-bold text-bc-green'; title.textContent = text.successTitle;
      const number = document.createElement('p'); number.append(document.createTextNode(`${text.orderNumber} `)); const strong = document.createElement('strong'); strong.textContent = data.orderId; number.append(strong);
      const message = document.createElement('p'); message.className = 'mt-2'; message.textContent = text.successMessage;
      success.append(title, number, message); $('payment-form').after(success); showStatus('');
      return;
    }
    response = await fetch(`${api}/select-payment`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ temporaryOrderId: orderId, tier: paymentData.tier, method, paymentType }) });
    data = await response.json();
    if (!response.ok || !data.success) throw new Error(apiError(data, text.redirectError));
    const destination = isArabic ? './payment-confirmation-ar.html' : './payment-confirmation.html';
    location.assign(`${destination}?orderId=${encodeURIComponent(orderId)}&method=${encodeURIComponent(method)}&paymentType=${encodeURIComponent(paymentType)}`);
  } catch (error) {
    console.error('Payment continuation failed:', error); setError(error.message || text.createError);
    $('payment-continue').textContent = isArabic ? 'متابعة' : 'Continue'; updateContinue();
  }
}

document.getElementById('payment-form').addEventListener('submit', continuePayment);
onAuthStateChanged(auth, user => { currentUser = user; if (user) loadPaymentOptions(); else showStatus(text.signIn); });
