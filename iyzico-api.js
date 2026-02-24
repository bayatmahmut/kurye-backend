const axios = require('axios');
const crypto = require('crypto');

// iyzico yapılandırması
const CONFIG = {
    apiKey: 'sandbox-afXhSPxNzxOqMdTTjpKbEVp3iyVkcdsz',  // Sandbox API Key
    secretKey: 'sandbox-xhHqMuDAeAgNhBFWxpMPWAzxlvTRVaJT', // Sandbox Secret Key
    baseUri: 'https://sandbox-api.iyzipay.com'  // Canlı için: https://api.iyzipay.com
};

// PKI String oluşturma
const generatePKIString = (request) => {
    let pki = '[';

    const processValue = (value) => {
        if (value === null || value === undefined) return '';
        if (Array.isArray(value)) {
            return '[' + value.map(item => {
                if (typeof item === 'object') return generatePKIString(item).replace('[', '').replace(']', '');
                return item;
            }).join(', ') + ']';
        }
        if (typeof value === 'object') return generatePKIString(value);
        return value.toString();
    };

    Object.keys(request).forEach(key => {
        const value = processValue(request[key]);
        if (value !== '') {
            pki += `${key}=${value},`;
        }
    });

    pki = pki.replace(/,$/, '') + ']';
    return pki;
};

// Authorization header oluşturma (IYZWSv2)
const generateAuthorizationHeader = (uri, requestBody = null) => {
    const randomKey = crypto.randomBytes(8).toString('hex');
    const payloadString = requestBody ? JSON.stringify(requestBody) : '';

    const hashString = randomKey + uri + (payloadString || '');
    const signature = crypto.createHmac('sha256', CONFIG.secretKey)
        .update(hashString)
        .digest('hex');

    const authString = `${CONFIG.apiKey}:${randomKey}:${signature}`;
    return `IYZWSv2 ${Buffer.from(authString).toString('base64')}`;
};

// Benzersiz conversation ID oluştur
const generateConversationId = () => {
    return 'CONV_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
};

// ============================================
// iyzico Link API
// ============================================

/**
 * iyzico Link (Ödeme Linki) Oluşturma
 * Müşteriye gönderilebilecek bir ödeme linki oluşturur
 */
