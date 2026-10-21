import { db } from './firebase-config.js';
import { collection, doc, getDoc, getDocs } from 'https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js';

const isArabic = document.documentElement.lang.toLowerCase().startsWith('ar');
const messages = {
  loadingProducts: isArabic ? 'جارٍ تحميل المنتجات…' : 'Loading products…',
  loadingGovernorates: isArabic ? 'جارٍ تحميل المحافظات…' : 'Loading governorates…',
  chooseProduct: isArabic ? 'اختر نوع المنتج' : 'Select a product',
  chooseGovernorate: isArabic ? 'اختر المحافظة' : 'Select a governorate',
  noProducts: isArabic ? 'لا توجد منتجات متاحة' : 'No products available',
  noGovernorates: isArabic ? 'لا توجد محافظات متاحة' : 'No governorates available',
  loadError: isArabic ? 'تعذر تحميل البيانات. يرجى تحديث الصفحة والمحاولة مرة أخرى.' : 'Could not load calculator data. Refresh the page and try again.',
  selectEco: isArabic ? 'الحساب متاح حاليًا لمنتج بيلد كوت إيكو فقط.' : 'Calculations are currently available for BuildCoat Eco only.',
  missingPrice: isArabic ? 'تعذر العثور على سعر المنتج. يرجى المحاولة لاحقًا.' : 'Product pricing is unavailable. Please try again later.',
  invalidInputs: isArabic ? 'أدخل عرضًا وارتفاعًا صحيحين، وعدد واجهات صحيحًا إن وُجد.' : 'Enter a valid width and height, and a whole number of facades if provided.',
  missingShipping: isArabic ? 'تعذر العثور على سعر شحن المحافظة المختارة.' : 'Shipping price for the selected governorate is unavailable.'
};
const form = document.getElementById('calculator-form');
const productSelect = document.getElementById('product-select');
const governorateSelect = document.getElementById('governorate-select');
const resultSection = document.getElementById('results-section');
const status = document.createElement('p');
status.className = 'text-sm text-red-700';
status.setAttribute('role', 'alert');
status.hidden = true;
form?.append(status);

function setStatus(message = '') {
  status.textContent = message;
  status.hidden = !message;
}

function addOption(select, value, label, disabled = false) {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = label;
  option.disabled = disabled;
  select.append(option);
}

async function loadProducts() {
  productSelect.replaceChildren();
  addOption(productSelect, '', messages.loadingProducts, true);
  const snapshot = await getDocs(collection(db, 'inventorycms'));
  const products = snapshot.docs.map(item => ({ ...item.data(), id: item.id }))
    .filter(item => typeof (isArabic ? item.name_ar : item.name_en) === 'string' && (isArabic ? item.name_ar : item.name_en).trim())
    .sort((a, b) => (isArabic ? a.name_ar : a.name_en).localeCompare(isArabic ? b.name_ar : b.name_en));
  productSelect.replaceChildren();
  addOption(productSelect, '', products.length ? messages.chooseProduct : messages.noProducts, true);
  products.forEach(product => addOption(productSelect, product.id, (isArabic ? product.name_ar : product.name_en).trim(), product.active !== true));
}

async function loadGovernorates() {
  governorateSelect.replaceChildren();
  addOption(governorateSelect, '', messages.loadingGovernorates, true);
  const snapshot = await getDocs(collection(db, 'shippingPrices'));
  const places = snapshot.docs.map(item => ({ ...item.data(), id: item.id }))
    .filter(item => typeof (isArabic ? item.nameAr : item.nameEn) === 'string' && (isArabic ? item.nameAr : item.nameEn).trim())
    .sort((a, b) => (isArabic ? a.nameAr : a.nameEn).localeCompare(isArabic ? b.nameAr : b.nameEn));
  governorateSelect.replaceChildren();
  addOption(governorateSelect, '', places.length ? messages.chooseGovernorate : messages.noGovernorates, true);
  places.forEach(place => addOption(governorateSelect, place.id, (isArabic ? place.nameAr : place.nameEn).trim()));
}

Promise.all([loadProducts(), loadGovernorates()]).catch(error => {
  console.error('BuildCalc data loading failed:', error);
  setStatus(messages.loadError);
});

form?.addEventListener('submit', async event => {
  event.preventDefault();
  setStatus();
  const width = Number(document.getElementById('facade-width').value);
  const height = Number(document.getElementById('facade-height').value);
  const countValue = document.getElementById('facade-count').value.trim();
  const facadeCount = countValue ? Number(countValue) : 1;
  if (!(width > 0) || !(height > 0) || !(facadeCount >= 1) || !Number.isInteger(facadeCount)) {
    setStatus(messages.invalidInputs);
    return;
  }

  const product = productSelect.selectedOptions[0];
  if (!product || product.disabled || !product.value) return;
  const isEco = product.value.toLowerCase() === 'eco' || /\beco\b/i.test(product.textContent) || product.textContent.includes('إيكو');
  if (!isEco) {
    resultSection.classList.add('hidden');
    setStatus(messages.selectEco);
    return;
  }
  if (!governorateSelect.value) return;

  const button = document.getElementById('calculate-btn');
  button.disabled = true;
  try {
    const [priceSnapshot, shippingSnapshot] = await Promise.all([
      getDoc(doc(db, 'productsPrices', 'eco')),
      getDoc(doc(db, 'shippingPrices', governorateSelect.value))
    ]);
    if (!priceSnapshot.exists() || !Number.isFinite(Number(priceSnapshot.data().unitPrice))) {
      setStatus(messages.missingPrice);
      return;
    }
    if (!shippingSnapshot.exists() || !Number.isFinite(Number(shippingSnapshot.data().shippingCost))) {
      setStatus(messages.missingShipping);
      return;
    }
    const sacks = Math.ceil((width * height * facadeCount) / 5);
    const cost = sacks * Number(priceSnapshot.data().unitPrice);
    const shipping = Number(shippingSnapshot.data().shippingCost);
    document.getElementById('result-quantity').textContent = sacks.toLocaleString();
    document.getElementById('result-cost').textContent = cost.toLocaleString();
    document.getElementById('result-shipping').textContent = shipping.toLocaleString();
    document.getElementById('result-total').textContent = (cost + shipping).toLocaleString();
    resultSection.classList.remove('hidden');
  } catch (error) {
    console.error('BuildCalc calculation failed:', error);
    setStatus(messages.loadError);
  } finally {
    button.disabled = false;
  }
});
