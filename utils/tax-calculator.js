
const ApiMapper = require('./ApiMapper');

/**
 * fatura-master/src/Models/InvoiceItemModel.php birebir uyarlaması
 * https://github.com/mlevent/fatura#vergiler-ve-toplamlar
 * 
 * Hesaplama sırası (InvoiceItemModel.prepare() ile aynı):
 * 1. Constructor: fiyat, iskonto, malHizmetTutari, kdvTutari hesapla
 * 2. addTax: Manuel vergiler ekle (ÖTV, Damga, Stopaj vb.)
 * 3. prepare():
 *    a. kdvTutari += totalTaxVat()  → hasVat vergilerin KDV payını ekle
 *    b. addTax(KDVTevkifat, rate)   → Tevkifat ekle (GÜNCEL kdvTutari üzerinden)
 *    c. calculateTaxes()            → Lazy callable'ları çöz
 */

// isStoppage() = true olan vergiler
const STOPPAGE_CODES = ['9015', '0003', '0011', '9040'];

// isWithholding() = true olan vergiler
const WITHHOLDING_CODES = ['9015', '4171'];

// hasVat() = true olan vergiler (KDV payı hesaplanır)
const HAS_VAT_CODES = ['0061', '0071', '9077', '0073', '0074', '0075', '0076', '0077', '8002', '4071', '8004', '8005', '4171', '8001'];

class TaxCalculator {
    constructor() {
        this.items = [];
    }

