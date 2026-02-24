const axios = require('axios');
const qs = require('qs');
const fs = require('fs');
const path = require('path');
const GIBError = require('./utils/GIBError');
const ApiMapper = require('./utils/ApiMapper');
const TaxCalculator = require('./utils/TaxCalculator');
const {
    EInvoice,
    EInvoiceApi,
    EInvoiceCountry,
    EInvoiceCurrencyType,
    InvoiceType,
    InvoiceApprovalStatus,
    EInvoiceUnitType
} = require('e-fatura');

// ... (existing constants like TEVKIFAT_DESCRIPTIONS are fine to keep here or move, but keeping for now)

// ...



const TEVKIFAT_DESCRIPTIONS = {
    '601': 'Yapım İşleri ile Birlikte İfa Edilen Mühendislik-Mimarlık ve Etüt-Proje Hizmetleri',
    '602': 'Etüt, Plan-Proje, Danışmanlık, Denetim ve Benzeri Hizmetler',
    '603': 'Makine, Teçhizat, Demirbaş ve Taşıtlara Ait Tadil, Bakım ve Onarım Hizmetleri',
    '604': 'Yemek Servis ve Organizasyon Hizmeti',
    '605': 'Organizasyon Hizmeti',
    '606': 'İşgücü Temin Hizmetleri',
    '607': 'Özel Güvenlik Hizmeti',
    '608': 'Yapı Denetim Hizmetleri',
    '609': 'Fason Olarak Yaptırılan Tekstil ve Konfeksiyon İşleri, Çanta ve Ayakkabı Dikim İşleri ve Bu İşlere Aracılık Hizmetleri',
    '610': 'Turistik Mağazalara Verilen Müşteri Bulma / Götürme Hizmetleri',
    '611': 'Spor Kulüplerinin Yayın, İsim Hakkı ve Reklam Gelirlerine Konu İşlemleri',
    '612': 'Temizlik Hizmeti',
    '613': 'Çevre ve Bahçe Bakım Hizmetleri (Haşere İlaçlama Dahil)',
    '614': 'Servis Taşımacılığı Hizmeti',
    '615': 'Her Türlü Baskı ve Basım Hizmetleri',
    '616': 'Diğer Hizmetler',
    '617': 'Sağlık Tesislerine İlişkin İşletme Döneminde Sunulan Hizmetler',
    '618': 'Metal, Plastik, Lastik, Kauçuk, Kağıt, Cam Hurda ve Atıkları',
    '619': 'Hurda ve Atıklardan Elde Edilen Hammadde Teslimi',
    '620': 'Pamuk, Tiftik, Yün ve Yapağı ile Ham Post ve Deri Teslimleri',
    '621': 'Ağaç ve Orman Ürünleri Teslimi',
    '622': 'Küspe, Kepek, Razmol ve Benzeri Maddeler ile Bunlardan Mamul Yem Teslimleri',
    '623': 'Bakır, Çinko, Alüminyum ve Kurşun Ürünlerinin Teslimi',
    '624': 'Yük Taşımacılığı Hizmeti [KDVGUT-(I/C-2.1.3.2.11)]',
    '625': 'Ticari Reklam Hizmetleri',
    '626': 'Gayrimenkul Satışları (Müzayede Mahallerindeki)',
    '627': 'Demir-Çelik Ürünlerinin Teslimi'
};

/**
 * Converts a number to Turkish words for invoice notes
 */
function numberToTurkishText(num) {
    const units = ['', 'Bir', 'İki', 'Üç', 'Dört', 'Beş', 'Altı', 'Yedi', 'Sekiz', 'Dokuz'];
    const tens = ['', 'On', 'Yirmi', 'Otuz', 'Kırk', 'Elli', 'Altmış', 'Yetmiş', 'Seksen', 'Doksan'];
    const scales = ['', 'Bin', 'Milyon', 'Milyar', 'Trilyon'];

    function convertGroup(n) {
        let res = '';
        if (n >= 100) {
            res += (n >= 200 ? units[Math.floor(n / 100)] : '') + 'Yüz';
            n %= 100;
        }
        if (n >= 10) {
            res += tens[Math.floor(n / 10)];
            n %= 10;
        }
        if (n > 0) {
            res += units[n];
        }
        return res;
    }

    if (num === 0) return 'Yalnız SıfırTürkLirası';

    const parts = num.toFixed(2).split('.');
    let wholePart = parseInt(parts[0]);
    let decimalPart = parseInt(parts[1]);

    let result = '';
    let scaleIdx = 0;

    if (wholePart === 0) {
        result = 'Sıfır';
    } else {
        while (wholePart > 0) {
            let group = wholePart % 1000;
            if (group > 0) {
                let groupText = convertGroup(group);
                if (scaleIdx === 1 && group === 1) groupText = ''; // "BirBin" -> "Bin"
                result = groupText + scales[scaleIdx] + result;
            }
            wholePart = Math.floor(wholePart / 1000);
            scaleIdx++;
        }
    }

    result += 'TürkLirası';

    if (decimalPart > 0) {
        result += convertGroup(decimalPart) + 'Kuruş';
    }

    return 'Yalnız ' + result;
}

// Setup Puppeteer for PDF generation
const puppeteer = require('puppeteer-core');
const chromium = require('chrome-aws-lambda');

/**
 * Helper to launch Puppeteer/Chromium
 */
async function launchBrowserHelper() {
    try {
        // Try chrome-aws-lambda first (useful in serverless or restricted envs)
        const execPath = await chromium.executablePath;
        if (execPath) {
            return await puppeteer.launch({
                args: chromium.args,
                defaultViewport: chromium.defaultViewport,
                executablePath: execPath,
                headless: true
            });
        }
    } catch (e) {
        console.log('E-Fatura: chrome-aws-lambda not available, trying local Chrome...');
    }

    // Fallback to local Chrome or Edge paths
    const chromePaths = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        process.env.CHROME_PATH
    ].filter(Boolean);

    for (const chromePath of chromePaths) {
        try {
            if (fs.existsSync(chromePath)) {
                return await puppeteer.launch({
                    executablePath: chromePath,
                    headless: true,
                    args: ['--no-sandbox', '--disable-setuid-sandbox']
                });
            }
        } catch (e) {
            continue;
        }
    }

    throw new Error('Chrome executable not found. Please install Google Chrome or set CHROME_PATH environment variable.');
}

/**
 * Custom HTML to PDF converter to bypass library's broken internal version
 */
async function htmlToPdfHelper(html, options = {}) {
    const browser = await launchBrowserHelper();
    try {
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'domcontentloaded' });

        const pdfBytes = await page.pdf({
            format: 'A4',
            margin: { top: 10, left: 10, right: 10, bottom: 10 },
            ...options,
            path: undefined
        });

        return Buffer.from(pdfBytes);
    } finally {
        await browser.close();
    }
}

/**
 * Runtime Patch for EInvoice.getInvoicePdf
 * Resolves "launchBrowser is not a function" error in e-fatura library
 */
const originalGetInvoicePdf = EInvoice.getInvoicePdf;
EInvoice.getInvoicePdf = async function (uuid, signed = true, options = {}) {
    // We call getInvoiceHtml which is working fine
    console.log(`E-Fatura Patch: Fetching HTML for PDF conversion (UUID: ${uuid}, Signed: ${signed})...`);
    const html = await this.getInvoiceHtml(uuid, signed);

    // Convert to PDF using our fixed helper
    console.log('E-Fatura Patch: Converting HTML to PDF using custom helper...');
    return await htmlToPdfHelper(html, options);
};

/**
 * GIB E-Fatura Integration Service
 * Manages authentication and invoice operations using e-fatura library
 */
class EFaturaService {

    constructor() {
        // E-Fatura library handles sessions internally via singleton usually, 
        // but we might need to ensure connection state.
        this.isConnected = false;
        this.username = '';
        this.password = '';
        this.testMode = false;
    }

    /**
     * Connect to GIB Portal
     * @param {string} username 
     * @param {string} password 
     * @param {boolean} testMode 
     */
    async connect(username, password, testMode = false, force = false) {
        if (!username || !password) {
            throw new Error("Kullanıcı adı ve şifre gereklidir.");
        }

        // Force reconnect if credentials or mode changed or force flag is true
        if (force || (this.isConnected &&
            (this.username !== String(username) ||
                this.password !== String(password) ||
                this.testMode !== !!testMode))) {
            console.log('E-Fatura: Credentials/mode changed or Force Reconnect, resetting...');
            this.isConnected = false;
            try {
                // Attempt logout if supported to clear library state
                if (EInvoice.logOut) await EInvoice.logOut();
            } catch (ignore) { }
        }

        if (this.isConnected) return { success: true, message: 'Zaten bağlı.' };

        try {
            console.log(`E-Fatura: Connecting to GIB Portal (TestMode: ${testMode})...`);

            this.username = String(username);
            this.password = String(password);
            this.testMode = !!testMode;

            // Set test mode
            EInvoice.setTestMode(this.testMode);

            // Connect
            await EInvoice.connect({
                username: this.username,
                password: this.password
            });

            this.isConnected = true;
            console.log('E-Fatura: Connected successfully');

            return { success: true, message: 'GIB portalına bağlanıldı.' };

        } catch (error) {
            console.error('E-Fatura Connection Error:', error);
            this.isConnected = false;
            throw new Error(`Bağlantı hatası: ${error.message}`);
        }
    }

    /**
     * Set anonymous credentials (for non-interactive use mostly, but library might need it)
     */
    setAnonymousCredentials() {
        try {
            EInvoice.setAnonymousCredentials();
            console.log('E-Fatura: Anonymous credentials set (if applicable).');
        } catch (e) { /* ignore */ }
    }

