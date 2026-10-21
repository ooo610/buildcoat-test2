import { db } from './firebase-config.js';
import { collection, doc, getDoc, getDocs } from 'https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js';

const isArabic = document.documentElement.lang.toLowerCase().startsWith('ar');
const text = {
  chooseProduct: isArabic ? 'اختر نوع المنتج' : 'Select a product',
  chooseGovernorate: isArabic ? 'اختر المحافظة' : 'Select a governorate',
  loading: isArabic ? 'جارٍ تحميل البيانات…' : 'Loading data…',
  noProducts: isArabic ? 'لا توجد منتجات' : 'No products available',
  noGovernorates: isArabic ? 'لا توجد محافظات' : 'No governorates available',
  productLoadError: isArabic ? 'تعذر تحميل المنتجات. تحقق من اتصال الإنترنت وصلاحيات قاعدة البيانات.' : 'Could not load products. Check your connection and database access.',
  governorateLoadError: isArabic ? 'تعذر تحميل المحافظات وأسعار الشحن. تحقق من اتصال الإنترنت وصلاحيات قاعدة البيانات.' : 'Could not load governorates and shipping prices. Check your connection and database access.',
  priceLoadError: isArabic ? 'تعذر تحميل سعر المنتج من قاعدة البيانات.' : 'Could not load the product price from the database.',
  selectEco: isArabic ? 'الحساب متاح حاليًا لمنتج بيلد كوت إيكو فقط.' : 'Calculations are currently available for BuildCoat Eco only.',
  missingPrice: isArabic ? 'سعر منتج إيكو غير متوفر.' : 'BuildCoat Eco pricing is unavailable.',
  missingShipping: isArabic ? 'سعر شحن المحافظة المختارة غير متوفر.' : 'Shipping price for the selected governorate is unavailable.',
  invalid: isArabic ? 'أدخل عرضًا وارتفاعًا صحيحين وعدد واجهات صحيحًا.' : 'Enter a valid width and height and a whole number of facades.'
};

const form = document.getElementById('calculator-form');
const productSelect = document.getElementById('product-select');
const governorateSelect = document.getElementById('governorate-select');
const resultSection = document.getElementById('results-section');
const status = document.createElement('p');
status.className = 'text-sm text-red-700';
status.setAttribute('role', 'status');
status.hidden = true;
form.append(status);

let governorates = new Map();
let unitPrice = null;

function showMessage(message = '') {
  status.textContent = message;
  status.hidden = !message;
}

function addOption(select, value, label, disabled = false, selected = false) {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = label;
  option.disabled = disabled;
  option.selected = selected;
  select.append(option);
}

async function loadProducts() {
  productSelect.replaceChildren();
  addOption(productSelect, '', text.loading, true);
  try {
    const snapshot = await getDocs(collection(db, 'inventorycms'));
    const products = snapshot.docs.map(item => ({ ...item.data(), id: item.id }))
      .filter(item => typeof (isArabic ? item.name_ar : item.name_en) === 'string' && (isArabic ? item.name_ar : item.name_en).trim())
      .sort((a, b) => (isArabic ? a.name_ar : a.name_en).localeCompare(isArabic ? b.name_ar : b.name_en));
    productSelect.replaceChildren();
    addOption(productSelect, '', products.length ? text.chooseProduct : text.noProducts, true);
    products.forEach(product => addOption(productSelect, product.id, (isArabic ? product.name_ar : product.name_en).trim(), product.active !== true));
  } catch (error) {
    console.error('BuildCalc product loading failed:', error);
    productSelect.replaceChildren();
    addOption(productSelect, '', text.productLoadError, true);
    showMessage(text.productLoadError);
  }
}

