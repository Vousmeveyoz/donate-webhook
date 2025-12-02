const express = require('express');
const app = express();
const PORT = 8080;

// ════════════════════════════════════════════════════════════
// 🔒 BASIC CONFIGURATION
// ════════════════════════════════════════════════════════════

app.use(express.json({ limit: '100kb' }));

// ═══════════════════════════════════════════════════
// 🗂️ STORAGE PER USER
// ═══════════════════════════════════════════════════

let donations = {}; // { userKey: donationData }
let timestamps = {}; // { userKey: lastTimestamp }

// Anti-spam settings
const MIN_DONATION_INTERVAL = 2000; // 2 seconds
const DONATION_TIMEOUT = 30000; // 30 seconds

// ════════════════════════════════════════════════════════════
// 🎨 OVERRIDE SETTINGS (Per User)
// ════════════════════════════════════════════════════════════

const USER_OVERRIDES = {
    "1PJQ-WNSE-ZAN7-OKNW": {
        enabled: true,
        donor_name: 'BLOKMARKET',
        message: 'LANGSUNG AJA ORDER DI BLOKMARKET'
    }
};

// ════════════════════════════════════════════════════════════
// 🎯 WEBHOOK PARSERS (FIXED - Updated for Real Formats)
// ════════════════════════════════════════════════════════════

function parseSaweria(data) {
    return {
        platform: 'saweria',
        donor_name: data.donator_name || 'Anonymous',
        amount: data.amount_raw || data.etc?.amount_to_display || 0,
        message: data.message || ''
    };
}

function parseSociabuzz(data) {
    // ✅ FIXED: SociaBuzz uses 'supporter' not 'supporter_name'
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
// 🔍 AUTO-DETECT PLATFORM (FIXED - Better Detection)
// ════════════════════════════════════════════════════════════

function autoDetectPlatform(data) {
    console.log('\n📦 Webhook received');
    console.log('Keys:', Object.keys(data).join(', '));
    
    // ✅ PRIORITY 1: Saweria - has 'version' + 'donator_name'
    if (data.version && data.donator_name) {
        console.log('✅ Detected: SAWERIA (version + donator_name)');
        return parseSaweria(data);
    }
    
    // ✅ PRIORITY 2: SociaBuzz - has 'supporter' + 'email_supporter' + 'currency'
    // This is the most specific SociaBuzz identifier
    if (data.supporter && (data.email_supporter || data.currency === 'IDR')) {
        console.log('✅ Detected: SOCIABUZZ (supporter + email/currency)');
        return parseSociabuzz(data);
    }
    
    // ✅ PRIORITY 3: Check for 'content' object with sociabuzz link
    if (data.content && data.content.link && data.content.link.includes('sociabuzz.com')) {
        console.log('✅ Detected: SOCIABUZZ (content link)');
        return parseSociabuzz(data);
    }
    
    // ✅ PRIORITY 4: Check explicit platform field
    const platform = (data.platform || data.type || '').toLowerCase();
    
    if (platform === 'sociabuzz') {
        console.log('✅ Detected: SOCIABUZZ (explicit platform)');
        return parseSociabuzz(data);
    }
    
    if (platform === 'trakteer') {
        console.log('✅ Detected: TRAKTEER (explicit platform)');
        return parseTrakteer(data);
    }
    
    if (platform === 'tako') {
        console.log('✅ Detected: TAKO (explicit platform)');
        return parseTako(data);
    }
    
    // ✅ PRIORITY 5: Check URL field
    if (data.url) {
        if (data.url.includes('sociabuzz')) {
            console.log('✅ Detected: SOCIABUZZ (url)');
            return parseSociabuzz(data);
        }
        if (data.url.includes('trakteer')) {
            console.log('✅ Detected: TRAKTEER (url)');
            return parseTrakteer(data);
        }
        if (data.url.includes('saweria')) {
            console.log('✅ Detected: SAWERIA (url)');
            return parseSaweria(data);
        }
    }
    
    // ✅ PRIORITY 6: Fallback by specific field combinations
    
    // Trakteer typically has 'supporter_name' + 'price'
    if (data.supporter_name && data.price) {
        console.log('⚠️ Fallback: TRAKTEER (supporter_name + price)');
        return parseTrakteer(data);
    }
    
    // SociaBuzz has 'supporter' (not supporter_name)
    if (data.supporter && data.amount) {
        console.log('⚠️ Fallback: SOCIABUZZ (supporter + amount)');
        return parseSociabuzz(data);
    }
    
    // Saweria has 'donator_name'
    if (data.donator_name) {
        console.log('⚠️ Fallback: SAWERIA (donator_name)');
        return parseSaweria(data);
    }
    
    // Generic: has 'supporter_name'
    if (data.supporter_name) {
        console.log('⚠️ Fallback: TRAKTEER (supporter_name generic)');
        return parseTrakteer(data);
    }
    
    // Last resort: if has 'name' and 'amount'
    if (data.name && data.amount) {
        console.log('⚠️ Fallback: SOCIABUZZ (generic name + amount)');
        return parseSociabuzz(data);
    }
    
    console.log('❌ Could not detect platform');
    console.log('Data:', JSON.stringify(data));
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
    
    // Parse donation
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
            console.log(`⚠️ Rate limited (${elapsed}ms < ${MIN_DONATION_INTERVAL}ms)`);
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
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
    
    res.status(200).json({ success: true });
});

