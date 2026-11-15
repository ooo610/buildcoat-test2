import { auth } from './firebase-config.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.17.1/firebase-auth.js';

const isArabic = document.documentElement.lang === 'ar';
const api = 'https://buildcoat-test2.vercel.app/api';
const orderId = new URLSearchParams(location.search).get('orderId') || '';
const $ = id => document.getElementById(id);
const languagePage = isArabic ? './payment-confirmation.html' : './payment-confirmation-ar.html';
document.querySelectorAll(`header a[href="${languagePage}"]`).forEach(link => {
  link.href = `${languagePage}${location.search}`;
});
const copy = isArabic ? {
  loading: 'جارٍ تحميل بيانات الدفع…', noOrder: 'بيانات الطلب غير موجودة. ارجع لصفحة اختيار الدفع وحاول مرة أخرى.', signIn: 'سجّل الدخول لعرض بيانات الدفع.',
  expired: 'انتهت صلاحية الطلب. ارجع وابدأ طلبًا جديدًا.', loadError: 'تعذر تحميل بيانات الدفع. حاول مرة أخرى.',
  paymentNotSelected: 'لم يتم العثور على طريقة دفع محددة لهذا الطلب. ارجع واختر طريقة الدفع أولًا.',
  paymentInfoUnavailable: 'بيانات التحويل غير متاحة حاليًا. يرجى التواصل مع خدمة العملاء.',
  instapay: 'يرجى تحويل مبلغ', wallet: 'يرجى تحويل أموال من محفظتك الإلكترونية بمبلغ', toInsta: 'على إنستا باي إلى رقم الهاتف', toWallet: 'إلى رقم الهاتف',
  amount: (value, currency) => `${money(value)} ${currency === 'EGP' ? 'ج.م' : currency}`,
  senderInsta: 'أدخل اسم مستخدم إنستا باي الذي حوّلت منه', senderWallet: 'أدخل رقم هاتف المحفظة الإلكترونية التي حوّلت منها',
  hintInsta: 'مثال: 123@instapay', hintWallet: 'أدخل رقم الهاتف المرتبط بالمحفظة.',
  chooseFile: 'اختر صورة الإيصال', fileHelp: 'JPG أو PNG، بحد أقصى 2 ميجابايت', fileError: 'اختر صورة بصيغة JPG أو PNG أو WebP لا يتجاوز حجمها 2 ميجابايت.',
  receiptInsta: 'ارفع صورة إيصال التحويل من إنستا باي', receiptWallet: 'ارفع صورة رسالة التحويل من شركة الاتصالات',
  uploading: 'جارٍ رفع الإيصال…', submitting: 'جارٍ إرسال إثبات الدفع…', uploadError: 'تعذر رفع الإيصال. حاول مرة أخرى.',
  submitError: 'تعذر إرسال إثبات الدفع. حاول مرة أخرى.', authRequired: 'انتهت جلسة الدخول. سجّل الدخول وحاول مرة أخرى.',
  alreadyFinalized: 'تم إرسال إثبات الدفع لهذا الطلب بالفعل.', genericError: 'حدث خطأ. حاول مرة أخرى.'
} : {
  loading: 'Loading payment details…', noOrder: 'Order details are missing. Return to payment selection and try again.', signIn: 'Sign in to view payment details.',
  expired: 'Your order has expired. Return and start a new order.', loadError: 'Could not load payment details. Please try again.',
  paymentNotSelected: 'No payment option was selected for this order. Return and choose a payment method first.',
  paymentInfoUnavailable: 'Transfer details are not available right now. Please contact customer support.',
  instapay: 'Please transfer', wallet: 'Please transfer funds from your e-wallet in the amount of', toInsta: 'via InstaPay to phone number', toWallet: 'to phone number',
  amount: (value, currency) => `${money(value)} ${currency || 'EGP'}`,
  senderInsta: 'Enter the InstaPay username you transferred from', senderWallet: 'Enter the e-wallet phone number you transferred from',
  hintInsta: 'Example: 123@instapay', hintWallet: 'Enter the phone number linked to your wallet.',
  chooseFile: 'Choose a receipt image', fileHelp: 'JPG or PNG, up to 2 MB', fileError: 'Choose a JPG, PNG, or WebP image no larger than 2 MB.',
  receiptInsta: 'Upload your InstaPay transfer receipt', receiptWallet: 'Upload the transfer confirmation message from your mobile carrier',
  uploading: 'Uploading receipt…', submitting: 'Submitting payment proof…', uploadError: 'Could not upload the receipt. Please try again.',
  submitError: 'Could not submit payment proof. Please try again.', authRequired: 'Your sign-in session expired. Sign in and try again.',
  alreadyFinalized: 'Payment proof has already been submitted for this order.', genericError: 'Something went wrong. Please try again.'
};

let currentUser = null;
let paymentData = null;
let uploadedFile = null;
let uploadedReceiptUrl = '';

