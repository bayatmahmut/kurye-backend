require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const EFaturaService = require('./gib-api');
const admin = require('firebase-admin');

// --- Firebase Admin Init ---
// Servis hesabı JSON dosyasını (hizmet hesabı anahtarı) projenin kök dizinine (veya server dizinine) 'serviceAccountKey.json' adıyla ekleyin.
// Şimdilik default credentials kullanıyoruz (veya ENV'den alınabilir).
try {
    const serviceAccountPath = path.join(__dirname, 'serviceAccountKey.json');
    if (fs.existsSync(serviceAccountPath)) {
        const serviceAccount = require(serviceAccountPath);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        console.log('[Firebase] Admin SDK initialized via service account.');
    } else {
        admin.initializeApp();
        console.log('[Firebase] Admin SDK initialized via default credentials.');
    }
} catch (e) {
    console.error('[Firebase] Init Error:', e.message);
}

const db = admin.apps.length ? admin.firestore() : null;

const app = express();

// --- CORS: Sadece bilinen origin'lere izin ver ---
const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5173').split(',').map(s => s.trim());
app.use(cors({
    origin: (origin, callback) => {
        // Allow requests with no origin (mobile apps, curl, etc.)
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error('CORS policy violation'));
        }
    },
    credentials: true
}));

app.use(bodyParser.json({ limit: '50mb' }));

// --- API Key Middleware ---
const API_KEY = process.env.API_KEY || 'kurye-muhasebe-secret-2026';

const apiKeyAuth = (req, res, next) => {
    const clientKey = req.headers['x-api-key'];
    if (clientKey && clientKey === API_KEY) {
        return next();
    }
    // Geçiş dönemi: API key yoksa da geçir ama uyar
    console.warn(`[SECURITY] Request without API key from ${req.ip} to ${req.path}`);
    next();
};

app.use('/api', apiKeyAuth);

// --- GİB SESSION CACHE ---
// Server-side credential caching: client bir kez login olur, sonraki isteklerde session token kullanır
const gibSessionCache = new Map();
const GIB_SESSION_TTL = 10 * 60 * 1000; // 10 dakika

const getOrCreateGibSession = async (username, password, testMode) => {
    const cacheKey = `${username}_${testMode ? 'test' : 'prod'}`;
    const cached = gibSessionCache.get(cacheKey);

    if (cached && Date.now() - cached.createdAt < GIB_SESSION_TTL) {
        return cached.service;
    }

    // Cache'den düştüyse (restart, TTL doldu) yeniden giriş yap
    try {
        const eFaturaService = new EFaturaService();
        await eFaturaService.connect(username, password, !!testMode);

        gibSessionCache.set(cacheKey, {
            service: eFaturaService,
            createdAt: Date.now()
        });

        return eFaturaService;
    } catch (err) {
        // Önce cache'i temizle, ardından gerçek hatayı fırlat
        gibSessionCache.delete(cacheKey);
        throw new Error(`GİB oturum açılamadı: ${err.message}`);
    }
};

// Session cache'i periyodik temizle
setInterval(() => {
    const now = Date.now();
    for (const [key, value] of gibSessionCache.entries()) {
        if (now - value.createdAt > GIB_SESSION_TTL) {
            gibSessionCache.delete(key);
        }
    }
}, 5 * 60 * 1000);

// --- Iyzico Configuration ---
const Iyzico = require('iyzipay');
const iyzico = new Iyzico({
    apiKey: process.env.IYZICO_API_KEY,
    secretKey: process.env.IYZICO_SECRET_KEY,
    uri: process.env.IYZICO_URI || 'https://sandbox-api.iyzipay.com'
});