    /**
     * Get Recipient Info by VKN/TCKN
     * uses internal API call if available or manual request construction
     */
    async getRecipientInfo(vknTckn) {
        if (!this.isConnected) {
            await this.connect(this.username, this.password, this.testMode);
        }

        try {
            console.log(`E-Fatura: Querying Recipient Info for ${vknTckn}...`);

            // Use built-in method
            const info = await EInvoice.getCompanyInformation(vknTckn);

            console.log('Recipient Query Response:', info);

            if (info) {
                return {
                    title: info.title || '',
                    name: info.firstName || '',
                    surname: info.lastName || '',
                    taxOffice: info.taxOffice || ''
                };
            }

            return null;

        } catch (error) {
            console.error('Error querying recipient:', error);
            // If checking fails (e.g. not found or API error), return null
            return null;
        }
    }

    /**
     * Update GIB Portal User (Seller) Information
     * Syncs the app's personal info to the GIB portal profile so invoices
     * show the correct seller details.
     */
    async updateUserInfo(personalInfo) {
        if (!personalInfo) return;
        if (!this.isConnected) {
            await this.connect(this.username, this.password, this.testMode);
        }

        try {
            // Build the title: use companyTitle for companies, or firstName+lastName for individuals
            let title = personalInfo.companyTitle || '';
            if (!title && (personalInfo.firstName || personalInfo.lastName)) {
                title = [personalInfo.firstName, personalInfo.lastName].filter(Boolean).join(' ');
            }

            const payload = {
                title: title,
                firstName: personalInfo.firstName || '',
                lastName: personalInfo.lastName || '',
                taxOrIdentityNumber: personalInfo.vkn || personalInfo.tcNo || '',
                taxOffice: personalInfo.taxOffice || '',
                street: personalInfo.businessAddress || personalInfo.address || '',
                phoneNumber: personalInfo.phone || '',
                email: personalInfo.email || '',
                mersisNumber: personalInfo.mersisNo || '',
                recordNumber: personalInfo.tradeRegistryNo || ''
            };

            // Only update if we have at least a title or name
            if (payload.title || payload.firstName) {
                console.log('E-Fatura: Updating user information on GIB portal...');
                await EInvoice.updateUserInformation(payload);
                console.log('E-Fatura: User information updated successfully.');
            }
        } catch (error) {
            // Non-fatal: log but don't block invoice creation
            console.warn('E-Fatura: Could not update user info (non-fatal):', error.message);
        }
    }

    /**
     * Get Invoice Details by UUID
     */
    async getInvoiceDetails(uuid) {
        try {
            console.log(`[EFaturaService] Getting invoice details for UUID: ${uuid}`);
            const invoice = await EInvoice.getInvoice(uuid);
            return { success: true, invoice };
        } catch (error) {
            console.error('[EFaturaService] getInvoiceDetails error:', error);
            throw error;
        }
    }

    /**
     * Create a new E-Arşiv Invoice
     */
    /**
     * Prepare Invoice Payload using Utils
     */
    _prepareInvoicePayload(invoiceData, forcedUuid = null) {
        const calculator = new TaxCalculator();

        // 1. Process Items
        invoiceData.items.forEach(item => {
            calculator.addItem(item);
        });

        // 2. Calculate Totals
        const totals = calculator.calculateTotals();

        // 3. Prepare Date/Time
        const dateObj = new Date(invoiceData.date);
        const d = String(dateObj.getDate()).padStart(2, '0');
        const m = String(dateObj.getMonth() + 1).padStart(2, '0');
        const y = dateObj.getFullYear();
        const formattedDate = `${d}/${m}/${y}`;
        const formattedTime = dateObj.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

        // 4. Determine Invoice Type
        const invoiceTypeMap = {
            'SATIS': InvoiceType.SATIS,
            'IADE': InvoiceType.IADE,
            'TEVKIFAT': InvoiceType.TEVKIFAT,
            'ISTISNA': InvoiceType.ISTISNA,
            'OZELMATRAH': InvoiceType.OZELMATRAH
        };
        const type = totals.totalTevkifat > 0 ? InvoiceType.TEVKIFAT : (invoiceTypeMap[invoiceData.type] || InvoiceType.SATIS);

        // 5. Amount in Words
        const priceInWords = numberToTurkishText(totals.paymentPrice);

        // 6. Notes
        let noteLines = [];
        if (Array.isArray(invoiceData.notes) && invoiceData.notes.length > 0) {
            noteLines = [...invoiceData.notes];
        } else if (invoiceData.note) {
            noteLines.push(invoiceData.note);
        }
        noteLines.push(priceInWords);

        // 7. Base Payload Construction
        const payload = {
            uuid: forcedUuid || invoiceData.uuid,
            date: formattedDate,
            time: formattedTime,
            invoiceType: type,
            whichType: '5000/30000',
            hangiTip: '5000/30000',
            currency: EInvoiceCurrencyType.TURK_LIRASI,
            taxOrIdentityNumber: invoiceData.receiver.vknTckn,
            buyerTitle: (invoiceData.receiver.vknTckn?.length === 10) ? (invoiceData.receiver.title || '') : '',
            buyerFirstName: (invoiceData.receiver.vknTckn?.length === 11) ? (invoiceData.receiver.name || '') : '',
            buyerLastName: (invoiceData.receiver.vknTckn?.length === 11) ? (invoiceData.receiver.surname || '') : '',
            taxOffice: invoiceData.receiver.taxOffice || '',
            country: EInvoiceCountry.TURKIYE,
            sehir: invoiceData.receiver.city || '',
            ilce: invoiceData.receiver.district || '',
            bulvarcaddesokak: invoiceData.receiver.address || '',
            mahalleSemtIlce: '', // Gerekirse frontend'den alınabilir, şimdilik boş

            // Map Items from Calculator (fatura-master uyumlu)
            products: calculator.items.map(p => {
                const productObj = {
                    name: p.name,
                    quantity: p.quantity,
                    unitPrice: p.unitPrice,
                    price: p.price,
                    totalAmount: p.matrah,
                    unitType: EInvoiceUnitType[p.unitCode] || EInvoiceUnitType.ADET,
                    vatRate: p.vatRate,
                    vatAmount: p.vatAmount,
                    taxRate: p.tevkifatRate,
                    vatAmountOfTax: String(p.tevkifatAmount),
                    tevkifatKodu: p.tevkifatCode,
                    vergiKodu: p.tevkifatCode,
                    istisnaKodu: (p.vatRate === 0 && p.raw.exemptionCode) ? String(p.raw.exemptionCode) : '',
                    discountOrIncrement: 'İskonto',
                    discountOrIncrementRate: 0,
                    discountOrIncrementAmount: p.discountAmount,
                    discountOrIncrementReason: '',
                };

                // fatura-master: Per-item vergi alanları (V{code}Orani, V{code}Tutari, V{code}KdvTutari)
                // e-fatura kütüphanesi ...other spread ile GIB'e iletir
                p.computedTaxes.forEach(t => {
                    productObj[`V${t.code}Orani`] = t.rate;
                    productObj[`V${t.code}Tutari`] = t.amount.toString();
                    if (t.vat > 0) {
                        productObj[`V${t.code}KdvTutari`] = t.vat.toString();
                    }
                });

                return productObj;
            }),

            // Tax Type for Header
            taxType: (type === InvoiceType.TEVKIFAT) ? (calculator.items.find(p => p.tevkifatCode)?.tevkifatCode || '') : undefined,

            // fatura-master formülleri:
            // hesaplanankdv         = Σ kdvTutari (vergilerin KDV payı dahil)
            // vergilerToplami       = hesaplanankdv + Σ nonStoppage vergi tutarları
            // vergilerDahilToplamTutar = matrah + vergilerToplami
            // odenecekTutar         = vergilerDahilToplamTutar - Σ (stoppage + withholding)
            base: totals.baseT,
            productsTotalPrice: totals.totalGross,
            totalDiscountOrIncrement: totals.totalDiscount,
            calculatedVAT: totals.totalVAT,
            totalTaxes: totals.vergilerToplami,
            includedTaxesTotalPrice: totals.includedTaxes,
            paymentPrice: totals.paymentPrice,

            // Taxes Array from Calculator
            taxes: calculator.groupTaxes(),

            specialBaseAmount: 0,
            specialBasePercent: 0,
            specialBaseTaxAmount: 0,
            not: noteLines.join('\n') || 'İşbu fatura e-arşiv fatura olarak düzenlenmiştir.'
        };

        // 8. IADE Handling
        if (invoiceData.type === 'IADE' && invoiceData.returnInvoiceInfo) {
            const rDate = new Date(invoiceData.returnInvoiceInfo.invoiceDate);
            const rDateFormatted = `${String(rDate.getDate()).padStart(2, '0')}/${String(rDate.getMonth() + 1).padStart(2, '0')}/${rDate.getFullYear()}`;
            payload.refundTable = [{
                invoiceNumber: invoiceData.returnInvoiceInfo.invoiceNumber,
                date: rDateFormatted
            }];
            payload.invoiceType = InvoiceType.IADE;
        }

        // 9. Waybill (İrsaliye)
        if (invoiceData.waybill && invoiceData.waybill.number) {
            payload.waybillNumber = invoiceData.waybill.number;
            if (invoiceData.waybill.date) {
                const wd = new Date(invoiceData.waybill.date);
                const wdf = `${String(wd.getDate()).padStart(2, '0')}/${String(wd.getMonth() + 1).padStart(2, '0')}/${wd.getFullYear()}`;
                payload.waybillDate = wdf;
            }
        }

        // 10. Tevkifat Summaries
        if (type === InvoiceType.TEVKIFAT) {
            const tevkifatItems = calculator.items.filter(p => p.tevkifatRate > 0);
            if (tevkifatItems.length > 0) {
                payload.tevkifatKdvTutari = totals.totalTevkifat;
                payload.tevkifataTabiIslemTutari = Number(tevkifatItems.reduce((acc, p) => acc + p.matrah, 0).toFixed(2));
                payload.tevkifataTabiIslemUzerindenHesaplananKdv = Number(tevkifatItems.reduce((acc, p) => acc + p.vatAmount, 0).toFixed(2));
            }
        }

        // 11. Validations
        if (!payload.taxOrIdentityNumber) throw new GIBError("Alıcı VKN/TCKN bilgisi zorunludur.");
        if (payload.products.length === 0) throw new GIBError("Fatura en az bir kalem ürün/hizmet içermelidir.");

        return payload;
    }