async function loadGovernorates() {
  governorateSelect.replaceChildren();
  addOption(governorateSelect, '', text.loading, true);
  try {
    const snapshot = await getDocs(collection(db, 'shippingPrices'));
    const places = snapshot.docs.map(item => ({ ...item.data(), id: item.id }))
      .filter(item => typeof (isArabic ? item.nameAr : item.nameEn) === 'string' && (isArabic ? item.nameAr : item.nameEn).trim())
      .sort((a, b) => (isArabic ? a.nameAr : a.nameEn).localeCompare(isArabic ? b.nameAr : b.nameEn));
    governorates = new Map(places.map(place => [place.id, place]));
    governorateSelect.replaceChildren();
    addOption(governorateSelect, '', places.length ? text.chooseGovernorate : text.noGovernorates, true, true);
    places.forEach(place => addOption(governorateSelect, place.id, (isArabic ? place.nameAr : place.nameEn).trim()));
  } catch (error) {
    console.error('BuildCalc governorate loading failed:', error);
    governorateSelect.replaceChildren();
    addOption(governorateSelect, '', text.governorateLoadError, true);
    showMessage(text.governorateLoadError);
  }
}

async function loadEcoPrice() {
  try {
    const directSnapshot = await getDoc(doc(db, 'productsPrices', 'eco'));
    let priceData = directSnapshot.exists() ? directSnapshot.data() : null;

    // Firestore document IDs can differ in capitalization or use a product name.
    if (!priceData || !Number.isFinite(Number(priceData.unitPrice))) {
      const snapshot = await getDocs(collection(db, 'productsPrices'));
      const ecoPriceDoc = snapshot.docs.find(item => {
        const data = item.data();
        const identifiers = [item.id, data.productId, data.product, data.name, data.name_en, data.name_ar, data.productName]
          .filter(value => typeof value === 'string').map(value => value.trim().toLowerCase());
        return identifiers.some(value => value === 'eco' || value.includes('buildcoat eco') || value.includes('إيكو'));
      });
      if (ecoPriceDoc) priceData = ecoPriceDoc.data();
    }

    if (priceData && Number.isFinite(Number(priceData.unitPrice))) unitPrice = Number(priceData.unitPrice);
    else showMessage(text.missingPrice);
  } catch (error) {
    console.error('BuildCalc price loading failed:', error);
    showMessage(text.priceLoadError);
  }
}

function calculateLive() {
  showMessage();
  const width = Number(document.getElementById('facade-width').value);
  const height = Number(document.getElementById('facade-height').value);
  const countInput = document.getElementById('facade-count').value.trim();
  const count = countInput ? Number(countInput) : 1;
  const product = productSelect.selectedOptions[0];
  const governorate = governorates.get(governorateSelect.value);

  if (!width || !height || !product?.value || !governorate) {
    resultSection.classList.add('hidden');
    return;
  }
  if (!(width > 0) || !(height > 0) || !(count >= 1) || !Number.isInteger(count)) {
    resultSection.classList.add('hidden');
    showMessage(text.invalid);
    return;
  }

  const isEco = product.value.toLowerCase() === 'eco' || /\beco\b/i.test(product.textContent) || product.textContent.includes('إيكو');
  if (!isEco) {
    resultSection.classList.add('hidden');
    showMessage(text.selectEco);
    return;
  }
  if (unitPrice === null) {
    resultSection.classList.add('hidden');
    showMessage(text.missingPrice);
    return;
  }
  if (!Number.isFinite(Number(governorate.shippingCost))) {
    resultSection.classList.add('hidden');
    showMessage(text.missingShipping);
    return;
  }

  const sacks = Math.ceil((width * height * count) / 5);
  const cost = sacks * unitPrice;
  const shipping = Number(governorate.shippingCost);
  document.getElementById('result-quantity').textContent = sacks.toLocaleString();
  document.getElementById('result-cost').textContent = cost.toLocaleString();
  document.getElementById('result-shipping').textContent = shipping.toLocaleString();
  document.getElementById('result-total').textContent = (cost + shipping).toLocaleString();
  resultSection.classList.remove('hidden');
}

form.addEventListener('submit', event => event.preventDefault());
['facade-width', 'facade-height', 'facade-count'].forEach(id => document.getElementById(id).addEventListener('input', calculateLive));
productSelect.addEventListener('change', calculateLive);
governorateSelect.addEventListener('change', calculateLive);
Promise.all([loadProducts(), loadGovernorates(), loadEcoPrice()]);