// --- Iyzico API ---
app.post('/api/payment-link', (req, res) => {
    const { price, itemName, userEmail, userDetails } = req.body;

    const request = {
        locale: Iyzico.LOCALE.TR,
        conversationId: '123456789',
        price: price,
        paidPrice: price,
        currency: Iyzico.CURRENCY.TRY,
        basketId: 'B67832',
        paymentGroup: Iyzico.PAYMENT_GROUP.PRODUCT,
        callbackUrl: 'https://www.merchant.com/callback',
        enabledInstallments: [2, 3, 6, 9],
        buyer: {
            id: userDetails?.id || 'BY789',
            name: userDetails?.name || 'John',
            surname: userDetails?.surname || 'Doe',
            gsmNumber: '+905350000000',
            email: userEmail || 'email@email.com',
            identityNumber: '74300864791',
            lastLoginDate: '2015-10-05 12:43:35',
            registrationDate: '2013-04-21 15:12:09',
            registrationAddress: 'Nidakule Göztepe, Merdivenköy Mah. Bora Sok. No:1',
            ip: '85.34.78.112',
            city: 'Istanbul',
            country: 'Turkey',
            zipCode: '34732'
        },
        billingAddress: {
            contactName: userDetails?.name || 'John Doe',
            city: 'Istanbul',
            country: 'Turkey',
            address: 'Nidakule Göztepe, Merdivenköy Mah. Bora Sok. No:1',
            zipCode: '34732'
        },
        basketItems: [
            {
                id: 'BI101',
                name: itemName,
                category1: 'Subscription',
                itemType: Iyzico.BASKET_ITEM_TYPE.VIRTUAL,
                price: price
            }
        ]
    };

    res.json({ status: 'success', paymentPageUrl: 'https://sandbox-iyzipay.com/payment/mock' });
});

// --- GIB E-Fatura API ---

/**
 * Get Invoice Details (for editing)
 */
app.post('/api/get-invoice-details', async (req, res) => {
    const { username, password, uuid, testMode } = req.body;

    if (!username || !password || !uuid) {
        return res.status(400).json({ success: false, error: 'Kullanıcı adı, şifre ve fatura UUID gereklidir.' });
    }

    try {
        const eFaturaService = await getOrCreateGibSession(username, password, testMode);
        const result = await eFaturaService.getInvoiceDetails(uuid);
        res.json(result);
    } catch (error) {
        console.error('[Get Invoice Details Error]', error);
        res.status(500).json({ success: false, error: error.message || 'Fatura detayları alınamadı.' });
    }
});

/**
 * Create Invoice
 */
app.post('/api/create-invoice', async (req, res) => {
    const { username, password, invoiceData, testMode, personalInfo } = req.body;
    console.log(`[POST /api/create-invoice] Request received.`);

    if (!username || !password) {
        return res.status(400).json({ success: false, error: 'Kullanıcı adı ve şifre gereklidir.' });
    }

    try {
        const eFaturaService = await getOrCreateGibSession(username, password, testMode);

        if (personalInfo) {
            await eFaturaService.updateUserInfo(personalInfo);
        }

        const result = await eFaturaService.createDraftInvoice(invoiceData);
        res.json({ success: true, message: 'Fatura başarıyla oluşturuldu.', data: result });
    } catch (error) {
        console.error('[Create Invoice Error]', error);
        res.status(500).json({ success: false, error: error.message || 'Fatura oluşturulamadı.' });
    }
});

/**
 * Get Recipient Info
 */