    /**
     * Create a new E-Arşiv Invoice
     */
    async createDraftInvoice(invoiceData) {
        if (!this.isConnected) {
            await this.connect(this.username, this.password, this.testMode);
        }

        try {
            console.log('E-Fatura: Preparing invoice payload...');
            const payload = this._prepareInvoicePayload(invoiceData);
            console.log('E-Fatura Payload:', JSON.stringify(payload, null, 2));

            // Create draft invoice
            const result = await EInvoice.createDraftInvoice(payload);

            console.log(`E-Fatura: Create result raw:`, result);

            // Extract UUID
            let uuid = null;
            if (typeof result === 'string') {
                uuid = result;
            } else if (typeof result === 'object' && result.uuid) {
                uuid = result.uuid;
            } else {
                console.warn("E-Fatura: UUID could not be parsed standardly from result.");
            }

            if (!uuid && result && result.ettn) uuid = result.ettn; // fallback alias

            if (!uuid) {
                // GIBError transformation
                throw new GIBError("Fatura oluşturuldu ancak UUID alınamadı.", "UUID_MISSING", { result });
            }

            console.log(`E-Fatura: Draft invoice created with UUID: ${uuid}`);

            return {
                success: true,
                uuid: uuid,
                message: 'Fatura taslağı başarıyla oluşturuldu.'
            };

        } catch (error) {
            console.error('E-Fatura Create Invoice Error:', error);
            throw GIBError.fromResponse(error, 'Fatura oluşturma işlemi');
        }
    }

