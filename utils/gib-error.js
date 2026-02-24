
class GIBError extends Error {
    constructor(message, code = 'GIB_ERROR', details = {}) {
        super(message);
        this.name = 'GIBError';
        this.code = code;
        this.details = details;
        this.timestamp = new Date().toISOString();
    }

    static fromResponse(error, context = '') {
        const details = {
            context,
            originalError: error.message,
            request: error.config ? {
                url: error.config.url,
                method: error.config.method,
                data: error.config.data
            } : null,
            response: error.response ? {
                status: error.response.status,
                data: error.response.data
            } : null
        };

        const message = error.response?.data?.message || error.message || 'Bilinmeyen bir hata oluştu';
        return new GIBError(message, error.response?.status || 'NETWORK_ERROR', details);
    }
}

module.exports = GIBError;
