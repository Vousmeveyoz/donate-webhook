const express = require('express');
const app = express();
const PORT = 8080;

// ════════════════════════════════════════════════════════════
// 🔒 BASIC CONFIGURATION
// ════════════════════════════════════════════════════════════

app.use(express.json({ limit: '100kb' }));

// ═══════════════════════════════════════════════════════════
// 🗂️ STORAGE PER USER
// ═══════════════════════════════════════════════════════════

let donations = {};
let timestamps = {};

// Anti-spam settings
const MIN_DONATION_INTERVAL = 2000; // 2 seconds
const DONATION_TIMEOUT = 30000; // 30 seconds

// ════════════════════════════════════════════════════════════
// 🎨 OVERRIDE SETTINGS (Per User)
// ════════════════════════════════════════════════════════════

const USER_OVERRIDES = {
    "1PJQ-WNSE-ZAN7-OKNW": {
        enabled: false,
        donor_name: 'BLOKMARKET',
        message: 'LANGSUNG AJA ORDER DI BLOKMARKET'
    }
};

// ════════════════════════════════════════════════════════════
// 🎯 WEBHOOK PARSERS (All Platforms + BagiBagi)
// ════════════════════════════════════════════════════════════

function parseBagiBagi(data) {
    return {
        platform: 'bagibagi',
        donor_name: data.donor_name || 'BagiBagi Donor',
        amount: data.amount || 0,
        message: data.message || '',
        transaction_id: data.transaction_id || 'unknown',
        koin: data.koin || 0
    };
}

function parseSaweria(data) {
    return {
        platform: 'saweria',
        donor_name: data.donator_name || data.donatur_name || 'Anonymous',
        amount: data.amount_raw || data.amount || data.etc?.amount_to_display || 0,
        message: data.message || data.donator_message || ''
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
    return {
        platform: 'trakteer',
        donor_name: data.supporter_name || data.name || 'Anonymous',
        amount: data.amount || data.price || 0,
        message: data.supporter_message || data.message || ''
    };
}

function parseTako(data) {
    return {
        platform: 'tako',
        donor_name: data.supporter_name || data.donator_name || data.name || 'Anonymous',
        amount: data.amount || data.amount_raw || 0,
        message: data.message || data.supporter_message || ''
    };
}

// ════════════════════════════════════════════════════════════
// 🔍 AUTO-DETECT PLATFORM
// ════════════════════════════════════════════════════════════

function autoDetectPlatform(data) {
    // BagiBagi - check platform field or transaction_id
    if (data.platform === 'bagibagi' || data.transaction_id) {
        return parseBagiBagi(data);
    }
    
    // Saweria - has 'version' + 'donator_name' or 'donatur_name'
    if (data.version && (data.donator_name || data.donatur_name)) {
        return parseSaweria(data);
    }
    
    // Saweria - donator_name field
    if (data.donator_name || data.donatur_name) {
        return parseSaweria(data);
    }
    
    // SociaBuzz - has 'supporter' + 'email_supporter' or 'currency'
    if (data.supporter && (data.email_supporter || data.currency === 'IDR')) {
        return parseSociabuzz(data);
    }
    
    // SociaBuzz - content link
    if (data.content && data.content.link && data.content.link.includes('sociabuzz.com')) {
        return parseSociabuzz(data);
    }
    
    // Check explicit platform field
    const platform = (data.platform || data.type || '').toLowerCase();
    
    if (platform === 'sociabuzz') {
        return parseSociabuzz(data);
    }
    
    if (platform === 'saweria') {
        return parseSaweria(data);
    }
    
    if (platform === 'trakteer') {
        return parseTrakteer(data);
    }
    
    if (platform === 'tako') {
        return parseTako(data);
    }
    
    // Check URL field
    if (data.url) {
        if (data.url.includes('sociabuzz')) {
            return parseSociabuzz(data);
        }
        if (data.url.includes('trakteer')) {
            return parseTrakteer(data);
        }
        if (data.url.includes('saweria')) {
            return parseSaweria(data);
        }
    }
    
    // Fallback by field combinations
    if (data.supporter_name && data.price) {
        return parseTrakteer(data);
    }
    
    if (data.supporter && data.amount) {
        return parseSociabuzz(data);
    }
    
    if (data.supporter_name) {
        return parseTrakteer(data);
    }
    
    if (data.name && data.amount) {
        return parseSociabuzz(data);
    }
    
    return null;
}

// ════════════════════════════════════════════════════════════
// 📨 MULTI USER WEBHOOK
// ════════════════════════════════════════════════════════════

app.post('/donation/:key/webhook', (req, res) => {
    const userKey = req.params.key;
    const data = req.body;
    
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`📨 [${userKey}] Webhook received`);
    console.log(`🕒 ${new Date().toLocaleString()}`);
    
    const donation = autoDetectPlatform(data);
    
    if (!donation) {
        console.log('❌ Failed to parse donation');
        console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
        return res.status(400).json({ error: 'INVALID_DONATION_DATA' });
    }
    
    if (!donation.amount || donation.amount <= 0) {
        console.log('❌ Invalid amount:', donation.amount);
        console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
        return res.status(400).json({ error: 'INVALID_AMOUNT' });
    }
    
    // Anti-spam check
    if (timestamps[userKey]) {
        const elapsed = Date.now() - timestamps[userKey];
        if (elapsed < MIN_DONATION_INTERVAL) {
            console.log(`⚠️ Rate limited (${elapsed}ms)`);
            console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
            return res.status(429).json({ error: 'RATE_LIMITED' });
        }
    }
    
    // Check duplicate
    if (donations[userKey]) {
        const pending = donations[userKey];
        if (pending.platform === donation.platform &&
            pending.donor_name === donation.donor_name &&
            pending.amount === donation.amount) {
            console.log('⚠️ Duplicate pending donation');
            console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
            return res.status(429).json({ error: 'DUPLICATE_PENDING' });
        }
    }
    
    // Save donation
    donations[userKey] = donation;
    timestamps[userKey] = Date.now();
    
    console.log('✅ Donation saved:');
    console.log('   Platform:', donation.platform);
    console.log('   Donor:', donation.donor_name);
    console.log('   Amount:', donation.amount, 'IDR');
    console.log('   Message:', donation.message || '(no message)');
    if (donation.transaction_id) {
        console.log('   Transaction ID:', donation.transaction_id);
    }
    if (donation.koin) {
        console.log('   Koin:', donation.koin);
    }
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
    
    res.status(200).json({ success: true });
});