    /**
     * Get invoices list from GIB portal
     * @param {Object} filter 
     * @param {boolean} skipRequests - If true, skips cross-referencing with cancel requests (prevents recursion)
     */
    async getInvoices(filter = {}, skipRequests = false) {
        if (!this.isConnected) {
            await this.connect(this.username, this.password, this.testMode);
        }

        try {
            console.log('E-Fatura: Getting invoices list...');

            const filterParams = {};

            // Set default date range to last 6 months to be safe
            const defaultEndDate = new Date();
            const defaultStartDate = new Date();
            defaultStartDate.setMonth(defaultStartDate.getMonth() - 6);

            // Kütüphane Date objesi veya DD/MM/YYYY string kabul eder
            if (filter.startDate) {
                // YYYY-MM-DD formatından Date objesine çevir
                filterParams.startDate = new Date(filter.startDate);
            } else {
                filterParams.startDate = defaultStartDate;
            }

            if (filter.endDate) {
                filterParams.endDate = new Date(filter.endDate);
            } else {
                filterParams.endDate = defaultEndDate;
            }

            // Add approval status filter
            if (filter.approvalStatus) {
                const statusMap = {
                    'draft': InvoiceApprovalStatus.UNAPPROVED,
                    'signed': InvoiceApprovalStatus.APPROVED,
                    'canceled': InvoiceApprovalStatus.DELETED
                };
                // Maps 'all' to undefined implicitly if not in map, which is what we want for 'all'
                if (statusMap[filter.approvalStatus]) {
                    filterParams.approvalStatus = statusMap[filter.approvalStatus];
                }
            }

            console.log('E-Fatura: Filter params:', filterParams);

            let invoices;
            try {
                invoices = await EInvoice.getBasicInvoices(filterParams);
            } catch (err) {
                // Retry Logic for Session Timeouts
                const errMsg = err.message || '';
                if (errMsg.includes('zaman aşım') || errMsg.includes('oturum') || errMsg.includes('session') || errMsg.includes('token') || errMsg.includes('Token')) {
                    console.warn("E-Fatura: Session timeout detected, forcing reconnect and retrying...");
                    // Force reconnect
                    await this.connect(this.username, this.password, this.testMode, true);
                    // Retry fetch
                    invoices = await EInvoice.getBasicInvoices(filterParams);
                } else {
                    throw err;
                }
            }

            console.log(`E-Fatura: Retrieved ${invoices.length} invoices`);

            // --- CROSS-REFERENCE CANCEL REQUESTS ---
            // Fetch cancel/objection requests to identify invoices that are actually cancelled
            // even if GIB main list says 'Onaylandı'.
            let cancelMap = new Map();

            // recursion break: don't look up requests if we are already inside a request fetch or explicitly skipped
            if (!skipRequests) {
                try {
                    // IMPORTANT: To ensure we find requests for invoices in the current list, 
                    // we search for requests from the earliest possible date (provided in filter) 
                    // until NOW.
                    const requestEndDate = new Date();
                    // Search requests at least from 6 months ago to catch any relevant activity
                    const requestStartDate = filterParams.startDate ? new Date(filterParams.startDate) : new Date(new Date().setMonth(new Date().getMonth() - 6));
                    // Small adjustment: If invoice list is older than 6 months, use its start date
                    const finalRequestStart = requestStartDate < filterParams.startDate ? requestStartDate : filterParams.startDate;

                    console.log('E-Fatura: Cross-referencing status with Cancel/Objection requests...');
                    const reqResult = await this.getCancelRequests(finalRequestStart, requestEndDate);

                    // DEBUG TO FILE
                    try {
                        const debugInfo = {
                            searchStart: finalRequestStart,
                            searchEnd: requestEndDate,
                            totalRequestsFound: reqResult.invoices ? reqResult.invoices.length : 0,
                            sampleRequest: reqResult.invoices && reqResult.invoices.length > 0 ? reqResult.invoices[0] : null,
                            allRequestKeys: []
                        };
                        if (reqResult.success && reqResult.invoices) {
                            reqResult.invoices.forEach(req => {
                                const raw = req.raw || {};
                                const keys = [
                                    (req.uuid || '').toUpperCase().trim(),
                                    (req.documentNumber || '').toUpperCase().trim(),
                                    (raw.uuid || '').toUpperCase().trim(),
                                    (raw.faturaUuid || '').toUpperCase().trim(),
                                    (raw.faturaEttn || '').toUpperCase().trim(),
                                    (raw.belgeNumarasi || '').toUpperCase().trim(),
                                    (raw.belgeNo || '').toUpperCase().trim(),
                                    (raw.faturaNo || '').toUpperCase().trim()
                                ].filter(k => k && k !== '-' && k.length > 5);
                                debugInfo.allRequestKeys.push({ keys, status: req.approvalStatus, type: req.requestType });
                            });
                        }
                        require('fs').writeFileSync('./server/debug_status_map.json', JSON.stringify(debugInfo, null, 2));
                    } catch (e) { console.error('Debug write failed', e); }
                    if (reqResult.success && reqResult.invoices) {
                        reqResult.invoices.forEach(req => {
                            const raw = req.raw || {};
                            // Map all possible uniquely identifying fields from both mapped and raw data
                            const keys = [
                                (req.uuid || '').toUpperCase().trim(),
                                (req.documentNumber || '').toUpperCase().trim(),
                                (raw.uuid || '').toUpperCase().trim(),
                                (raw.faturaUuid || '').toUpperCase().trim(),
                                (raw.faturaEttn || '').toUpperCase().trim(),
                                (raw.ettn || '').toUpperCase().trim(),
                                (raw.belgeNumarasi || '').toUpperCase().trim(),
                                (raw.belgeNo || '').toUpperCase().trim(),
                                (raw.faturaNo || '').toUpperCase().trim(),
                                (raw.documentNumber || '').toUpperCase().trim(),
                                (raw.ettn_id || '').toUpperCase().trim(),
                                (raw.ettnId || '').toUpperCase().trim()
                            ].filter(k => k && k !== '-' && k.length > 5);

                            keys.forEach(key => {
                                if (!cancelMap.has(key)) {
                                    cancelMap.set(key, req);
                                } else {
                                    const existing = cancelMap.get(key);
                                    const newStatus = (req.approvalStatus || '').toUpperCase();
                                    // Overwrite if new one is more "decisive"
                                    if (newStatus.includes('ONAY') || newStatus.includes('KABUL') || newStatus.includes('İPTAL') || newStatus.includes('SİL')) {
                                        cancelMap.set(key, req);
                                    }
                                }
                            });
                        });
                        console.log(`E-Fatura: Cross-ref map built with ${cancelMap.size} unique keys.`);
                    }
                } catch (reqErr) {
                    console.warn('E-Fatura: Could not fetch cancel requests for cross-ref:', reqErr.message);
                }
            }
            // ---------------------------------------

            // DEBUG: Log first invoice structure to file
            if (invoices && invoices.length > 0) {
                try {
                    require('fs').writeFileSync('./server/debug_log.txt', JSON.stringify(invoices[0], null, 2));
                } catch (e) {
                    console.error('Failed to log debug info', e);
                }
            }

            // Safety check: Ensure invoices is an array
            if (!Array.isArray(invoices)) {
                console.warn('E-Fatura: getBasicInvoices returned non-array:', invoices);
                // Return empty list instead of crashing or erroring
                return {
                    success: true,
                    invoices: []
                };
            }

            // Helper to safe string
            const s = (val) => val || '';

            // Helper to parse XML and extract attributes
            const extractXmlData = (xmlString) => {
                const result = { payableAmount: 0, issueDate: null, itemNames: [], taxableAmount: 0, buyerTitle: null };
                try {
                    // Extract PayableAmount
                    const amountMatch = xmlString.match(/<cbc:PayableAmount[^>]*>([\d.,]+)<\/cbc:PayableAmount>/i);
                    if (amountMatch && amountMatch[1]) {
                        let amountStr = amountMatch[1].trim();
                        if (amountStr.includes('.') && amountStr.includes(',')) {
                            amountStr = amountStr.replace(/\./g, '').replace(',', '.');
                        } else if (amountStr.includes(',')) {
                            amountStr = amountStr.replace(',', '.');
                        }
                        result.payableAmount = parseFloat(amountStr) || 0;
                    }

                    // Extract IssueDate (YYYY-MM-DD usually in XML)
                    const dateMatch = xmlString.match(/<cbc:IssueDate>([\d-]+)<\/cbc:IssueDate>/i);
                    if (dateMatch && dateMatch[1]) {
                        result.issueDate = dateMatch[1].trim();
                    }

                    // Extract Buyer Title (Muhatap) - Priority: cac:AccountingCustomerParty
                    const customerPartyMatch = xmlString.match(/<cac:AccountingCustomerParty>([\s\S]*?)<\/cac:AccountingCustomerParty>/i);
                    if (customerPartyMatch && customerPartyMatch[1]) {
                        const customerXml = customerPartyMatch[1];
                        // Specific pattern requested by user: PartyName > Name
                        const nameMatch = customerXml.match(/<cac:PartyName>\s*<cbc:Name>([^<]+)<\/cbc:Name>/i);
                        if (nameMatch && nameMatch[1]) {
                            result.buyerTitle = nameMatch[1].trim();
                        } else {
                            // Fallback for individuals: Person > FirstName/FamilyName
                            const firstNameMatch = customerXml.match(/<cbc:FirstName>([^<]+)<\/cbc:FirstName>/i);
                            const lastNameMatch = customerXml.match(/<cbc:FamilyName>([^<]+)<\/cbc:FamilyName>/i);
                            if (firstNameMatch || lastNameMatch) {
                                result.buyerTitle = `${firstNameMatch ? firstNameMatch[1].trim() : ''} ${lastNameMatch ? lastNameMatch[1].trim() : ''}`.trim();
                            }
                        }
                    }

                    // Extract Item Names from <cbc:Name> inside InvoiceLine > Item
                    const lineMatches = xmlString.matchAll(/<cac:InvoiceLine>([\s\S]*?)<\/cac:InvoiceLine>/gi);
                    for (const lineMatch of lineMatches) {
                        const lineXml = lineMatch[1];
                        const nameMatch = lineXml.match(/<cbc:Name>([^<]+)<\/cbc:Name>/i);
                        if (nameMatch && nameMatch[1]) {
                            result.itemNames.push(nameMatch[1].trim());
                        }
                    }

                    // Extract TaxableAmount from TaxTotal > TaxSubtotal > TaxableAmount
                    const taxableMatches = xmlString.matchAll(/<cbc:TaxableAmount[^>]*>([\d.,]+)<\/cbc:TaxableAmount>/gi);
                    for (const match of taxableMatches) {
                        if (match[1]) {
                            let taxStr = match[1].trim();
                            if (taxStr.includes('.') && taxStr.includes(',')) {
                                taxStr = taxStr.replace(/\./g, '').replace(',', '.');
                            } else if (taxStr.includes(',')) {
                                taxStr = taxStr.replace(',', '.');
                            }
                            const val = parseFloat(taxStr);
                            if (!isNaN(val)) result.taxableAmount += val;
                        }
                    }
                } catch (e) {
                    console.error('Error parsing XML data:', e);
                }
                return result;
            };

            console.log('E-Fatura: Fetching amounts from XML for each invoice...');

            // Enhanced mapping with XML amount extraction
            const mappedInvoices = await Promise.all(invoices.map(async (inv) => {
                let payableAmount = 0;
                let issueDate = null;
                let itemNames = [];
                let taxableAmount = 0;

                let xmlBuyerTitle = null;

                try {
                    // Determine if invoice is signed based on approval status
                    const isSigned = inv.approvalStatus &&
                        (inv.approvalStatus.toLowerCase().includes('onaylandı') ||
                            inv.approvalStatus.toLowerCase().includes('imzalandı'));

                    // Fetch XML to get PayableAmount, IssueDate, ItemNames, TaxableAmount and BuyerTitle
                    const xmlBuffer = await EInvoice.getInvoiceXml(inv.uuid, isSigned);
                    const xmlString = xmlBuffer.toString('utf-8');
                    const xmlData = extractXmlData(xmlString);

                    payableAmount = xmlData.payableAmount;
                    issueDate = xmlData.issueDate;
                    itemNames = xmlData.itemNames || [];
                    taxableAmount = xmlData.taxableAmount || 0;
                    xmlBuyerTitle = xmlData.buyerTitle;

                } catch (xmlError) {
                    console.warn(`Failed to get XML for invoice ${inv.uuid}:`, xmlError.message);
                    // If XML fetch fails, try to parse from other fields as fallback
                    const amountRaw = inv.payableAmount || inv.odenecekTutar || inv.OdenecekTutar ||
                        inv.paymentPrice || inv.tutar || inv.Tutar || inv.totalAmount ||
                        inv.malHizmetTutari;
                    if (amountRaw) {
                        if (typeof amountRaw === 'number') payableAmount = amountRaw;
                        else if (typeof amountRaw === 'string') {
                            let clean = amountRaw.replace(/[^\d.,]/g, '');
                            if (clean.includes(',') && clean.indexOf(',') > clean.indexOf('.')) {
                                clean = clean.replace(/\./g, '').replace(',', '.');
                            } else if (clean.includes(',') && !clean.includes('.')) {
                                clean = clean.replace(',', '.');
                            }
                            payableAmount = parseFloat(clean) || 0;
                        }
                    }
                }

                // For debugging status logic:
                const debugUuid = (inv.uuid || '').toUpperCase();

                return {
                    uuid: inv.uuid,
                    documentNumber: inv.documentNumber || inv.belgeNumarasi || inv.belgeNo || inv.uuid,
                    date: issueDate || inv.documentDate || inv.belgeTarihi || inv.date || inv.issueDate,
                    time: inv.time || inv.issueTime,
                    buyerTitle: xmlBuyerTitle || s(inv.titleOrFullName || inv.buyerTitle || inv.aliciUnvan || inv.aliciUnvanAdSoyad || inv.receiver?.title || inv.receiver?.unvan || inv.customer?.title),
                    buyerFirstName: s(inv.buyerFirstName || inv.aliciAdi || inv.receiver?.firstName || inv.receiver?.name || inv.receiver?.adi || inv.customer?.firstName),
                    buyerLastName: s(inv.buyerLastName || inv.aliciSoyadi || inv.receiver?.lastName || inv.receiver?.surname || inv.receiver?.soyadi || inv.customer?.lastName),
                    vknTckn: s(inv.taxOrIdentityNumber || inv.buyerTcknOrVkn || inv.aliciVknTckn || inv.receiver?.vknTckn),
                    payableAmount: payableAmount,
                    itemNames: itemNames,
                    taxableAmount: taxableAmount,
                    currency: inv.currency || inv.paraBirim || 'TRY',
                    approvalStatus: inv.approvalStatus || inv.onayDurumu || 'Taslak',
                    cancellationStatus: (() => {
                        // Check Cross-Reference Metadata with multiple field fallbacks
                        const searchKeys = [
                            (inv.uuid || '').toUpperCase().trim(),
                            (inv.ettn || '').toUpperCase().trim(),
                            (inv.documentNumber || '').toUpperCase().trim(),
                            (inv.belgeNumarasi || '').toUpperCase().trim(),
                            (inv.belgeNo || '').toUpperCase().trim(),
                            (inv.faturaNo || '').toUpperCase().trim(),
                            (inv.faturaUuid || '').toUpperCase().trim()
                        ].filter(k => k && k !== '-' && k.length > 5);

                        for (const key of searchKeys) {
                            if (cancelMap.has(key)) {
                                const req = cancelMap.get(key);
                                const statusUpper = (req.approvalStatus || '').toUpperCase();

                                if (key.length > 10) console.log(`DEBUG: CROSS-REF MATCH for ${key}. ReqStatus: ${req.approvalStatus}`);

                                // If Deleted Draft
                                if (req.requestType === 'silme' || req.requestType === 'deleted') return 'Silinmiş';

                                // If Cancel/Objection Request Approved (fatura-master uyumlu)
                                if (statusUpper.includes('ONAY') || statusUpper.includes('KABUL') || statusUpper.includes('BAŞARI') || statusUpper.includes('İPTAL') || statusUpper.includes('SİLİN')) {
                                    return req.requestType === 'itiraz' ? 'İtiraz Kabul Edildi' : 'İptal Edildi';
                                }
                                // If Pending
                                return req.requestType === 'itiraz' ? 'İtiraz Aşamasında' : 'İptal Talebi Var';
                            }
                        }
                        return null;
                    })(),
                    status: inv.status || 'Draft'
                };
            }));

            console.log('E-Fatura: Mapped invoices count:', mappedInvoices.length);

            return {
                success: true,
                invoices: mappedInvoices
            };

        } catch (error) {
            console.error('E-Fatura Get Invoices Error:', error);
            throw new Error(`Fatura listeleme hatası: ${error.message}`);
        }
    }