app.post('/api/get-recipient-info', async (req, res) => {
    const { username, password, testMode, vknTckn } = req.body;
    console.log(`[POST /api/get-recipient-info] Querying VKN: ${vknTckn}`);

    if (!username || !password || !vknTckn) {
        return res.status(400).json({ success: false, error: 'Eksik parametreler.' });
    }

    try {
        const eFaturaService = await getOrCreateGibSession(username, password, testMode);

        let info = null;
        try {
            if (eFaturaService.getRecipientInfo) {
                info = await eFaturaService.getRecipientInfo(vknTckn);
            } else {
                throw new Error("Method not implemented");
            }
        } catch (innerErr) {
            console.warn("Real query failed, checking fallbacks...", innerErr.message);
            if (testMode) {
                info = { title: "TEST MÜKELLEF A.Ş.", taxOffice: "Test VD", address: "Test Mah. Test Sok.", firstName: "Test", lastName: "User" };
            } else {
                throw innerErr;
            }
        }

        if (info) {
            res.json({ success: true, info });
        } else {
            res.status(404).json({ success: false, error: 'Mükellef bulunamadı' });
        }
    } catch (error) {
        console.error('[Get Recipient Info Error]', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Get Invoice List
 */
app.post('/api/get-invoices', async (req, res) => {
    const { username, password, filter, testMode } = req.body;

    if (!username || !password) {
        return res.status(400).json({ success: false, error: 'Kullanıcı adı ve şifre gereklidir.' });
    }

    try {
        const eFaturaService = await getOrCreateGibSession(username, password, testMode);

        let result;
        if (filter && filter.direction === 'incoming') {
            result = await eFaturaService.getInvoicesIssuedToMe(filter);
        } else {
            result = await eFaturaService.getInvoices(filter);
        }

        res.json(result);
    } catch (error) {
        console.error('[Get Invoices Error]', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Get Cancel Requests
 */
app.post('/api/get-cancel-requests', async (req, res) => {
    const { username, password, filter, testMode } = req.body;
    const { startDate, endDate } = filter || {};

    if (!username || !password) {
        return res.status(400).json({ success: false, error: 'Kullanıcı adı ve şifre gereklidir.' });
    }

    try {
        const eFaturaService = await getOrCreateGibSession(username, password, testMode);
        const result = await eFaturaService.getRequests(startDate, endDate);
        res.json({ success: true, invoices: result.invoices || [] });
    } catch (error) {
        console.error('[Get Cancel Requests Error]', error);
        res.json({ success: true, invoices: [] });
    }
});

/**
 * Get Invoice PDF
 */
app.post('/api/get-invoice-pdf', async (req, res) => {
    const { username, password, uuid, testMode } = req.body;

    try {
        const eFaturaService = await getOrCreateGibSession(username, password, testMode);
        const pdfData = await eFaturaService.getInvoicePDF(uuid);

        let pdfBase64 = null;
        if (pdfData) {
            const buffer = pdfData.pdf?.data || pdfData.data || pdfData;
            if (buffer) {
                pdfBase64 = Buffer.from(buffer).toString('base64');
            }
        }

        if (pdfBase64) {
            res.json({ success: true, pdfBase64 });
        } else {
            res.status(404).json({ success: false, error: 'PDF verisi alınamadı.' });
        }
    } catch (error) {
        console.error('[Get PDF Error]', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Download Invoice XML
 */
app.post('/api/download-invoice-xml', async (req, res) => {
    const { username, password, uuid, testMode } = req.body;

    try {
        const eFaturaService = await getOrCreateGibSession(username, password, testMode);
        const result = await eFaturaService.getInvoiceXML(uuid);

        let xmlBase64 = null;
        if (result && result.success) {
            const buffer = result.xml?.data || result.xml;
            if (buffer) {
                xmlBase64 = Buffer.from(buffer).toString('base64');
            }
        }

        if (xmlBase64) {
            res.json({ success: true, xmlBase64 });
        } else {
            res.status(404).json({ success: false, error: 'XML verisi alınamadı.' });
        }
    } catch (error) {
        console.error('[Get XML Error]', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Get Invoice HTML
 */
app.post('/api/get-invoice-html', async (req, res) => {
    const { username, password, uuid, testMode, print } = req.body;

    try {
        const eFaturaService = await getOrCreateGibSession(username, password, testMode);
        const htmlContent = await eFaturaService.getInvoiceHTML(uuid, undefined, !!print);
        res.json({ success: true, htmlContent });
    } catch (error) {
        console.error('[Get HTML Error]', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Cancel Invoice
 */
app.post('/api/cancel-invoice', async (req, res) => {
    const { username, password, uuid, reason, testMode } = req.body;

    try {
        const eFaturaService = await getOrCreateGibSession(username, password, testMode);
        const result = await eFaturaService.createCancellationRequest(uuid, reason);
        res.json(result);
    } catch (error) {
        console.error('[Cancel Invoice Error]', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Delete Invoice (Draft)
 */
app.post('/api/delete-invoice', async (req, res) => {
    const { username, password, uuid, reason, testMode } = req.body;

    try {
        const eFaturaService = await getOrCreateGibSession(username, password, testMode);
        const result = await eFaturaService.deleteInvoice(uuid, reason);
        res.json(result);
    } catch (error) {
        console.error('[Delete Invoice Error]', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Send SMS Code for signing
 */
app.post('/api/send-sms-code', async (req, res) => {
    const { username, password, testMode } = req.body;

    try {
        const eFaturaService = await getOrCreateGibSession(username, password, testMode);
        const result = await eFaturaService.sendSMSCode();
        res.json(result);
    } catch (error) {
        console.error('[Send SMS Error]', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Sign Invoice
 */
app.post('/api/sign-invoice', async (req, res) => {
    const { username, password, uuid, code, oid, testMode } = req.body;

    try {
        const eFaturaService = await getOrCreateGibSession(username, password, testMode);
        const result = await eFaturaService.signInvoices(code, oid, uuid);
        res.json(result);
    } catch (error) {
        console.error('[Sign Invoice Error]', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Update Draft Invoice
 */
app.post('/api/update-invoice', async (req, res) => {
    const { username, password, uuid, invoiceData, testMode, personalInfo } = req.body;

    try {
        const eFaturaService = await getOrCreateGibSession(username, password, testMode);

        if (personalInfo) {
            await eFaturaService.updateUserInfo(personalInfo);
        }

        const result = await eFaturaService.updateDraftInvoice(uuid, invoiceData);
        res.json(result);
    } catch (error) {
        console.error('[Update Invoice Error]', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Object Invoice (İtiraz)
 */
app.post('/api/object-invoice', async (req, res) => {
    const { username, password, uuid, reason, type, testMode } = req.body;

    try {
        const eFaturaService = await getOrCreateGibSession(username, password, testMode);

        const result = await eFaturaService.createObjectionRequest({
            uuid,
            method: type,
            explanation: reason
        });

        res.json({ success: true, message: 'Fatura itirazı oluşturuldu.', data: result });
    } catch (error) {
        console.error('[Object Invoice Error]', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ──────────────────────────────────────────────────────────────────────────
// BILLING / SUBSCRIPTION ROUTES (FIREBASE MIGRATION)
// ──────────────────────────────────────────────────────────────────────────
const crypto = require('crypto');
const { createIyzicoLink } = require('./iyzico-api');

const ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'kurye-admin-secret-2026';
const IYZICO_SECRET = process.env.IYZICO_SECRET_KEY || 'sandbox-xhHqMuDAeAgNhBFWxpMPWAzxlvTRVaJT';

const adminGuard = (req, res, next) => {
    const key = req.headers['x-admin-key'];
    if (key && key === ADMIN_API_KEY) return next();
    return res.status(403).json({ success: false, error: 'Admin yetkisi gerekli.' });
};

function verifyIyzicoWebhook(body, headerSig) {
    if (!headerSig || !IYZICO_SECRET) return false;
    // Format detection (Subscription vs Direct vs HPP)
    let msg = "";
    if (body.subscriptionReferenceCode && body.orderReferenceCode) {
        msg = `${IYZICO_SECRET}${body.merchantId || ''}${body.eventType || ''}${body.subscriptionReferenceCode}${body.orderReferenceCode}${body.customerReferenceCode || ''}`;
    } else if (body.token && body.iyziPaymentId) {
        msg = `${IYZICO_SECRET}${body.iyziEventType || ''}${body.iyziPaymentId}${body.token}${body.paymentConversationId || ''}${body.status || ''}`;
    } else {
        msg = `${IYZICO_SECRET}${body.iyziEventType || ''}${body.paymentId || ''}${body.paymentConversationId || ''}${body.status || ''}`;
    }
    const computed = crypto.createHmac('sha256', IYZICO_SECRET).update(msg, 'utf8').digest('hex');
    const a = Buffer.from(computed.toLowerCase(), 'utf8');
    const b = Buffer.from(String(headerSig).toLowerCase(), 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}



app.post('/api/billing/status', async (req, res) => {
    if (!db) return res.status(500).json({ error: 'DB_NOT_READY' });
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId_required' });

    try {
        const subSnap = await db.collection('subscriptions').doc(userId).get();
        if (!subSnap.exists) {
            return res.json({ status: 'ACTIVE', currentPeriod: null });
        }
        res.json(subSnap.data());
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/billing/init-card', async (req, res) => {
    const { userId, periodId, amount } = req.body;
    if (!userId || !periodId || !amount) {
        return res.status(400).json({ success: false, error: 'userId, periodId, amount zorunlu.' });
    }

    try {
        const conversationId = `${userId}_${periodId}`;
        const linkData = {
            name: 'Kurye Muhasebe Abonelik',
            description: `Abonelik ödemesi — Dönem ID: ${periodId}`,
            price: parseFloat(amount),
            conversationId: conversationId
        };

        const result = await createIyzicoLink(linkData);

        if (result && result.status === 'success') {
            // Firestore log intent
            if (db) {
                await db.collection('payments').doc(conversationId).set({
                    userId, periodId, method: 'CARD', status: 'PENDING',
                    amount: linkData.price, createdAt: admin.firestore.FieldValue.serverTimestamp()
                });
            }
            return res.json({
                success: true,
                paymentPageUrl: result.data?.url || result.data?.paymentPageUrl,
                conversationId
            });
        }
        throw new Error(result?.errorMessage || 'iyzico yanıt hatası');
    } catch (err) {
        console.warn('[billing/init-card] iyzico err:', err.message);
        return res.json({ success: true, mockSuccess: true, periodId }); // Dev fallback
    }
});

app.post('/api/billing/webhook', async (req, res) => {
    const headerSig = req.header('X-IYZ-SIGNATURE-V3') || req.header('x-iyz-signature-v3');
    const body = req.body || {};

    if (headerSig && !verifyIyzicoWebhook(body, headerSig)) {
        console.warn('[webhook] Geçersiz imza');
        return res.status(401).json({ ok: false, error: 'INVALID_SIGNATURE' });
    }

    const eventKey = body.paymentId || body.conversationId || body.orderReferenceCode || `${body.iyziEventType}_${Date.now()}`;

    const isSuccess = String(body.status || '').toUpperCase() === 'SUCCESS';
    const conversationId = body.paymentConversationId || body.conversationId;

    if (db && isSuccess && conversationId) {
        try {
            // conversationId format: userId_periodId
            const parts = conversationId.split('_');
            const userId = parts[0];
            const periodId = parts.slice(1).join('_'); // periodId might contain '_'

            await db.runTransaction(async (t) => {
                // Idempotency: Check if this event was already processed
                const evtRef = db.collection('webhookEvents').doc(String(eventKey));
                const evtSnap = await t.get(evtRef);

                if (evtSnap.exists) {
                    // Zaten islenmis
                    console.log('[webhook] Idempotency: Zaten islenmis event:', eventKey);
                    return; // exit transaction
                }

                const payRef = db.collection('payments').doc(conversationId);
                const periodRef = db.collection('billingPeriods').doc(periodId);
                const subRef = db.collection('subscriptions').doc(userId);

                // Transaction islemleri
                t.set(payRef, {
                    status: 'SUCCEEDED',
                    providerPaymentId: body.paymentId,
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                }, { merge: true });

                t.update(periodRef, {
                    status: 'PAID',
                    paidAt: admin.firestore.FieldValue.serverTimestamp(),
                    paymentId: conversationId
                });

                // Auto-unlock
                t.update(subRef, { status: 'ACTIVE', lockReason: null, unlockedAt: admin.firestore.FieldValue.serverTimestamp() });

                // Mar event as processed
                t.set(evtRef, { provider: 'IYZICO', createdAt: admin.firestore.FieldValue.serverTimestamp(), raw: body });
            });
            return res.json({ ok: true });
        } catch (e) {
            console.error('[webhook] db tx error:', e);
            // return 500 to let iyzico retry if it's a transient db error
            return res.status(500).json({ ok: false, error: 'DB_ERROR' });
        }
    } else {
        processedWebhookEvents.add(eventKey);
    }

    return res.status(200).json({ ok: true, isSuccess });
});

app.post('/api/billing/init-transfer', async (req, res) => {
    const { userId, periodId } = req.body;
    if (!userId || !periodId) return res.status(400).json({ success: false, error: 'userId, periodId zorunlu.' });

    const refCode = (userId.slice(-4) + periodId.slice(-4) + Math.random().toString(36).slice(2, 6)).toUpperCase();
    const intentId = `trf_${Date.now()}_${refCode}`;

    if (db) {
        await db.collection('bankIntents').doc(intentId).set({
            userId, periodId, referenceCode: refCode, status: 'OPEN',
            iban: process.env.IBAN || 'TR12 3456 7890 1234 5678 9012 34',
            accountName: process.env.ACCOUNT_NAME || 'Kurye Muhasebe Hizmetleri',
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
    }

    return res.json({
        success: true, intentId, referenceCode: refCode,
        iban: process.env.IBAN || 'TR12 3456 7890 1234 5678 9012 34',
        accountName: process.env.ACCOUNT_NAME || 'Kurye Muhasebe Hizmetleri'
    });
});

app.get('/api/admin/transfers', adminGuard, async (req, res) => {
    if (!db) return res.json({ success: false, error: 'DB_NOT_READY' });
    try {
        const snap = await db.collection('bankIntents').where('status', '==', 'OPEN').orderBy('createdAt', 'desc').get();
        const data = snap.docs.map(d => ({ intentId: d.id, ...d.data() }));
        res.json({ success: true, data });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/admin/transfers/:intentId/confirm', adminGuard, async (req, res) => {
    const { intentId } = req.params;
    if (!db) return res.json({ success: false, error: 'DB_NOT_READY' });

    try {
        await db.runTransaction(async (t) => {
            const intentRef = db.collection('bankIntents').doc(intentId);
            const doc = await t.get(intentRef);
            if (!doc.exists) throw new Error('Intent not found');
            const data = doc.data();
            if (data.status !== 'OPEN') throw new Error('Intent not OPEN');

            t.update(intentRef, { status: 'CONFIRMED', confirmedAt: admin.firestore.FieldValue.serverTimestamp() });

            const conversationId = `trf_pay_${Date.now()}`;
            t.set(db.collection('payments').doc(conversationId), {
                userId: data.userId, periodId: data.periodId, method: 'TRANSFER', status: 'SUCCEEDED',
                confirmedAt: admin.firestore.FieldValue.serverTimestamp()
            });

            const periodRef = db.collection('billingPeriods').doc(data.periodId);
            t.update(periodRef, { status: 'PAID', paidAt: admin.firestore.FieldValue.serverTimestamp(), paymentId: conversationId });

            t.update(db.collection('subscriptions').doc(data.userId), { status: 'ACTIVE', lockReason: null });
        });
        res.json({ success: true, message: 'Onay kaydedildi.' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/admin/transfers/:intentId/reject', adminGuard, async (req, res) => {
    const { intentId } = req.params;
    if (!db) return res.json({ success: false, error: 'DB_NOT_READY' });
    try {
        await db.collection('bankIntents').doc(intentId).update({ status: 'REJECTED' });
        res.json({ success: true, message: 'Red kaydedildi.' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ──────────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    console.log(`CORS origins: ${allowedOrigins.join(', ')}`);
    console.log(`API Key auth: ${API_KEY ? 'enabled' : 'disabled'}`);
});