// ════════════════════════════════════════════════════════════
// 🎮 ROBLOX - GET DONATION
// ════════════════════════════════════════════════════════════

app.get('/donation/:key/data', (req, res) => {
    const userKey = req.params.key;
    
    if (!donations[userKey]) {
        return res.status(204).send();
    }
    
    let donationToSend = donations[userKey];
    
    // Apply override if configured
    const override = USER_OVERRIDES[userKey];
    if (override && override.enabled) {
        donationToSend = {
            platform: donationToSend.platform,
            donor_name: override.donor_name,
            amount: donationToSend.amount,
            message: override.message
        };
        console.log(`🎨 [${userKey}] Override applied`);
    }
    
    console.log(`📤 [${userKey}] Sending:`, donationToSend.donor_name, '-', donationToSend.amount, 'IDR');
    res.json(donationToSend);
});

// ════════════════════════════════════════════════════════════
// 🗑️ ROBLOX - CLEAR DONATION
// ════════════════════════════════════════════════════════════

app.delete('/donation/:key/clear', (req, res) => {
    const userKey = req.params.key;
    
    if (!donations[userKey]) {
        return res.status(404).json({ error: 'NO_DONATION' });
    }
    
    console.log(`🗑️ [${userKey}] Cleared:`, donations[userKey].donor_name);
    delete donations[userKey];
    delete timestamps[userKey];
    
    res.json({ success: true });
});

// ════════════════════════════════════════════════════════════
// 🔧 ADMIN ENDPOINTS
// ════════════════════════════════════════════════════════════

app.get('/donation/:key/status', (req, res) => {
    const userKey = req.params.key;
    
    res.json({
        has_pending: !!donations[userKey],
        donation: donations[userKey] || null,
        last_timestamp: timestamps[userKey] || null,
        override_enabled: USER_OVERRIDES[userKey]?.enabled || false
    });
});

app.post('/donation/:key/force-clear', (req, res) => {
    const userKey = req.params.key;
    
    if (donations[userKey]) {
        console.log(`🔨 [${userKey}] Force clearing`);
        delete donations[userKey];
        delete timestamps[userKey];
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'NO_DONATION' });
    }
});

// ════════════════════════════════════════════════════════════
// 🧹 AUTO-CLEANUP
// ════════════════════════════════════════════════════════════

setInterval(() => {
    const now = Date.now();
    
    for (const userKey in timestamps) {
        const elapsed = now - timestamps[userKey];
        
        if (elapsed > DONATION_TIMEOUT && donations[userKey]) {
            console.log(`⚠️ [${userKey}] Auto-clearing stuck donation (${Math.floor(elapsed/1000)}s old)`);
            delete donations[userKey];
            delete timestamps[userKey];
        }
    }
}, 10000);

// ════════════════════════════════════════════════════════════
// 🚀 START SERVER
// ════════════════════════════════════════════════════════════

app.listen(PORT, () => {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🚀 MULTI-PLATFORM DONATION SERVER - PRODUCTION');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`📡 Server: http://localhost:${PORT}`);
    console.log('');
    console.log('🎯 Supported: BagiBagi • Saweria • SociaBuzz • Trakteer • Tako');
    console.log('');
    console.log('📨 Webhook: POST /donation/:key/webhook');
    console.log('🎮 Roblox:  GET  /donation/:key/data');
    console.log('           DELETE /donation/:key/clear');
    console.log('');
    console.log('🔧 Admin:   GET  /donation/:key/status');
    console.log('           POST /donation/:key/force-clear');
    console.log('');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
});