    /**
     * Get invoices issued TO the user (Incoming Invoices)
     */
    async getInvoicesIssuedToMe(filter = {}) {
        if (!this.isConnected) {
            await this.connect(this.username, this.password, this.testMode);
        }

        try {
            console.log('E-Fatura: Getting incoming invoices (issued to me)...');

            const filterParams = {};
            const defaultEndDate = new Date();
            const defaultStartDate = new Date();
            defaultStartDate.setMonth(defaultStartDate.getMonth() - 6);

            if (filter.startDate) {
                filterParams.startDate = new Date(filter.startDate);
            } else {
                filterParams.startDate = defaultStartDate;
            }

            if (filter.endDate) {
                filterParams.endDate = new Date(filter.endDate);
            } else {
                filterParams.endDate = defaultEndDate;
            }

            console.log('E-Fatura Incoming Filter:', filterParams);

            let invoices;
            try {
                // Documentation shows this method name for incoming invoices
                invoices = await EInvoice.getBasicInvoicesIssuedToMe(filterParams);
            } catch (err) {
                const errMsg = err.message || '';
                if (errMsg.includes('zaman aşım') || errMsg.includes('oturum') || errMsg.includes('session') || errMsg.includes('token')) {
                    console.warn("E-Fatura: Session timeout, retrying incoming fetch...");
                    await this.connect(this.username, this.password, this.testMode, true);
                    invoices = await EInvoice.getBasicInvoicesIssuedToMe(filterParams);
                } else {
                    throw err;
                }
            }

            console.log(`E-Fatura: Retrieved ${invoices.length} incoming invoices`);

            // Mapped according to the same standard as outgoing for UI compatibility
            const mappedInvoices = invoices.map((inv) => ({
                uuid: inv.uuid,
                documentNumber: inv.documentNumber || inv.belgeNumarasi || inv.belgeNo || inv.uuid,
                date: inv.documentDate || inv.belgeTarihi || inv.date || inv.issueDate,
                senderTitle: inv.titleOrFullName || inv.supplierTitle || inv.saticiUnvan || inv.sender?.title,
                vknTckn: inv.taxOrIdentityNumber || inv.supplierTcknOrVkn || inv.saticiVknTckn,
                payableAmount: inv.payableAmount || inv.odenecekTutar || 0,
                currency: inv.currency || 'TRY',
                approvalStatus: inv.approvalStatus || inv.onayDurumu || 'Onaylandı', // Typically incoming are already approved/sent
                invoiceType: inv.invoiceType || 'SATIS'
            }));

            return {
                success: true,
                invoices: mappedInvoices
            };

        } catch (error) {
            console.error('E-Fatura Get Incoming Invoices Error:', error);
            throw new Error(`Gelen fatura listeleme hatası: ${error.message}`);
        }
    }


    /**
     * Get Invoice HTML with Auto-Retry
     */
    async getInvoiceHTML(uuid, signed = undefined, print = false) {
        if (!this.isConnected) {
            await this.connect(this.username, this.password, this.testMode);
        }

        const tryFetch = async (s) => {
            console.log(`E-Fatura HTML Try: ${uuid}, signed=${s}, print=${print}`);
            return await EInvoice.getInvoiceHtml(uuid, s, print);
        };

        try {
            let html;
            if (signed !== undefined) {
                html = await tryFetch(signed);
            } else {
                try {
                    html = await tryFetch(true);
                } catch (e) {
                    console.warn('HTML fetch as Signed failed, trying as Draft...');
                    html = await tryFetch(false);
                }
            }

            if (!html) throw new Error("HTML verisi boş döndü.");

            // Return HTML exactly as provided by GIB
            return { success: true, html: html };
        } catch (error) {
            console.error('E-Fatura HTML Error:', error);
            throw new Error(`HTML alma hatası: ${error.message}`);
        }
    }

    /**
     * Delete draft invoices
     */
    /**
     * Delete draft invoices
     */
    async deleteInvoice(uuid, reason = 'Hatalı İşlem') {
        if (!this.isConnected) {
            await this.connect(this.username, this.password, this.testMode);
        }

        try {
            console.log(`E-Fatura: Deleting draft invoice ${uuid}...`);

            // 2. Bypass e-fatura library's basicInvoice mapper and use raw GIB structure
            // PHP fatura-master ONLY sends belgeTuru and ettn for deletion. Extra fields crash GIB.
            console.log('E-Fatura: Sending raw delete request to GIB API for:', uuid);

            const payload = {
                silinecekler: [
                    {
                        belgeTuru: 'FATURA',
                        ettn: uuid
                    }
                ],
                aciklama: reason
            };

            require('fs').writeFileSync(require('path').join(__dirname, 'debug_delete_payload.json'), JSON.stringify(payload, null, 2));
            const response = await EInvoice.sendRequest('/earsiv-services/dispatch', {
                cmd: 'EARSIV_PORTAL_FATURA_SIL',
                callid: require('crypto').randomUUID(),
                pageName: 'RG_TASLAKLAR',
                token: EInvoice.getToken(),
                jp: JSON.stringify(payload)
            });

            // GIB normally returns something like "1 fatura başarıyla silindi" or just a text.
            const responseData = response ? response.data : null;
            let success = false;

            if (typeof responseData === 'string' && (responseData.toLowerCase().includes('silin') || responseData.toLowerCase().includes('başarı'))) {
                success = true;
            } else if (responseData === 'OK' || responseData === 1) {
                success = true;
            }
            // Log for debug
            console.log("Delete Response raw:", responseData);

            return {
                success: success,
                message: success ? 'Taslak fatura başarıyla silindi.' : (responseData || 'Taslak fatura silinemedi.'),
                data: responseData
            };
        } catch (error) {
            console.error('E-Fatura Delete Invoice Error:', error.message);
            if (error.response && error.response.data) {
                console.error('RAW GIB RESPONSE DATA:', JSON.stringify(error.response.data, null, 2));
                require('fs').appendFileSync(require('path').join(__dirname, 'debug_delete_error.json'), JSON.stringify(error.response.data, null, 2));
            } else if (error.data) {
                console.error('RAW E-FATURA DATA:', JSON.stringify(error.data, null, 2));
                require('fs').appendFileSync(require('path').join(__dirname, 'debug_delete_error.json'), JSON.stringify(error.data, null, 2));
            }
            throw new Error(`Fatura silme hatası: ${error.message}`);
        }
    }

    /**
     * Get Invoice XML with Auto-Retry
     */
    async getInvoiceXML(uuid, signed = undefined) {
        if (!this.isConnected) {
            await this.connect(this.username, this.password, this.testMode);
        }

        const tryFetch = async (s) => {
            console.log(`E-Fatura XML Try: ${uuid}, signed=${s}`);
            return await EInvoice.getInvoiceXml(uuid, s);
        };

        try {
            let xmlBuffer;
            if (signed !== undefined) {
                xmlBuffer = await tryFetch(signed);
            } else {
                try {
                    xmlBuffer = await tryFetch(true);
                } catch (e) {
                    console.log('XML fetch as Signed failed, trying as Draft...');
                    xmlBuffer = await tryFetch(false);
                }
            }
            return { success: true, xml: xmlBuffer };
        } catch (error) {
            console.error('E-Fatura XML Error:', error);
            throw new Error(`XML alma hatası: ${error.message}`);
        }
    }

    /**
     * Cancel Invoice (Alias for createCancelRequest)
     */
    async cancelInvoice(uuid, reason = 'Hatalı İşlem') {
        return this.createCancelRequest(uuid, reason);
    }

    /**
     * Create Cancel Request (İptal Talebi)
     * Corresponds to the latest e-fatura documentation.
     */
    async createCancelRequest(uuid, reason = 'Hatalı İşlem') {
        if (!this.isConnected) {
            await this.connect(this.username, this.password, this.testMode);
        }

        try {
            console.log(`E-Fatura: Creating Cancel Request for ${uuid}...`);

            // 1. Fetch the full invoice details
            const invoice = await EInvoice.getInvoice(uuid);

            if (!invoice) {
                throw new Error("Fatura bulunamadı.");
            }

            // 2. Map to BasicInvoice interface required by createCancelRequestForInvoice
            // BasicInvoice typically needs: uuid, documentNumber, taxOrIdentityNumber, titleOrFullName, documentDate, documentType, approvalStatus

            // Construct title carefully
            let title = invoice.buyerTitle || '';
            if (invoice.buyerFirstName || invoice.buyerLastName) {
                title = [invoice.buyerFirstName, invoice.buyerLastName].filter(Boolean).join(' ');
            }

            const basicInvoice = {
                uuid: invoice.uuid,
                documentNumber: invoice.documentNumber,
                taxOrIdentityNumber: invoice.taxOrIdentityNumber,
                titleOrFullName: title,
                documentDate: invoice.date,
                documentType: invoice.belgeTuru || invoice.documentType || 'FATURA',
                approvalStatus: invoice.approvalStatus || 'Onaylandı'
            };

            console.log('E-Fatura: Mapping to BasicInvoice for cancellation:', basicInvoice.uuid);

            // 3. Use Library Method
            const result = await EInvoice.createCancelRequestForInvoice(basicInvoice, reason);

            return {
                success: result,
                message: result ? 'İptal talebi başarıyla oluşturuldu.' : 'İptal talebi oluşturulamadı.',
                data: result
            };

        } catch (error) {
            console.error('E-Fatura Create Cancel Request Error:', error);
            throw new Error(`İptal talebi hatası: ${error.message}`);
        }
    }