const createIyzicoLink = async (linkData) => {
    const {
        name,
        description,
        price,
        currency = 'TRY',
        addressIgnorable = true,
        installmentRequested = false,
        conversationId
    } = linkData;

    const uri = '/v2/iyzilink/products';

    const requestBody = {
        locale: 'tr',
        conversationId: conversationId || generateConversationId(),
        name: name,
        description: description,
        base64EncodedImage: '', // Opsiyonel: Ürün resmi (base64)
        price: price.toString(),
        currency: currency,
        addressIgnorable: addressIgnorable,
        installmentRequested: installmentRequested,
        stockEnabled: false,
        stockCount: null,
        flexibleLinkEnabled: false,
        productCategoryType: 'UNKNOWN'
    };

    const authorization = generateAuthorizationHeader(uri, requestBody);

    try {
        const response = await axios.post(`${CONFIG.baseUri}${uri}`, requestBody, {
            headers: {
                'Authorization': authorization,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        });

        console.log('iyzico Link oluşturma yanıtı:', response.data);
        return response.data;
    } catch (error) {
        console.error('iyzico Link oluşturma hatası:', error.response?.data || error.message);
        throw error;
    }
};

/**
 * Fastlink Oluşturma (750 TL ve altı, tek seferlik)
 */
const createFastlink = async (fastlinkData) => {
    const {
        description,
        price,
        currency = 'TRY',
        conversationId
    } = fastlinkData;

    const uri = '/v2/iyzilink/fast-link/products';

    const requestBody = {
        locale: 'tr',
        conversationId: conversationId || generateConversationId(),
        description: description,
        price: price.toString(),
        currency: currency
    };

    const authorization = generateAuthorizationHeader(uri, requestBody);

    try {
        const response = await axios.post(`${CONFIG.baseUri}${uri}`, requestBody, {
            headers: {
                'Authorization': authorization,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        });

        console.log('Fastlink oluşturma yanıtı:', response.data);
        return response.data;
    } catch (error) {
        console.error('Fastlink oluşturma hatası:', error.response?.data || error.message);
        throw error;
    }
};

/**
 * iyzico Link Sorgulama
 */
const retrieveIyzicoLink = async (token) => {
    const uri = `/v2/iyzilink/products/${token}`;
    const conversationId = generateConversationId();

    const authorization = generateAuthorizationHeader(uri);

    try {
        const response = await axios.get(`${CONFIG.baseUri}${uri}`, {
            headers: {
                'Authorization': authorization,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'x-conversation-id': conversationId,
                'x-locale': 'tr'
            }
        });

        console.log('iyzico Link sorgulama yanıtı:', response.data);
        return response.data;
    } catch (error) {
        console.error('iyzico Link sorgulama hatası:', error.response?.data || error.message);
        throw error;
    }
};

/**
 * iyzico Linkleri Listeleme
 */
const listIyzicoLinks = async (page = 1, count = 10) => {
    const uri = `/v2/iyzilink/products?page=${page}&count=${count}`;
    const conversationId = generateConversationId();

    const authorization = generateAuthorizationHeader(uri);

    try {
        const response = await axios.get(`${CONFIG.baseUri}${uri}`, {
            headers: {
                'Authorization': authorization,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'x-conversation-id': conversationId,
                'x-locale': 'tr'
            }
        });

        console.log('iyzico Link listeleme yanıtı:', response.data);
        return response.data;
    } catch (error) {
        console.error('iyzico Link listeleme hatası:', error.response?.data || error.message);
        throw error;
    }
};

/**
 * iyzico Link Güncelleme
 */
const updateIyzicoLink = async (token, updateData) => {
    const uri = `/v2/iyzilink/products/${token}`;

    const requestBody = {
        locale: 'tr',
        conversationId: generateConversationId(),
        ...updateData
    };

    const authorization = generateAuthorizationHeader(uri, requestBody);

    try {
        const response = await axios.put(`${CONFIG.baseUri}${uri}`, requestBody, {
            headers: {
                'Authorization': authorization,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        });

        console.log('iyzico Link güncelleme yanıtı:', response.data);
        return response.data;
    } catch (error) {
        console.error('iyzico Link güncelleme hatası:', error.response?.data || error.message);
        throw error;
    }
};

/**
 * iyzico Link Durum Güncelleme (aktif/pasif)
 */
const updateIyzicoLinkStatus = async (token, status) => {
    // status: 'ACTIVE' veya 'PASSIVE'
    const uri = `/v2/iyzilink/products/${token}/status/${status}`;
    const conversationId = generateConversationId();

    const authorization = generateAuthorizationHeader(uri);

    try {
        const response = await axios.patch(`${CONFIG.baseUri}${uri}`, null, {
            headers: {
                'Authorization': authorization,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'x-conversation-id': conversationId,
                'x-locale': 'tr'
            }
        });

        console.log('iyzico Link durum güncelleme yanıtı:', response.data);
        return response.data;
    } catch (error) {
        console.error('iyzico Link durum güncelleme hatası:', error.response?.data || error.message);
        throw error;
    }
};

/**
 * iyzico Link Silme
 */
const deleteIyzicoLink = async (token) => {
    const uri = `/v2/iyzilink/products/${token}`;
    const conversationId = generateConversationId();

    const authorization = generateAuthorizationHeader(uri);

    try {
        const response = await axios.delete(`${CONFIG.baseUri}${uri}`, {
            headers: {
                'Authorization': authorization,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'x-conversation-id': conversationId,
                'x-locale': 'tr'
            }
        });

        console.log('iyzico Link silme yanıtı:', response.data);
        return response.data;
    } catch (error) {
        console.error('iyzico Link silme hatası:', error.response?.data || error.message);
        throw error;
    }
};

module.exports = {
    createIyzicoLink,
    createFastlink,
    retrieveIyzicoLink,
    listIyzicoLinks,
    updateIyzicoLink,
    updateIyzicoLinkStatus,
    deleteIyzicoLink,
    CONFIG
};