function money(value) { return Number(value).toLocaleString(isArabic ? 'ar-EG' : 'en-US'); }
function setError(message = '') { $('payment-error').textContent = message; }
function showStatus(message) { $('payment-status').textContent = message; }
function apiMessage(code, fallback) {
  const errors = {
    ORDER_EXPIRED: copy.expired,
    PAYMENT_NOT_SELECTED: copy.paymentNotSelected,
    PAYMENT_INFO_UNAVAILABLE: copy.paymentInfoUnavailable,
    AUTH_REQUIRED: copy.authRequired,
    ORDER_ALREADY_FINALIZED: copy.alreadyFinalized,
    TEMPORARY_ORDER_NOT_FOUND: copy.noOrder
  };
  return errors[code] || fallback;
}

function renderPayment(data) {
  paymentData = data;
  const isInstaPay = data.order.paymentMethod === 'instapay';
  const prefix = isInstaPay ? copy.instapay : copy.wallet;
  const connector = isInstaPay ? copy.toInsta : copy.toWallet;
  $('transfer-instruction').textContent = `${prefix} ${copy.amount(data.order.payableAmount, data.order.currency)} ${connector} ${data.recipientPhone}.`;
  $('payable-amount').textContent = copy.amount(data.order.payableAmount, data.order.currency);
  $('sender-label').textContent = isInstaPay ? copy.senderInsta : copy.senderWallet;
  $('sender-hint').textContent = isInstaPay ? copy.hintInsta : copy.hintWallet;
  $('sender-info').type = isInstaPay ? 'text' : 'tel';
  $('sender-info').inputMode = isInstaPay ? 'text' : 'tel';
  $('sender-info').placeholder = isInstaPay ? copy.hintInsta : (isArabic ? '01xxxxxxxxx' : '01xxxxxxxxx');
  $('receipt-label').textContent = isInstaPay ? copy.receiptInsta : copy.receiptWallet;
  $('file-prompt').textContent = copy.chooseFile;
  $('file-name').textContent = copy.fileHelp;
  $('payment-form').classList.remove('hidden');
  showStatus('');
}

async function loadPaymentData(user) {
  if (!orderId) { showStatus(copy.noOrder); return; }
  if (!user) { showStatus(copy.signIn); return; }
  showStatus(copy.loading);
  try {
    const token = await user.getIdToken();
    const response = await fetch(`${api}/payment-confirmation-data`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ temporaryOrderId: orderId })
    });
    const data = await response.json();
    if (!response.ok || !data.success) { showStatus(apiMessage(data.code, copy.loadError)); return; }
    renderPayment(data);
  } catch (error) {
    console.error('Payment confirmation data request failed:', error);
    showStatus(copy.loadError);
  }
}

function validateReceipt(file) {
  const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
  return file && allowedTypes.includes(file.type) && file.size <= 2 * 1024 * 1024;
}

async function uploadReceipt(file) {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('upload_preset', 'buildcoat_preset');
  const response = await fetch('https://api.cloudinary.com/v1_1/bpndfgos/image/upload', { method: 'POST', body: formData });
  const data = await response.json();
  if (!response.ok || !data.secure_url) throw new Error('CLOUDINARY_UPLOAD_FAILED');
  return data.secure_url;
}

async function submitProof(event) {
  event.preventDefault();
  setError('');
  const file = $('receipt-file').files?.[0];
  const senderInfo = $('sender-info').value.trim();
  if (!paymentData || !currentUser) { setError(copy.authRequired); return; }
  if (!validateReceipt(file)) { setError(copy.fileError); return; }
  if (senderInfo.length < 3) { setError(copy.genericError); $('sender-info').focus(); return; }

  const button = $('submit-proof');
  button.disabled = true;
  try {
    if (!uploadedReceiptUrl || uploadedFile !== file) {
      button.textContent = copy.uploading;
      uploadedReceiptUrl = await uploadReceipt(file);
      uploadedFile = file;
    }
    button.textContent = copy.submitting;
    const token = await currentUser.getIdToken();
    const response = await fetch(`${api}/submit-payment-proof`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ temporaryOrderId: orderId, receiptUrl: uploadedReceiptUrl, senderInfo })
    });
    const data = await response.json();
    if (!response.ok || !data.success) throw Object.assign(new Error('SUBMISSION_FAILED'), { code: data.code });
    $('payment-form').classList.add('hidden');
    $('success-order-number').textContent = data.orderId;
    $('payment-success').classList.remove('hidden');
    showStatus('');
  } catch (error) {
    console.error('Payment proof submission failed:', error);
    setError(error.code ? apiMessage(error.code, copy.submitError) : copy.uploadError);
  } finally {
    button.textContent = isArabic ? 'إرسال إثبات التحويل' : 'Submit transfer proof';
    if (!$('payment-form').classList.contains('hidden')) button.disabled = false;
  }
}

$('receipt-file').addEventListener('change', event => {
  setError('');
  const file = event.target.files?.[0];
  if (!file) return;
  if (!validateReceipt(file)) {
    event.target.value = '';
    uploadedReceiptUrl = ''; uploadedFile = null;
    $('file-name').textContent = copy.fileError;
    setError(copy.fileError);
    return;
  }
  uploadedReceiptUrl = ''; uploadedFile = null;
  $('file-name').textContent = file.name;
});
$('payment-proof-form').addEventListener('submit', submitProof);
onAuthStateChanged(auth, user => { currentUser = user; loadPaymentData(user); });
