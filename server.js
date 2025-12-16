const express = require('express');
const crypto = require('crypto');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const fs = require('fs').promises;
const path = require('path');
const app = express();
const PORT = process.env.PORT || 8080;

app.use(helmet());
app.use(express.json({ limit: '100kb' }));
app.set('trust proxy', 1);

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, Authorization');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

const USERS_FILE = path.join(__dirname, 'users.json');

function generateUserKey() {
    const section = () => 
        Array.from({ length: 4 }, () => 
            "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"[Math.floor(Math.random() * 36)]
        ).join("");
    return Array.from({ length: 4 }, section).join("-");
}

async function loadUsers() {
    try {
        const data = await fs.readFile(USERS_FILE, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        if (err.code === 'ENOENT') return { users: {} };
        throw err;
    }
}

async function saveUsers(data) {
    await fs.writeFile(USERS_FILE, JSON.stringify(data, null, 2));
}

async function registerUser(userKey, config) {
    const data = await loadUsers();
    data.users[userKey] = {
        ...config,
        createdAt: config.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };
    await saveUsers(data);
}

async function getUserConfig(userKey) {
    const data = await loadUsers();
    return data.users[userKey] || null;
}

async function listAllUsers() {
    const data = await loadUsers();
    return Object.entries(data.users).map(([key, config]) => ({
        userKey: key,
        ...config
    }));
}

class DonationStore {
    constructor() {
        this.donations = new Map();
        this.timestamps = new Map();
        this.queues = new Map();
        this.processedIds = new Map();
        this.userStats = new Map();
    }

    initUser(userKey) {
        if (!this.queues.has(userKey)) this.queues.set(userKey, []);
        if (!this.processedIds.has(userKey)) this.processedIds.set(userKey, []);
        if (!this.userStats.has(userKey)) {
            this.userStats.set(userKey, {
                totalReceived: 0,
                totalProcessed: 0,
                totalQueued: 0,
                lastActivity: Date.now()
            });
        }
    }

    updateStats(userKey, action) {
        const stats = this.userStats.get(userKey);
        if (!stats) return;
        stats.lastActivity = Date.now();
        if (action === 'received') stats.totalReceived++;
        if (action === 'processed') stats.totalProcessed++;
        if (action === 'queued') stats.totalQueued++;
    }

    cleanupInactiveUsers(maxInactiveMs = 3600000) {
        const now = Date.now();
        for (const [userKey, stats] of this.userStats.entries()) {
            const inactive = now - stats.lastActivity;
            if (inactive > maxInactiveMs) {
                if (!this.donations.has(userKey) && 
                    (!this.queues.has(userKey) || this.queues.get(userKey).length === 0)) {
                    this.processedIds.delete(userKey);
                    this.timestamps.delete(userKey);
                }
            }
        }
    }
}

const store = new DonationStore();

function verifyApiKey(expectedKey, providedKey) {
    if (!expectedKey) return false;
    return crypto.timingSafeEqual(
        Buffer.from(providedKey),
        Buffer.from(expectedKey)
    );
}

async function validateUserKey(req, res, next) {
    const userKey = req.params.key;
    const config = await getUserConfig(userKey);
    
    if (!config) {
        return res.status(404).json({ 
            error: 'USER_NOT_FOUND',
            message: 'Invalid user key'
        });
    }
    
    req.userConfig = config;
    store.initUser(userKey);
    next();
}

async function requireApiKey(req, res, next) {
    const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
    
    if (!apiKey) {
        return res.status(401).json({ 
            error: 'MISSING_API_KEY',
            message: 'API key required in X-API-Key header'
        });
    }
    
    if (!verifyApiKey(req.userConfig.apiKey, apiKey)) {
        return res.status(403).json({ 
            error: 'INVALID_API_KEY',
            message: 'Invalid API key'
        });
    }
    next();
}

const globalLimiter = rateLimit({
    windowMs: 60000,
    max: 100
});

const adminLimiter = rateLimit({
    windowMs: 60000,
    max: 20
});

function generateDonationId(donation) {
    const timestamp = Date.now();
    const random = crypto.randomBytes(8).toString('hex');
    const name = (donation.donor_name || 'anon').toLowerCase().replace(/[^a-z0-9]/g, '');
    const amount = donation.amount || 0;
    const platform = donation.platform || 'unknown';
    return `${platform}_${name}_${amount}_${timestamp}_${random}`;
}

const DUPLICATE_WINDOW = 5000;
const EXACT_DUPLICATE_WINDOW = 3000;

function isDuplicate(userKey, donation) {
    const processedList = store.processedIds.get(userKey);
    if (!processedList || processedList.length === 0) return false;
    
    const now = Date.now();
    const recentDonations = processedList.filter(item => 
        (now - item.timestamp) < DUPLICATE_WINDOW
    );
    
    store.processedIds.set(userKey, recentDonations);
    
    const currentDonorName = getDonorName(donation);
    
    return recentDonations.some(item => {
        const timeDiff = now - item.timestamp;
        return item.platform === donation.platform &&
               item.donorName === currentDonorName &&
               item.amount === donation.amount &&
               timeDiff < EXACT_DUPLICATE_WINDOW;
    });
}

function markAsProcessed(userKey, donation) {
    const processedList = store.processedIds.get(userKey) || [];
    
    processedList.push({
        platform: donation.platform,
        donorName: getDonorName(donation), // ✅ Universal field
        amount: donation.amount,
        timestamp: Date.now()
    });
    
    if (processedList.length > 50) {
        processedList.splice(0, processedList.length - 50);
    }
    store.processedIds.set(userKey, processedList);
}

function addToQueue(userKey, donation, maxQueueSize) {
    const queue = store.queues.get(userKey) || [];
    
    if (queue.length >= maxQueueSize) {
        return { success: false, reason: 'QUEUE_FULL' };
    }
    
    const donationId = generateDonationId(donation);
    queue.push({
        id: donationId,
        data: donation,
        timestamp: Date.now()
    });
    
    store.queues.set(userKey, queue);
    store.updateStats(userKey, 'queued');
    
    if (!store.donations.has(userKey)) {
        promoteFromQueue(userKey);
    }
    
    return { success: true, queueSize: queue.length };
}

function promoteFromQueue(userKey) {
    const queue = store.queues.get(userKey);
    if (!queue || queue.length === 0) return false;
    
    const next = queue.shift();
    store.donations.set(userKey, next.data);
    store.timestamps.set(userKey, Date.now());
    return true;
}

function sanitizeString(str, maxLength = 100) {
    if (!str) return '';
    return String(str).slice(0, maxLength).trim();
}

function sanitizeAmount(amount) {
    const num = parseFloat(amount);
    return isNaN(num) || num < 0 ? 0 : Math.min(num, 1000000000);
}

function parseBagiBagi(data) {
    console.log('📦 Parsing BagiBagi data:', JSON.stringify(data, null, 2));
    
    // ✅ Ambil userName dari BagiBagi
    let userName = data.userName || 'Anonymous';
    
    // ✅ Jika isAnonymous = true, paksa jadi "Anonymous"
    if (data.isAnonymous === false) {
        userName = 'Anonymous';
        console.log('🔒 Anonymous donation detected');
    }
    
    console.log('🔍 Final userName:', userName);
    
    return {
        platform: 'bagibagi',
        userName: sanitizeString(userName), // ✅ Tetap pakai userName
        amount: sanitizeAmount(data.amount),
        message: sanitizeString(data.message || '', 500),
        isVerified: data.isVerified === true,
        isAnonymous: data.isAnonymous === true
    };
}

function getDonorName(donation) {
    // BagiBagi uses userName
    if (donation.platform === 'bagibagi') {
        return donation.userName || 'Anonymous';
    }
    // Trakteer & Tako use supporter_name
    if (donation.platform === 'trakteer' || donation.platform === 'tako') {
        return donation.supporter_name || 'Anonymous';
    }
    // Saweria & Sociabuzz use donor_name
    return donation.donor_name || 'Anonymous';
}

function parseSaweria(data) {
    console.log('💰 Parsing Saweria data');
    return {
        platform: 'saweria',
        donor_name: sanitizeString(
            data.donator_name || 
            data.donatur_name || 
            'Anonymous'
        ), // ✅ HANYA donator/donatur_name!
        amount: sanitizeAmount(data.amount_raw || data.amount),
        message: sanitizeString(data.message || data.donator_message || data.donatur_message || '', 500)
    };
}

function parseSociabuzz(data) {
    return {
        platform: 'sociabuzz',
        donor_name: data.supporter || data.supporter_name || data.name || 'Anonymous',
        amount: data.amount || data.amount_settled || data.amount_raw || 0,
        message: data.message || data.supporter_message || ''
    };
}

function parseTrakteer(data) {
    console.log('☕ Parsing Trakteer data');
    return {
        platform: 'trakteer',
        supporter_name: sanitizeString(data.supporter_name || 'Anonymous'), // ✅ HANYA supporter_name!
        amount: sanitizeAmount(data.price || data.amount),
        message: sanitizeString(data.supporter_message || data.message || '', 500)
    };
}

function parseTako(data) {
    console.log('🐙 Parsing Tako data');
    return {
        platform: 'tako',
        supporter_name: sanitizeString(data.supporter_name || data.donator_name || 'Anonymous'),
        amount: sanitizeAmount(data.amount_raw || data.amount),
        message: sanitizeString(data.message || data.supporter_message || '', 500)
    };
}

// ✅ CRITICAL FIX: Prioritas deteksi BagiBagi SEBELUM cek platform field
function autoDetectPlatform(data) {
    console.log('========== AUTO DETECT PLATFORM ==========');
    console.log('Raw data:', JSON.stringify(data, null, 2));
    
    // ✅ PRIORITY 1: Deteksi BagiBagi dari field eksklusif SEBELUM cek apapun
    if (data.userName !== undefined || 
        data.isVerified !== undefined || 
        data.isAnonymous !== undefined) {
        console.log('✅ BAGIBAGI detected from EXCLUSIVE fields (userName/isVerified/isAnonymous)');
        return parseBagiBagi(data);
    }
    
    // ✅ PRIORITY 2: Deteksi BagiBagi dari platform field
    const platformLower = (data.platform || '').toLowerCase();
    if (platformLower === 'bagibagi' || platformLower.includes('bagi')) {
        console.log('✅ BAGIBAGI detected from platform field');
        return parseBagiBagi(data);
    }
    
    // ✅ PRIORITY 3: Deteksi Saweria dari field spesifik
    if (data.version && (data.donator_name || data.donatur_name)) {
        console.log('✅ SAWERIA detected (version + donator_name)');
        return parseSaweria(data);
    }
    if (data.donator_name || data.donatur_name) {
        console.log('✅ SAWERIA detected (donator_name)');
        return parseSaweria(data);
    }
    
    // ✅ PRIORITY 4: Deteksi Sociabuzz dari field spesifik
    if (data.supporter && (data.email_supporter || data.currency === 'IDR')) {
        console.log('✅ SOCIABUZZ detected (supporter + email/currency)');
        return parseSociabuzz(data);
    }
    if (data.content?.link?.includes('sociabuzz.com')) {
        console.log('✅ SOCIABUZZ detected (content link)');
        return parseSociabuzz(data);
    }
    
    // ✅ PRIORITY 5: Deteksi dari platform field (fallback)
    if (platformLower === 'sociabuzz' || platformLower === 'buzz') {
        console.log('✅ SOCIABUZZ detected from platform field');
        return parseSociabuzz(data);
    }
    if (platformLower === 'saweria') {
        console.log('✅ SAWERIA detected from platform field');
        return parseSaweria(data);
    }
    if (platformLower === 'trakteer') {
        console.log('✅ TRAKTEER detected from platform field');
        return parseTrakteer(data);
    }
    if (platformLower === 'tako') {
        console.log('✅ TAKO detected from platform field');
        return parseTako(data);
    }
    
    // ✅ PRIORITY 6: Deteksi dari URL
    if (data.url) {
        if (data.url.includes('sociabuzz')) return parseSociabuzz(data);
        if (data.url.includes('trakteer')) return parseTrakteer(data);
        if (data.url.includes('saweria')) return parseSaweria(data);
        if (data.url.includes('bagibagi')) return parseBagiBagi(data);
    }
    
    // ✅ PRIORITY 7: Deteksi dari kombinasi field (last resort)
    if (data.supporter_name && data.price) {
        console.log('✅ TRAKTEER detected (supporter_name + price)');
        return parseTrakteer(data);
    }
    
    // ⚠️ CRITICAL: JANGAN langsung assume Sociabuzz jika ada supporter + amount
    // Harus pastikan BUKAN BagiBagi dulu
    if (data.supporter && data.amount && 
        data.userName === undefined && 
        data.isVerified === undefined && 
        data.isAnonymous === undefined) {
        console.log('✅ SOCIABUZZ detected (supporter + amount, confirmed NOT BagiBagi)');
        return parseSociabuzz(data);
    }
    
    if (data.supporter_name) {
        console.log('✅ TRAKTEER detected (supporter_name)');
        return parseTrakteer(data);
    }
    
    // ⚠️ Generic fallback (hindari ini sebisa mungkin)
    if (data.name && data.amount) {
        console.log('⚠️ Generic detection - defaulting to SAWERIA');
        return parseSaweria(data);
    }
    
    console.log('❌ No platform detected');
    return null;
}

// ✅ WEBHOOK HANDLER dengan support BagiBagi array format
app.post('/donation/:key/webhook', 
    validateUserKey,
    (req, res) => {
        const userKey = req.params.key;
        const config = req.userConfig;
        
        console.log(`\n📥 Webhook received for user: ${userKey}`);
        console.log('Raw body:', JSON.stringify(req.body, null, 2));
        
        let webhookData = req.body;
        
        // ✅ HANDLE BAGIBAGI ARRAY FORMAT
        // BagiBagi mengirim: { data: [...], success: true, message: "Success" }
        if (webhookData.data && Array.isArray(webhookData.data)) {
            if (webhookData.data.length === 0) {
                console.log('⚠️ BagiBagi array is empty, no donation data');
                return res.status(200).json({ 
                    success: true, 
                    message: 'Empty data array',
                    queued: false 
                });
            }
            
            console.log('🔄 Detected BagiBagi array format, extracting first item...');
            webhookData = webhookData.data[0]; // Ambil donasi pertama dari array
            console.log('Extracted data:', JSON.stringify(webhookData, null, 2));
        }
        
        const donation = autoDetectPlatform(webhookData);
        
        if (!donation) {
            console.log('❌ Failed to parse donation data');
            return res.status(400).json({ 
                error: 'INVALID_DONATION_DATA',
                message: 'Could not parse donation data'
            });
        }
        
        console.log(`✅ Parsed as ${donation.platform.toUpperCase()}:`, {
            donor: donation.donor_name,
            amount: donation.amount,
            isVerified: donation.isVerified,
            isAnonymous: donation.isAnonymous
        });
        
        if (!donation.amount || donation.amount <= 0) {
            console.log('❌ Invalid amount');
            return res.status(400).json({ 
                error: 'INVALID_AMOUNT',
                message: 'Amount must be greater than 0'
            });
        }
        
        if (isDuplicate(userKey, donation)) {
            console.log('⚠️ Duplicate donation ignored');
            return res.status(200).json({ 
                success: true, 
                message: 'Duplicate ignored',
                queued: false 
            });
        }
        
        store.updateStats(userKey, 'received');
        
        if (store.donations.has(userKey)) {
            const result = addToQueue(userKey, donation, config.maxQueueSize);
            
            if (!result.success) {
                console.log('❌ Queue is full');
                return res.status(429).json({ 
                    error: 'QUEUE_FULL',
                    message: 'Donation queue is full'
                });
            }
            
            console.log(`📋 Added to queue (position: ${result.queueSize})`);
            markAsProcessed(userKey, donation);
            return res.status(200).json({ 
                success: true, 
                queued: true,
                queuePosition: result.queueSize
            });
        }
        
        store.donations.set(userKey, donation);
        store.timestamps.set(userKey, Date.now());
        markAsProcessed(userKey, donation);
        
        console.log('✅ Donation stored successfully');
        res.status(200).json({ success: true, queued: false });
    }
);

app.get('/donation/:key/data', 
    validateUserKey,
    requireApiKey,
    (req, res) => {
        const userKey = req.params.key;
        
        if (!store.donations.has(userKey)) {
            return res.status(204).send();
        }
        
        let donation = store.donations.get(userKey);
        const config = req.userConfig;
        
        if (config.overrides?.enabled) {
            donation = {
                ...donation,
                donor_name: config.overrides.donor_name,
                message: config.overrides.message
            };
        }
        
        res.json(donation);
    }
);

app.delete('/donation/:key/clear', 
    validateUserKey,
    requireApiKey,
    (req, res) => {
        const userKey = req.params.key;
        
        if (!store.donations.has(userKey)) {
            return res.status(404).json({ 
                error: 'NO_DONATION',
                message: 'No active donation to clear'
            });
        }
        
        store.donations.delete(userKey);
        store.updateStats(userKey, 'processed');
        
        const promoted = promoteFromQueue(userKey);
        const queue = store.queues.get(userKey) || [];
        
        res.json({ 
            success: true,
            promoted,
            queueSize: queue.length
        });
    }
);

app.get('/donation/:key/status', 
    globalLimiter,
    validateUserKey,
    requireApiKey,
    (req, res) => {
        const userKey = req.params.key;
        const config = req.userConfig;
        const queue = store.queues.get(userKey) || [];
        const stats = store.userStats.get(userKey);
        
        res.json({
            has_pending: store.donations.has(userKey),
            donation: store.donations.get(userKey) || null,
            queue_size: queue.length,
            max_queue_size: config.maxQueueSize,
            queue_usage_percent: Math.round((queue.length / config.maxQueueSize) * 100),
            last_timestamp: store.timestamps.get(userKey) || null,
            override_enabled: config.overrides?.enabled || false,
            stats: stats || {}
        });
    }
);

app.post('/donation/:key/force-clear', 
    globalLimiter,
    validateUserKey,
    requireApiKey,
    (req, res) => {
        const userKey = req.params.key;
        const queue = store.queues.get(userKey) || [];
        
        const cleared = {
            donation: store.donations.has(userKey),
            queue: queue.length
        };
        
        if (store.donations.has(userKey)) {
            store.donations.delete(userKey);
            store.timestamps.delete(userKey);
        }
        
        if (queue.length > 0) {
            store.queues.set(userKey, []);
        }
        
        res.json({ success: true, cleared });
    }
);

const MASTER_API_KEY = process.env.MASTER_API_KEY || 'cf0019eebe678e7a47c87405e41e139c1e441c0ecac0eea06b54e52c6db2fa50';

function requireMasterKey(req, res, next) {
    const apiKey = req.headers['x-master-key'];
    
    if (!apiKey || apiKey !== MASTER_API_KEY) {
        return res.status(403).json({ 
            error: 'FORBIDDEN',
            message: 'Invalid master API key'
        });
    }
    next();
}

app.post('/admin/users/register',
    adminLimiter,
    requireMasterKey,
    async (req, res) => {
        try {
            const { robloxId, discordId, discordUsername } = req.body;
            
            if (!robloxId || !discordId) {
                return res.status(400).json({
                    error: 'MISSING_FIELDS',
                    message: 'robloxId and discordId are required'
                });
            }

            const userKey = generateUserKey();
            const apiKey = `sk_live_${crypto.randomBytes(24).toString('hex')}`;

            const config = {
                robloxId,
                discordId,
                discordUsername: discordUsername || 'Unknown',
                apiKey,
                maxQueueSize: 100,
                rateLimit: {
                    windowMs: 60000,
                    maxRequests: 60
                },
                overrides: {
                    enabled: false
                },
                createdAt: new Date().toISOString()
            };

            await registerUser(userKey, config);

            res.json({
                success: true,
                userKey,
                apiKey,
                webhookUrl: `${req.protocol}://${req.get('host')}/donation/${userKey}/webhook`,
                config
            });

        } catch (err) {
            res.status(500).json({
                error: 'REGISTRATION_FAILED',
                message: err.message
            });
        }
    }
);

app.get('/admin/users/list',
    adminLimiter,
    requireMasterKey,
    async (req, res) => {
        try {
            const users = await listAllUsers();
            res.json({
                success: true,
                count: users.length,
                users: users.map(u => ({
                    userKey: u.userKey,
                    robloxId: u.robloxId,
                    discordId: u.discordId,
                    discordUsername: u.discordUsername,
                    createdAt: u.createdAt,
                    maxQueueSize: u.maxQueueSize
                }))
            });
        } catch (err) {
            res.status(500).json({
                error: 'FETCH_FAILED',
                message: err.message
            });
        }
    }
);

app.get('/admin/users/:key',
    adminLimiter,
    requireMasterKey,
    async (req, res) => {
        try {
            const userKey = req.params.key;
            const config = await getUserConfig(userKey);
            
            if (!config) {
                return res.status(404).json({
                    error: 'USER_NOT_FOUND',
                    message: 'User key not found'
                });
            }

            res.json({
                success: true,
                userKey,
                config
            });
        } catch (err) {
            res.status(500).json({
                error: 'FETCH_FAILED',
                message: err.message
            });
        }
    }
);

app.delete('/admin/users/:key',
    adminLimiter,
    requireMasterKey,
    async (req, res) => {
        try {
            const userKey = req.params.key;
            const data = await loadUsers();
            
            if (!data.users[userKey]) {
                return res.status(404).json({
                    error: 'USER_NOT_FOUND',
                    message: 'User key not found'
                });
            }

            delete data.users[userKey];
            await saveUsers(data);

            store.donations.delete(userKey);
            store.queues.delete(userKey);
            store.processedIds.delete(userKey);
            store.timestamps.delete(userKey);
            store.userStats.delete(userKey);

            res.json({
                success: true,
                message: 'User deleted successfully'
            });
        } catch (err) {
            res.status(500).json({
                error: 'DELETE_FAILED',
                message: err.message
            });
        }
    }
);

app.get('/stats', globalLimiter, (req, res) => {
    let totalQueued = 0;
    const queueDetails = {};
    
    for (const [userKey, queue] of store.queues.entries()) {
        totalQueued += queue.length;
        if (queue.length > 0) {
            queueDetails[userKey] = queue.length;
        }
    }
    
    res.json({
        active_donations: store.donations.size,
        total_queued: totalQueued,
        users_with_queue: Object.keys(queueDetails).length,
        uptime_seconds: Math.floor(process.uptime()),
        memory_usage: process.memoryUsage(),
        queue_details: queueDetails
    });
});

app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

const DONATION_TIMEOUT = 60000;

setInterval(() => {
    const now = Date.now();
    
    for (const [userKey, timestamp] of store.timestamps.entries()) {
        const elapsed = now - timestamp;
        if (elapsed > DONATION_TIMEOUT && store.donations.has(userKey)) {
            store.donations.delete(userKey);
            promoteFromQueue(userKey);
        }
    }
    
    for (const [userKey, processedList] of store.processedIds.entries()) {
        const filtered = processedList.filter(item => 
            (now - item.timestamp) < DUPLICATE_WINDOW
        );
        
        if (filtered.length === 0) {
            store.processedIds.delete(userKey);
        } else {
            store.processedIds.set(userKey, filtered);
        }
    }
    
    if (Math.random() < 0.01) {
        store.cleanupInactiveUsers();
    }
}, 10000);

app.use((err, req, res, next) => {
    console.error('❌ Server error:', err);
    res.status(500).json({ 
        error: 'INTERNAL_SERVER_ERROR',
        message: 'An unexpected error occurred'
    });
});

app.use((req, res) => {
    res.status(404).json({ 
        error: 'NOT_FOUND',
        message: 'Endpoint not found'
    });
});

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📝 Webhook endpoint: /donation/:key/webhook`);
    console.log(`🔍 Health check: /health`);
});