    /**
     * Create Objection Request (İtiraz Talebi)
     * Corresponds to PHP: $gib->objectionRequest(...)
     */
    async createObjectionRequest(uuid, method, reason) {
        if (!this.isConnected) {
            await this.connect(this.username, this.password, this.testMode);
        }

        try {
            console.log(`E-Fatura: Creating Objection Request for ${uuid}...`);

            // Since e-fatura library does not have a native objectionRequest method in the types we saw,
            // we use the raw dispatch method.

            // 1. Fetch invoice to get details required for objection (belgeNo, date)
            const invoice = await EInvoice.getInvoice(uuid);

            // Map Objection Method (1: Noter, 2: Taahhütlü Mektup, 3: Telgraf, 4: KEP)
            // User might pass string or number.
            const methodMap = {
                'NOTER': 1, '1': 1,
                'MEKTUP': 2, '2': 2,
                'TELGRAF': 3, '3': 3,
                'KEP': 4, '4': 4
            };
            const methodCode = methodMap[String(method).toUpperCase()] || 4; // Default KEP

            // Prepare payload
            const payload = {
                "faturaUuid": invoice.uuid,
                "faturaNo": invoice.documentNumber, // documentId in PHP
                // Date format needed: DD/MM/YYYY presumably? 
                // Invoice date is usually returned as YYYY-MM-DD or similar standard string.
                // We reformat if necessary.
                "faturaTarihi": new Date(invoice.date).toLocaleDateString('tr-TR'),
                "aciklama": reason,
                "yontem": methodCode,
                // Some endpoints require extra fields like "kime": "..." (Sender VKN)
                // But EARSIV_PORTAL_ITIRAZ_TALEBI_OLUSTUR command usually enough with these.
            };

            const response = await EInvoice.sendRequest('/earsiv-services/dispatch', {
                cmd: 'EARSIV_PORTAL_ITIRAZ_TALEBI_OLUSTUR',
                callid: require('crypto').randomUUID(),
                pageName: 'RG_ITIRAZ',
                token: EInvoice.getToken(),
                jp: JSON.stringify(payload)
            });

            console.log('Objection Request Response:', response);

            // Check response
            if (response && response.data === 'OK') { // Check what actual success looks like
                // Usually returns "İşlem Başarılı" or similar in data string or object
                return { success: true, message: 'İtiraz talebi oluşturuldu.' };
            }
            // If data is object with status?
            if (response && response.data && typeof response.data === 'object') {
                return { success: true, message: 'İtiraz talebi oluşturuldu.', data: response.data };
            }

            // If unknown response but no error thrown
            return { success: true, message: 'İşlem tamamlandı (Yanıt: ' + JSON.stringify(response.data) + ')' };

        } catch (error) {
            console.error('Error creating objection request:', error);
            throw new Error(`İtiraz talebi hatası: ${error.message}`);
        }
    }

    async getInvoicesIssuedToMe(startDate, endDate) {
        if (!this.isConnected) {
            await this.connect(this.username, this.password, this.testMode);
        }

        try {
            console.log("E-Fatura: Fetching Invoices Issued To Me...");

            // Format dates
            const start = startDate ? new Date(startDate) : new Date(new Date().setMonth(new Date().getMonth() - 1));
            const end = endDate ? new Date(endDate) : new Date();

            const invoices = await EInvoice.getBasicInvoicesIssuedToMe({
                startDate: start,
                endDate: end
            });

            console.log(`E-Fatura: Retrieved ${invoices.length} invoices issued to me.`);

            return {
                success: true,
                invoices: invoices.map(inv => ({
                    uuid: inv.uuid,
                    documentNumber: inv.belgeNumarasi || inv.documentNumber || inv.belgeNo || inv.uuid,
                    date: inv.belgeTarihi || inv.documentDate || inv.date || inv.issueDate,
                    time: inv.time || inv.issueTime,
                    // Sender becomes the 'buyer' in the view for consistent table display
                    buyerTitle: inv.gonderenUnvan || inv.saticiUnvanAdSoyad || inv.sender?.title || 'Bilinmeyen Gönderen',
                    buyerFirstName: '',
                    buyerLastName: '',
                    vknTckn: inv.gonderenVknTckn || inv.sender?.vknTckn || '',
                    payableAmount: parseFloat(inv.payableAmount || inv.odenecekTutar || inv.totalAmount || 0),
                    currency: inv.currency || inv.paraBirim || 'TRY',
                    approvalStatus: inv.onayDurumu || inv.approvalStatus || 'Onaylı',
                    status: 'Gelen',
                    type: 'incoming',
                    direction: 'incoming'
                }))
            };

        } catch (error) {
            console.error('E-Fatura Get Invoices To Me Error:', error);
            // Don't crash, return empty list if failed (e.g. not supported in test mode sometimes)
            return {
                success: true,
                invoices: [],
                error: error.message
            };
        }
    }

    // Alias for index.js calls
    async getInvoicesToMe(startDate, endDate) {
        return this.getInvoicesIssuedToMe(startDate, endDate);
    }

    /**
     * Logout from GIB Portal
     */
    async logout() {
        if (this.isConnected) {
            try {
                console.log('E-Fatura: Logging out...');
                await EInvoice.logout();
                this.isConnected = false;
                console.log('E-Fatura: Logged out successfully');
            } catch (error) {
                console.warn('E-Fatura Logout Error:', error.message);
            }
        }
    }

    async disconnect() {
        return this.logout();
    }