// ════════════════════════════════════════════════════════════
// 🎮 ROBLOX - GET DONATION
// ════════════════════════════════════════════════════════════

app.get('/donation/:key/data', (req, res) => {
    const userKey = req.params.key;
    
    if (!donations[userKey]) {
        return res.status(204).send(); // No content
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
        console.log(`🎨 [${userKey}] Override applied: ${override.donor_name}`);
    }
    
    console.log(`📤 [${userKey}] Sending to Roblox:`, donationToSend.donor_name, '-', donationToSend.amount, 'IDR');
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
// 🧪 TEST ENDPOINTS
// ════════════════════════════════════════════════════════════

app.post('/donation/:key/test/:platform', (req, res) => {
    const userKey = req.params.key;
    const platform = req.params.platform;
    
    let testData;
    
    switch(platform) {
        case 'saweria':
            testData = {
                version: "1.0",
                donator_name: "Test Saweria",
                amount_raw: 10000,
                message: "Test donation"
            };
            break;
            
        case 'sociabuzz':
            testData = {
                supporter: "Test SociaBuzz",
                email_supporter: "test@example.com",
                amount: 15000,
                currency: "IDR",
                message: "Test donation",
                content: {
                    link: "https://sociabuzz.com/test"
                }
            };
            break;
            
        case 'trakteer':
            testData = {
                type: "trakteer",
                supporter_name: "Test Trakteer",
                amount: 20000,
                supporter_message: "Test donation"
            };
            break;
            
        case 'tako':
            testData = {
                type: "tako",
                supporter_name: "Test Tako",
                amount: 25000,
                message: "Test donation"
            };
            break;
            
        default:
            return res.status(400).json({ error: 'INVALID_PLATFORM' });
    }
    
    const donation = autoDetectPlatform(testData);
    
    if (!donation) {
        return res.status(500).json({ error: 'TEST_FAILED' });
    }
    
    donations[userKey] = donation;
    timestamps[userKey] = Date.now();
    
    console.log(`\n🧪 [${userKey}] TEST DONATION CREATED`);
    console.log('   Platform:', donation.platform);
    console.log('   Donor:', donation.donor_name);
    console.log('   Amount:', donation.amount, 'IDR\n');
    
    res.json({
        success: true,
        donation: donation
    });
});

// Debug endpoint - shows raw data
app.post('/donation/:key/debug', (req, res) => {
    const userKey = req.params.key;
    
    console.log(`\n🔍 [${userKey}] DEBUG WEBHOOK`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(JSON.stringify(req.body, null, 2));
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    
    const donation = autoDetectPlatform(req.body);
    
    res.json({
        received: req.body,
        parsed: donation,
        valid: !!donation
    });
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
}, 10000); // Check every 10 seconds

// ════════════════════════════════════════════════════════════
// 🚀 START SERVER
// ════════════════════════════════════════════════════════════

app.listen(PORT, () => {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🚀 MULTI-PLATFORM DONATION SERVER - ACTIVE');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`📡 Server: http://localhost:${PORT}`);
    console.log('');
    console.log('🎯 Supported Platforms:');
    console.log('   • Saweria');
    console.log('   • SociaBuzz');
    console.log('   • Trakteer');
    console.log('   • Tako');
    console.log('');
    console.log('📨 Main Webhook (set di platform):');
    console.log('   POST /donation/:key/webhook');
    console.log('');
    console.log('🎮 Roblox Endpoints:');
    console.log('   GET  /donation/:key/data  (polling)');
    console.log('   DELETE /donation/:key/clear');
    console.log('');
    console.log('🧪 Test Endpoints:');
    console.log('   POST /donation/:key/test/saweria');
    console.log('   POST /donation/:key/test/sociabuzz');
    console.log('   POST /donation/:key/test/trakteer');
    console.log('   POST /donation/:key/test/tako');
    console.log('');
    console.log('🔧 Admin:');
    console.log('   GET  /donation/:key/status');
    console.log('   POST /donation/:key/debug  (debug webhook)');
    console.log('   POST /donation/:key/force-clear');
    console.log('');
    console.log('⚠️  Jangan lupa: ngrok http 8080');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
});