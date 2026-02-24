
const ApiMapper = {
    // Fatura Başlık Alanları
    HeaderMap: {
        uuid: 'ettn',
        date: 'faturaTarihi',
        time: 'saat',
        currency: 'paraBirimi',
        exchangeRate: 'dovizKuru',
        invoiceType: 'faturaTipi',
        taxType: 'vergiTipi',

        // Alıcı Bilgileri
        'receiver.vknTckn': 'vknTckn',
        'receiver.title': 'aliciUnvan',
        'receiver.name': 'aliciAdi',
        'receiver.surname': 'aliciSoyadi',
        'receiver.taxOffice': 'vergiDairesi',
        'receiver.address': 'bulvarcaddesokak',
        'receiver.district': 'ilce',
        'receiver.city': 'sehir',
        'receiver.country': 'ulke',
        'receiver.email': 'eposta',
        'receiver.phone': 'tel',
        'receiver.web': 'websitesi',

        // Toplamlar
        base: 'matrah',
        totalWAT: 'malhizmetToplamTutari',
        calculatedVAT: 'hesaplanankdv',
        totalTaxes: 'vergilerToplami',
        paymentPrice: 'odenecekTutar',
        totalDiscount: 'iskontoTutari'
    },

    // Vergi Kodları Eşleştirmesi (Frontend Code -> GIB Code)
    TaxCodes: {
        // Tevkifat Kodları
        '601': '601', // Yapım İşleri...

        // Stopaj Kodları
        '0003': '0003', // GV Stopaj
        '0011': '0011', // KV Stopaj

        // Diğer Vergiler
        '0015': '0015', // KDV
        '1047': '1047', // Damga
        '9040': '9040', // Mera Fonu
        '4080': '4080', // OIV
        '0071': '0071'  // OTV 1. Liste
    },

    // Birim Eşleştirmesi
    UnitMap: {
        'ADET': 'C62',
        'KG': 'KGM',
        'LT': 'LTR',
        'M': 'MTR',
        'M2': 'MTK',
        'M3': 'MTQ',
        'GUN': 'DAY',
        'AY': 'MON',
        'YIL': 'ANN',
        'SAAT': 'HUR',
        'DAKIKA': 'D61'
    },

    /**
     * mapKey
     * Verilen anahtarın GIB karşılığını döndürür
     */
    map(key) {
        return this.HeaderMap[key] || key;
    },

    /**
     * getUnitCode
     * Birim kodunu GIB standardına çevirir
     */
    getUnitCode(unit) {
        const u = (unit || 'ADET').toUpperCase();
        return this.UnitMap[u] || 'C62'; // Default Adet
    }
};

module.exports = ApiMapper;