    /**
     * Get CANCEL/OBJECTION Requests (Incoming & Outgoing)
     * Queries explicitly for:
     * - Incoming Cancel Requests (Gelen İptal Talepleri)
     * - Outgoing Cancel Requests (İlettiğim İptal Talepleri)
     * - Incoming Objection Requests (Gelen İtiraz Talepleri)
     * - Outgoing Objection Requests (İlettiğim İtiraz Talepleri)
     */
    async getRequests(startDate, endDate) {
        if (!this.isConnected) {
            await this.connect(this.username, this.password, this.testMode);
        }

        try {
            console.log("E-Fatura: Fetching Cancel/Objection Requests...");

            // Helper for Safe String
            const s = (val) => val || '';

            // Date Format Helper (DD/MM/YYYY)
            const formatDate = (date) => {
                if (!date) return '';
                const d = new Date(date);
                return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
            };

            const startStr = startDate ? formatDate(startDate) : formatDate(new Date(new Date().setMonth(new Date().getMonth() - 1)));
            const endStr = endDate ? formatDate(endDate) : formatDate(new Date());

            const commonParams = {
                baslangic: startStr,
                bitis: endStr,
                table: []
            };
            // Status Mapping Helper
            const mapStatus = (status) => {
                // Common GIB Statuses: 0=Bekliyor, 1=Kabul/Onay, 2=Red, 3=Hata/İptal
                // Also string statuses like 'ONAYLANDI', 'REDDEDİLDİ', 'KABUL EDİLDİ'
                if (status === null || status === undefined) return 'BEKLİYOR'; // Default to Pending if unknown

                const s = String(status).toUpperCase();

                // Approved / Accepted
                if (['1', 'KABUL', 'KABUL EDİLDİ', 'ONAYLANDI', 'ONAY'].includes(s)) return 'KABUL';

                // Rejected
                if (['2', 'RED', 'REDDEDİLDİ'].includes(s)) return 'RED';

                // Cancelled / Error / Deleted
                if (['3', 'İPTAL', 'HATA'].includes(s)) return 'İPTAL';
                if (['SİLİNMİŞ', 'SİLİNEN'].includes(s)) return 'SİLİNMİŞ';

                // Pending (Default for 0 or unknown non-error strings)
                if (['0', 'BEKLIYOR', 'BEKLİYOR'].includes(s)) return 'BEKLİYOR';

                // If it's a string we don't recognize but looks like a status, return it as is (or map to BEKLİYOR?)
                // Let's return it uppercased to be safe, or default to BEKLİYOR if it looks numeric 0
                return s === '0' ? 'BEKLİYOR' : s;
            };

            // Helper to try fetch with fallbacks
            const tryFetch = async (cmd, defaultPageName, label, direction) => {
                // Expanded pageNames based on fatura-master and common practices
                const pageNames = [defaultPageName, 'RG_IPTALITIRAZTASLAKLAR', 'RG_BASITARAC', 'RG_BASITFATURA', 'RG_TASLAKLAR', 'RG_IPTAL_FATURALAR'];

                for (const pageName of pageNames) {
                    try {
                        console.log(`Fetching ${label} using ${cmd} on ${pageName}...`);
                        const data = await EInvoice.sendRequest('/earsiv-services/dispatch', {
                            cmd: cmd,
                            callid: require('crypto').randomUUID(),
                            pageName: pageName,
                            token: EInvoice.getToken(),
                            jp: JSON.stringify(commonParams)
                        });

                        if (data && Array.isArray(data.data)) {
                            console.log(`Success: Fetched ${data.data.length} ${label} using ${pageName}`);
                            return data.data.map(item => ({
                                ...item,
                                type: label,
                                direction: direction,
                                approvalStatus: mapStatus(item.durum)
                            }));
                        }
                    } catch (e) {
                        // Silent fail
                    }
                }
                return [];
            };

            const requests = [];

            // 1. Incoming Requests (Cancel + Objection)
            const incomingUnified = await tryFetch('EARSIV_PORTAL_GELEN_IPTAL_ITIRAZ_TALEPLERINI_GETIR', 'RG_IPTALITIRAZTASLAKLAR', 'Gelen İptal/İtiraz Talebi', 'incoming');
            requests.push(...incomingUnified);

            // 2. Outgoing Requests (Cancel + Objection)
            // Use a Set to avoid duplicates if multiple strategies return the same data
            const outgoingMap = new Map();

            const outgoingStrategies = [
                { cmd: 'EARSIV_PORTAL_GIDEN_IPTAL_ITIRAZ_TALEPLERINI_GETIR', page: 'RG_IPTALITIRAZTASLAKLAR' },
                { cmd: 'EARSIV_PORTAL_GIDEN_IPTAL_ITIRAZ_TALEPLERINI_GETIR', page: 'RG_GIDENIPTALITIRAZ' },
                { cmd: 'EARSIV_PORTAL_ILETTIGIM_IPTAL_ITIRAZ_TALEPLERINI_GETIR', page: 'RG_IPTALITIRAZTASLAKLAR' },
                { cmd: 'EARSIV_PORTAL_GENEL_IPTAL_ITIRAZ_TALEPLERINI_GETIR', page: 'RG_IPTALITIRAZTASLAKLAR' },
                // Fallbacks from fatura-master
                { cmd: 'EARSIV_PORTAL_ILETTIGIM_IPTAL_ITIRAZ_TALEPLERINI_GETIR', page: 'RG_IPTALITIRAZTASLAKLAR' }, // Repeated but safe
                { cmd: 'EARSIV_PORTAL_ILETILEN_IPTAL_ITIRAZ_TALEPLERINI_GETIR', page: 'RG_IPTALITIRAZTASLAKLAR' }
            ];

            for (const strategy of outgoingStrategies) {
                const results = await tryFetch(strategy.cmd, strategy.page, 'Giden İptal/İtiraz Talebi', 'outgoing');
                if (results.length > 0) {
                    console.log(`E-Fatura: Found ${results.length} outgoing requests via ${strategy.cmd} / ${strategy.page}`);
                    results.forEach(item => {
                        // Dedup by UUID if available, otherwise by DocNo
                        const key = item.uuid || item.documentNumber || JSON.stringify(item);
                        if (!outgoingMap.has(key)) {
                            outgoingMap.set(key, item);
                        }
                    });
                }
            }

            requests.push(...Array.from(outgoingMap.values()));

            // Fallback for older systems/endpoints if unified returns nothing
            if (requests.length === 0) {
                // 3. Incoming Cancel Requests (Old)
                const incomingCancels = await tryFetch('EARSIV_PORTAL_GELEN_IPTAL_TALEPLERI_GETIR', 'RG_IPTAL', 'Gelen İptal Talebi', 'incoming');
                requests.push(...incomingCancels);

                // 4. Outgoing Cancel Requests (Old)
                const outgoingCancels = await tryFetch('EARSIV_PORTAL_ILETTIGIM_IPTAL_TALEPLERI_GETIR', 'RG_IPTAL', 'İlettiğim İptal Talebi', 'outgoing');
                requests.push(...outgoingCancels);
            }

            // 5. ALSO FETCH DELETED INVOICES (Drafts that were cancelled/deleted)
            try {
                console.log("Fetching Deleted Invoices...");
                const deletedInvoices = await EInvoice.getBasicInvoices({
                    startDate: new Date(startDate || new Date().setMonth(new Date().getMonth() - 1)),
                    endDate: new Date(endDate || new Date()),
                    approvalStatus: 'Silinmiş'
                });
                if (deletedInvoices && deletedInvoices.length > 0) {
                    console.log(`Found ${deletedInvoices.length} deleted invoices.`);
                    const deletedMapped = deletedInvoices.map(inv => ({
                        ...inv,
                        type: 'Silinmiş Fatura',
                        direction: 'outgoing', // Deleted drafts are outgoing
                        requestType: 'deleted' // Marker
                    }));
                    requests.push(...deletedMapped);
                }
            } catch (delErr) {
                console.warn("Failed to fetch deleted invoices:", delErr.message);
            }


            console.log(`E-Fatura: Retrieved ${requests.length} total requests.`);

            const myVkn = s(this.username);

            // Plan: To ensure "Muhatap" is the Alıcı, we fetch our own outgoing invoices 
            // and create a lookup map (UUID -> Buyer Title).
            const invoiceLookup = new Map();
            try {
                const outgoingInvoices = await this.getInvoices({
                    startDate: startDate,
                    endDate: endDate,
                    direction: 'outgoing'
                }, true); // Important: pass skipRequests=true to PREVENT INFINITE RECURSION
                if (outgoingInvoices && Array.isArray(outgoingInvoices)) {
                    outgoingInvoices.forEach(inv => {
                        const title = inv.buyerTitle || (inv.buyerFirstName ? `${inv.buyerFirstName} ${inv.buyerLastName || ''}`.trim() : '');
                        if (inv.uuid) invoiceLookup.set(String(inv.uuid).toUpperCase(), title);
                        if (inv.documentNumber && inv.documentNumber !== '-') invoiceLookup.set(String(inv.documentNumber).toUpperCase(), title);
                    });
                }
            } catch (err) {
                console.warn("E-Fatura: Failed to fetch outgoing invoices for cross-reference:", err.message);
            }

            // Map to unified structure
            const mappedRequests = requests.map(req => {
                const rawUuid = req.faturaUuid || req.faturaEttn || req.faturaETTN || req.FaturaEttn || req.ettn || req.uuid;
                const cleanUuid = rawUuid ? String(rawUuid).toUpperCase() : null;
                const docNo = req.belgeNumarasi || req.belgeNo || req.faturaNo;
                const cleanDocNo = docNo ? String(docNo).toUpperCase() : null;

                // Priority 1: Check our lookup map for a verified buyer title
                let verifiedBuyerTitle = null;
                if (cleanUuid && invoiceLookup.has(cleanUuid)) verifiedBuyerTitle = invoiceLookup.get(cleanUuid);
                else if (cleanDocNo && invoiceLookup.has(cleanDocNo)) verifiedBuyerTitle = invoiceLookup.get(cleanDocNo);

                // Priority 2: Determine the "Other Party" from raw GIB fields if lookup fails
                let otherPartyTitle = verifiedBuyerTitle;
                if (!otherPartyTitle) {
                    const aliciVkn = s(req.aliciVknTckn || req.muhatapVknTckn || req.aliciVkn);
                    const saticiVkn = s(req.saticiVknTckn || req.saticiVkn);
                    const gonderenVkn = s(req.gonderenVknTckn);

                    if (aliciVkn && aliciVkn !== myVkn) {
                        otherPartyTitle = req.aliciUnvanAdSoyad || req.aliciUnvan || req.muhatapUnvanAdSoyad;
                    } else if (saticiVkn && saticiVkn !== myVkn) {
                        otherPartyTitle = req.saticiUnvanAdSoyad || req.saticiUnvan;
                    } else if (gonderenVkn && gonderenVkn !== myVkn) {
                        otherPartyTitle = req.gonderenUnvanAdSoyad;
                    }

                    // Priority 3: Direction-based fallback
                    if (!otherPartyTitle) {
                        if (req.direction === 'incoming') {
                            otherPartyTitle = req.gonderenUnvanAdSoyad || req.saticiUnvanAdSoyad || req.aliciUnvanAdSoyad;
                        } else {
                            otherPartyTitle = req.aliciUnvanAdSoyad || req.muhatapUnvanAdSoyad || req.saticiUnvanAdSoyad;
                        }
                    }
                }

                const finalTitle = s(otherPartyTitle || 'Bilinmeyen Muhatap');

                // Determine Request Type
                let rType = 'iptal';
                if (req.type && req.type.toLowerCase().includes('itiraz')) rType = 'itiraz';
                if (req.requestType === 'deleted') rType = 'silme'; // Deleted Draft

                return {
                    uuid: rawUuid,
                    documentNumber: req.belgeNumarasi || req.belgeNo || req.faturaNo || req.documentNumber || '-',
                    date: req.talepTarihi || req.date || req.documentDate,
                    requestDate: req.talepTarihi || req.date || req.documentDate,
                    requestType: rType,

                    buyerTitle: finalTitle,
                    receiverTitle: finalTitle, // Add as alias for frontend convenience
                    buyerFirstName: '',
                    buyerLastName: '',
                    vknTckn: s(req.gonderenVknTckn || req.aliciVknTckn || req.izleyenVknTckn || req.muhatapVknTckn),

                    payableAmount: parseFloat(req.tutar || req.payableAmount || req.odenecekTutar || 0),
                    currency: 'TRY',

                    approvalStatus: req.onayDurumu || req.status || 'Bekliyor',
                    reason: req.talepAciklama || req.aciklama || req.reason || '',
                    statusReason: req.talepAciklama || req.aciklama || req.reason || '',

                    direction: req.direction,
                    raw: req
                };
            });

            return { success: true, invoices: mappedRequests };

        } catch (error) {
            console.error('E-Fatura Get Requests Error:', error);
            return {
                success: false,
                error: error.message,
                invoices: []
            };
        }
    }

    /**
     * Create a Cancellation Request (İptal Talebi)
     * @param {string} uuid - Invoice ETTV/UUID
     * @param {string} reason - Cancellation reason
     */
    async createCancellationRequest(uuid, reason) {
        if (!this.isConnected) {
            await this.connect(this.username, this.password, this.testMode);
        }

        try {
            console.log(`E-Fatura: Creating Cancellation Request for ${uuid}...`);
            // Endpoint: /earsiv-services/dispatch
            // Command: EARSIV_PORTAL_IPTAL_TALEBI_OLUSTUR
            // PageName: RG_TASLAKLAR (or RG_IPTAL?) -> usually RG_TASLAKLAR for actions on existing docs

            const command = 'EARSIV_PORTAL_IPTAL_TALEBI_OLUSTUR';
            const pageName = 'RG_TASLAKLAR';
            // fatura-master: onayDurumu => 'İptal' (Gib.php cancellationRequest)
            const payload = {
                ettn: uuid,
                onayDurumu: 'İptal',
                belgeTuru: 'FATURA',
                talepAciklama: reason
            };

            const response = await EInvoice.sendRequest('/earsiv-services/dispatch', {
                cmd: command,
                callid: require('crypto').randomUUID(),
                pageName: pageName,
                token: EInvoice.getToken(),
                jp: JSON.stringify(payload)
            });

            console.log('Cancellation Response:', response);

            if (response && response.data) {
                // Check success msg
                // GIB usually returns "İşlem Başarıyla Gerçekleşti" or similar in data
                return { success: true, data: response.data };
            } else {
                throw new Error("GİB'den beklenen yanıt alınamadı.");
            }

        } catch (error) {
            console.error('Create Cancellation Request Error:', error);
            throw error;
        }
    }