    /**
     * addItem
     * InvoiceItemModel.__construct() + prepare() mantığıyla birebir çalışır
     */
    addItem(item) {
        // ========================================
        // 1. CONSTRUCTOR — Temel hesaplamalar
        // ========================================
        const miktar = parseFloat(item.quantity) || 1;
        const birimFiyat = parseFloat(item.price) || parseFloat(item.unitPrice) || 0;

        // fiyat = miktar * birimFiyat
        const fiyat = miktar * birimFiyat;

        // İskonto
        const iskontoOrani = parseFloat(item.discountRate) || 0;
        let iskontoTutari = parseFloat(item.discountAmount) || 0;
        const iskontoTipi = item.discountType || 'İskonto';

        // iskontoOrani varsa ve iskontoTutari yoksa, oranla hesapla
        if (iskontoOrani && !iskontoTutari) {
            iskontoTutari = fiyat * (iskontoOrani / 100);
        }

        // malHizmetTutari = fiyat ± iskonto
        let malHizmetTutari;
        if (!iskontoTutari) {
            malHizmetTutari = fiyat;
        } else {
            malHizmetTutari = iskontoTipi === 'İskonto'
                ? fiyat - iskontoTutari
                : fiyat + iskontoTutari;
        }
        malHizmetTutari = Math.max(0, malHizmetTutari);

        // kdvOrani
        const kdvOrani = parseFloat(item.kdvRate) || parseFloat(item.vatRate) || 0;

        // kdvTutari = malHizmetTutari * kdvOrani / 100
        let kdvTutari = malHizmetTutari * (kdvOrani / 100);

        // ========================================
        // 2. addTax — Manuel vergiler (Stopaj, Diğer)
        // ========================================
        const allTaxes = (item.taxes || []);
        const stopajList = allTaxes.filter(t => t.type === 'STOPAJ');
        const otherTaxesList = allTaxes.filter(t => t.type === 'OTHER');
        const tevkifat = allTaxes.find(t => t.type === 'TEVKIFAT');

        // Vergi hesapları (Tevkifat hariç, o lazy olacak)
        const computedTaxes = [];

        // Stopaj Vergileri: matrah (malHizmetTutari) üzerinden
        stopajList.forEach(s => {
            const code = String(s.code).padStart(4, '0');
            const rate = parseFloat(s.rate) || 0;
            const amount = malHizmetTutari * (rate / 100);
            const hasVat = HAS_VAT_CODES.includes(code);
            const vat = hasVat ? (amount * (kdvOrani / 100)) : 0;

            computedTaxes.push({
                code, rate,
                amount: Number(amount.toFixed(2)),
                vat: Number(vat.toFixed(2)),
                isStoppage: STOPPAGE_CODES.includes(code),
                isWithholding: WITHHOLDING_CODES.includes(code)
            });
        });

        // Diğer Vergiler: matrah (malHizmetTutari) üzerinden
        otherTaxesList.forEach(t => {
            const code = String(t.code).padStart(4, '0');
            const rate = parseFloat(t.rate) || 0;
            let amount;
            if (t.isRate !== false && rate > 0) {
                amount = malHizmetTutari * (rate / 100);
            } else {
                amount = parseFloat(t.amount) || 0;
            }

            // OTV1ListeTevkifat (4171): amount *= miktar
            if (code === '4171') {
                amount *= miktar;
            }

            const hasVat = HAS_VAT_CODES.includes(code);
            const vat = hasVat ? (amount * (kdvOrani / 100)) : 0;

            computedTaxes.push({
                code, rate,
                amount: Number(amount.toFixed(2)),
                vat: Number(vat.toFixed(2)),
                isStoppage: STOPPAGE_CODES.includes(code),
                isWithholding: WITHHOLDING_CODES.includes(code)
            });
        });

        // ========================================
        // 3. prepare() — InvoiceItemModel.prepare() sıralaması
        // ========================================

        // 3a. kdvTutari += totalTaxVat() — hasVat vergilerin KDV payını ekle
        const totalTaxVat = computedTaxes.reduce((acc, t) => acc + t.vat, 0);
        kdvTutari += totalTaxVat;

        // 3b. addTax(KDVTevkifat) — Tevkifat: GÜNCEL kdvTutari üzerinden
        const tevkifatRate = tevkifat ? parseFloat(tevkifat.rate) : 0;
        const tevkifatCode = tevkifat ? String(tevkifat.code) : (item.tevkifatCode || '');
        let tevkifatAmount = 0;

        if (tevkifatRate > 0) {
            // fatura-master: fn() => percentage($this->kdvTutari, $rate)
            // calculateTaxes() ile çözülür → GÜNCEL kdvTutari kullanılır
            tevkifatAmount = kdvTutari * (tevkifatRate / 100);

            computedTaxes.push({
                code: '9015',
                rate: tevkifatRate,
                amount: Number(tevkifatAmount.toFixed(2)),
                vat: 0, // KDVTevkifat hasVat=false
                isStoppage: true,
                isWithholding: true
            });
        }

        // ========================================
        // Final: Yuvarla ve kaydet
        // ========================================
        const calculatedItem = {
            raw: item,
            name: item.name,
            quantity: miktar,
            unitPrice: Number(birimFiyat.toFixed(2)),
            price: Number(fiyat.toFixed(2)),        // fiyat
            unitCode: ApiMapper.getUnitCode(item.unit),

            // İskonto
            iskontoTipi,
            iskontoOrani,
            discountAmount: Number(iskontoTutari.toFixed(2)),

            // Matrah ve KDV
            matrah: Number(malHizmetTutari.toFixed(2)),  // malHizmetTutari
            vatRate: kdvOrani,
            vatAmount: Number(kdvTutari.toFixed(2)),      // kdvTutari (vergilerin KDV payı dahil)

            // Tevkifat
            tevkifatCode: tevkifatCode,
            tevkifatRate: tevkifatRate,
            tevkifatAmount: Number(tevkifatAmount.toFixed(2)),

            // Per-item vergi listesi (fatura-master exportTaxes uyumlu)
            computedTaxes: computedTaxes,

            // Eski uyumluluk
            taxes: {
                stopaj: stopajList,
                other: otherTaxesList
            }
        };

        this.items.push(calculatedItem);
        return calculatedItem;
    }