    /**
     * Create an Objection Request (İtiraz Talebi)
     * @param {object} params
     * @param {string} params.uuid - Invoice UUID
     * @param {string} params.method - Objection Method (KEP, NOTER, TAAHHUTLU, TEL, DIGER)
     * @param {string} params.explanation - Reason
     * @param {string} params.docIds - Optional extra IDs (referansBelgeId)
     * @param {string} params.docDate - Optional extra date (referansBelgeTarihi)
     */
    async createObjectionRequest({ uuid, method, explanation, docId, docDate }) {
        if (!this.isConnected) {
            await this.connect(this.username, this.password, this.testMode);
        }

        try {
            console.log(`E-Fatura: Creating Objection Request for ${uuid}...`);

            // fatura-master ObjectionMethod enum: NOTER, TAAHHUTLU_MEKTUP, TELGRAF, KEP
            const methodMap = {
                'KEP': 'KEP',
                'NOTER': 'NOTER',
                'TAAHHUTLU': 'TAAHHUTLU_MEKTUP',
                'TAAHHUTLU_MEKTUP': 'TAAHHUTLU_MEKTUP',
                'TEL': 'TELGRAF',
                'TELGRAF': 'TELGRAF',
                'DIGER': 'KEP' // Varsayılan
            };
            const methodVal = methodMap[method] || 'KEP';

            const command = 'EARSIV_PORTAL_ITIRAZ_TALEBI_OLUSTUR';
            const pageName = 'RG_TASLAKLAR';
            // fatura-master: onayDurumu => 'Onaylandı' (Gib.php objectionRequest)
            const payload = {
                ettn: uuid,
                onayDurumu: 'Onaylandı',
                belgeTuru: 'FATURA',
                itirazYontemi: methodVal,
                talepAciklama: explanation,
                referansBelgeId: docId || '',
                referansBelgeTarihi: docDate || '' // Format DD/MM/YYYY
            };

            const response = await EInvoice.sendRequest('/earsiv-services/dispatch', {
                cmd: command,
                callid: require('crypto').randomUUID(),
                pageName: pageName,
                token: EInvoice.getToken(),
                jp: JSON.stringify(payload)
            });

            console.log('Objection Response:', response);

            if (response && response.data) {
                return { success: true, data: response.data };
            } else {
                throw new Error("GİB'den beklenen yanıt alınamadı.");
            }

        } catch (error) {
            console.error('Create Objection Request Error:', error);
            throw error;
        }
    }

    /**
     * Get Registered Phone Number from GIB
     */
    async getPhoneNumber() {
        // Ensure connection
        if (!this.isConnected) {
            // We can't await here easily without making this async, but this method IS async
            // actually it's called from other async methods usually
            // But for safety, let's assume caller handles connect or we do it if needed
        }

        try {
            console.log('E-Fatura: Fetching registered phone number...');
            const response = await EInvoice.sendRequest('/earsiv-services/dispatch', {
                cmd: 'EARSIV_PORTAL_TELEFONNO_SORGULA',
                callid: require('crypto').randomUUID(),
                pageName: 'RG_BASITTASLAKLAR',
                token: EInvoice.getToken(),
                jp: JSON.stringify({})
            });

            console.log('Get Phone Number Response:', response);

            if (response && response.data && response.data.telefon) {
                return response.data.telefon;
            }
            return null;

        } catch (error) {
            console.error('E-Fatura Get Phone Error:', error);
            // Don't throw, just return null so we can handle gracefully
            return null;
        }
    }

    /**
     * Send SMS Code for signing
     * Returns { oid, phoneNumber }
     */
    async sendSMSCode() {
        if (!this.isConnected) {
            await this.connect(this.username, this.password, this.testMode);
        }

        try {
            console.log('E-Fatura: Sending SMS Code...');

            // 1. Get Phone Number first
            const phoneNumber = await this.getPhoneNumber();

            if (!phoneNumber) {
                throw new Error("Sistemde kayıtlı telefon numarası bulunamadı.");
            }

            console.log(`E-Fatura: Found phone number ${phoneNumber}, requesting SMS...`);

            // 2. Request SMS
            // EARSIV_PORTAL_SMSSIFRE_GONDER
            // Payload: { "CEPTEL": "532xxxxxxx", "KCEPTEL": false, "TIP": "" }

            const payload = {
                "CEPTEL": phoneNumber,
                "KCEPTEL": false,
                "TIP": ""
            };

            const response = await EInvoice.sendRequest('/earsiv-services/dispatch', {
                cmd: 'EARSIV_PORTAL_SMSSIFRE_GONDER',
                callid: require('crypto').randomUUID(),
                pageName: 'RG_SMSONAY',
                token: EInvoice.getToken(),
                jp: JSON.stringify(payload)
            });

            console.log('Send SMS Response:', response);

            if (response && response.data && response.data.oid) {
                return {
                    success: true,
                    oid: response.data.oid,
                    phoneNumber: phoneNumber,
                    message: `SMS şifresi ${phoneNumber} nolu telefona gönderildi.`
                };
            }

            throw new Error("SMS gönderimi başarısız oldu (OID alınamadı).");

        } catch (error) {
            console.error('E-Fatura Send SMS Error:', error);
            throw new Error(`SMS gönderme hatası: ${error.message}`);
        }
    }


    /**
     * Sign Invoices
     * @param {string} code SMS confirmation code
     * @param {string} oid Operation ID from sendSMSCode
     * @param {string|string[]} uuid Invoice UUID(s) to sign
     */
    async signInvoices(code, oid, uuid) {
        if (!this.isConnected) {
            await this.connect(this.username, this.password, this.testMode);
        }

        try {
            console.log(`E-Fatura: Signing invoice(s) ${uuid}...`);

            // Normalize uuid to array
            const uuids = Array.isArray(uuid) ? uuid : [uuid];

            // 1. Prepare DATA payload (list of documents)
            // [{ "belgeTuru": "FATURA", "ettn": "UUID..." }]
            const documentList = uuids.map(id => ({
                "belgeTuru": "FATURA",
                "ettn": id
            }));

            // 2. Prepare Command Payload
            // { "DATA": [...], "SIFRE": "123456", "OID": "...", "OPR": 1 }
            // OPR: 1 seems to be constant for signing in fatura-master

            const payload = {
                "DATA": documentList,
                "SIFRE": code,
                "OID": oid,
                "OPR": 1
            };

            // Command: 0lhozfib5410mp (This is indeed the obfuscated command name generic to GIB)
            // PageName: RG_SMSONAY

            const response = await EInvoice.sendRequest('/earsiv-services/dispatch', {
                cmd: '0lhozfib5410mp',
                callid: require('crypto').randomUUID(),
                pageName: 'RG_SMSONAY',
                token: EInvoice.getToken(),
                jp: JSON.stringify(payload)
            });

            console.log('Sign Invoice Response:', response);

            // Check response
            if (response && response.data && response.data.sonuc === '1') {
                return {
                    success: true,
                    message: 'Fatura başarıyla imzalandı.'
                };
            }

            // If failed
            const errorMsg = response?.data?.mesaj || 'İmzalama başarısız oldu.';
            throw new Error(errorMsg);

        } catch (error) {
            console.error('E-Fatura Sign Error:', error);
            throw new Error(`İmzalama hatası: ${error.message}`);
        }
    }

    async updateDraftInvoice(uuid, invoiceData) {
        if (!this.isConnected) {
            await this.connect(this.username, this.password, this.testMode);
        }

        try {
            console.log(`E-Fatura: Updating draft invoice ${uuid}...`);
            // Prepare clean payload for library's deepMerge
            const updatePayload = this._prepareInvoicePayload(invoiceData, uuid);

            // Reverting to official updateDraftInvoice. 
            // Although deepMerge is buggy for deletions, createDraftInvoice(sameUuid) 
            // is often rejected by GIB Production with "Duplicate ETTN".
            const result = await EInvoice.updateDraftInvoice(uuid, updatePayload);

            return {
                success: true,
                message: 'Fatura başarıyla güncellendi.',
                data: result
            };
        } catch (error) {
            console.error('E-Fatura Update ERROR:', error.message);
            // Log the raw data from library if available - this is critical for diagnosing GIB field errors
            if (error.data) {
                console.error('GIB Response Data:', JSON.stringify(error.data, null, 2));
            }
            throw new Error(`Güncelleme hatası: ${error.message}`);
        }
    }
    async respondToCancellationRequest(uuid, action, reason) {
        if (!this.isConnected) { await this.connect(this.username, this.password, this.testMode); }

        // GİB Commands for Cancel Approval/Rejection
        const cmd = action === 'accept' ? 'EARSIV_PORTAL_GELEN_IPTAL_TALEBI_ONAYLA' : 'EARSIV_PORTAL_GELEN_IPTAL_TALEBI_REDDET';
        const statusText = action === 'accept' ? 'Onaylandı' : 'Reddedildi';

        console.log(`E-Fatura: Responding to Cancellation Request ${uuid} with ${action}...`);

        const response = await EInvoice.sendRequest('/earsiv-services/dispatch', {
            cmd: cmd,
            callid: require('crypto').randomUUID(),
            pageName: 'RG_IPTALITIRAZTASLAKLAR',
            token: EInvoice.getToken(),
            jp: JSON.stringify({ ettn: uuid, aciklama: reason || statusText })
        });

        console.log('Cancellation Response:', response);
        if (response && response.data) return { success: true, data: response.data };
        throw new Error("GİB'den beklenen yanıt alınamadı.");
    }

    async respondToObjectionRequest(uuid, action, reason) {
        if (!this.isConnected) { await this.connect(this.username, this.password, this.testMode); }

        // GİB Commands for Objection Approval/Rejection
        const cmd = action === 'accept' ? 'EARSIV_PORTAL_GELEN_ITIRAZ_TALEBI_ONAYLA' : 'EARSIV_PORTAL_GELEN_ITIRAZ_TALEBI_REDDET';
        const statusText = action === 'accept' ? 'Onaylandı' : 'Reddedildi';

        console.log(`E-Fatura: Responding to Objection Request ${uuid} with ${action}...`);

        const response = await EInvoice.sendRequest('/earsiv-services/dispatch', {
            cmd: cmd,
            callid: require('crypto').randomUUID(),
            pageName: 'RG_IPTALITIRAZTASLAKLAR',
            token: EInvoice.getToken(),
            jp: JSON.stringify({ ettn: uuid, aciklama: reason || statusText })
        });

        console.log('Objection Response:', response);
        if (response && response.data) return { success: true, data: response.data };
        throw new Error("GİB'den beklenen yanıt alınamadı.");
    }
}

module.exports = EFaturaService;