    /**
     * calculateTotals
     * InvoiceModel.calculateTotals() birebir uyarlaması
     *
     * malHizmetToplamTutari  = Σ fiyat
     * matrah                 = Σ malHizmetTutari
     * hesaplananKdv          = Σ kdvTutari
     * toplamIskonto          = |Σ iskonto(İskonto) - Σ iskonto(Arttırım)|
     * vergilerToplami        = hesaplananKdv + Σ nonStoppage vergi tutarları
     * vergilerDahilToplamTutar = matrah + vergilerToplami
     * odenecekTutar          = vergilerDahilToplamTutar - Σ (stoppage + withholding)
     */
    calculateTotals() {
        // malHizmetToplamTutari = Σ fiyat
        const malHizmetToplamTutari = Number(
            this.items.reduce((acc, i) => acc + i.price, 0).toFixed(2)
        );

        // matrah = Σ malHizmetTutari
        const matrah = Number(
            this.items.reduce((acc, i) => acc + i.matrah, 0).toFixed(2)
        );

        // hesaplananKdv = Σ kdvTutari (vergilerin KDV payı dahil)
        const hesaplananKdv = Number(
            this.items.reduce((acc, i) => acc + i.vatAmount, 0).toFixed(2)
        );

        // toplamIskonto = |Σ İskonto - Σ Arttırım|
        const toplamIskonto = Number(Math.abs(
            this.items.filter(i => i.iskontoTipi === 'İskonto').reduce((acc, i) => acc + i.discountAmount, 0)
            -
            this.items.filter(i => i.iskontoTipi === 'Arttırım').reduce((acc, i) => acc + i.discountAmount, 0)
        ).toFixed(2));

        // Tüm vergiler düz liste
        const allTaxes = this.items.flatMap(i => i.computedTaxes);

        // Stopaj olmayan vergilerin toplamı → vergilerToplami'na dahil
        const nonStoppageTaxTotal = Number(
            allTaxes.filter(t => !t.isStoppage)
                .reduce((acc, t) => acc + t.amount, 0)
                .toFixed(2)
        );

        // Stopaj veya Withholding olan vergilerin toplamı → ödemeden düşülür
        const stoppageAndWithholdingTotal = Number(
            allTaxes.filter(t => t.isStoppage || t.isWithholding)
                .reduce((acc, t) => acc + t.amount, 0)
                .toFixed(2)
        );

        // Toplam Tevkifat (ayrı raporlama)
        const totalTevkifat = Number(
            this.items.reduce((acc, i) => acc + i.tevkifatAmount, 0).toFixed(2)
        );

        // vergilerToplami = hesaplananKdv + stopaj olmayan vergiler
        const vergilerToplami = Number((hesaplananKdv + nonStoppageTaxTotal).toFixed(2));

        // vergilerDahilToplamTutar = matrah + vergilerToplami
        let vergilerDahilToplamTutar = Number((matrah + vergilerToplami).toFixed(2));

        // odenecekTutar = vergilerDahilToplamTutar - (stopaj + withholding)
        let odenecekTutar = Number((vergilerDahilToplamTutar - stoppageAndWithholdingTotal).toFixed(2));

        // Sıfır kontrolü (GIB 0.00 sevmiyor)
        let baseT = matrah;
        if (this.items.length > 0) {
            if (baseT <= 0) {
                baseT = 0.01;
                vergilerDahilToplamTutar = Number((baseT + vergilerToplami).toFixed(2));
                odenecekTutar = Number((vergilerDahilToplamTutar - stoppageAndWithholdingTotal).toFixed(2));
            }
            if (odenecekTutar <= 0) odenecekTutar = 0.01;
        }

        return {
            totalMatrah: matrah,
            totalVAT: hesaplananKdv,
            totalTevkifat,
            totalDiscount: toplamIskonto,
            totalGross: malHizmetToplamTutari,
            vergilerToplami,
            includedTaxes: vergilerDahilToplamTutar,
            paymentPrice: odenecekTutar,
            baseT
        };
    }

    /**
     * groupTaxes
     * Vergileri kodlarına göre grupla (GIB dispatch payload'ı için)
     */
    groupTaxes() {
        const taxTotals = {};

        this.items.forEach(item => {
            item.computedTaxes.forEach(t => {
                if (!taxTotals[t.code]) taxTotals[t.code] = 0;
                taxTotals[t.code] += t.amount;
            });
        });

        const taxPayload = [];
        Object.keys(taxTotals).forEach(code => {
            if (taxTotals[code] > 0) {
                taxPayload.push({
                    taxCode: code,
                    totalTaxAmount: Number(taxTotals[code].toFixed(2))
                });
            }
        });

        return taxPayload;
    }
}

module.exports = TaxCalculator;
