const express = require('express');
const app = express();
const PORT = 8080;

// ════════════════════════════════════════════════════════════
// 🔒 BASIC CONFIGURATION
// ════════════════════════════════════════════════════════════

app.use(express.json({ limit: '100kb' }));

// ═══════════════════════════════════════════════════════════
// 🗂️ STORAGE PER USER - UNLIMITED QUEUE!
// ═══════════════════════════════════════════════════════════

let donations = {};
let timestamps = {};
let donationQueue = {}; // UNLIMITED QUEUE!
let processedIds = {};

// MINIMAL RESTRICTIONS - BIAR GAK ABUSE
const MIN_DONATION_INTERVAL = 100;  // 0.1 detik aja (super cepet!)
const DONATION_TIMEOUT = 60000;     // 60 detik
const DUPLICATE_CHECK_WINDOW = 5000; // 5 detik doang

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
// 🆔 GENERATE UNIQUE DONATION ID
// ════════════════════════════════════════════════════════════

function generateDonationId(donation) {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substr(2, 9);
    const name = (donation.donor_name || 'anon').toLowerCase().replace(/\s/g, '');
    const amount = donation.amount || 0;
    const platform = donation.platform || 'unknown';
    
    return `${platform}_${name}_${amount}_${timestamp}_${random}`;
}

// ════════════════════════════════════════════════════════════
// 🔍 CHECK IF DONATION IS DUPLICATE (VERY LOOSE)
// ════════════════════════════════════════════════════════════

function isDuplicate(userKey, donation) {
    if (!processedIds[userKey]) {
        return false;
    }
    
    const now = Date.now();
    const recentDonations = processedIds[userKey].filter(item => {
        return (now - item.timestamp) < DUPLICATE_CHECK_WINDOW;
    });
    
    // Only block EXACT duplicates in last 5 seconds
    const isDupe = recentDonations.some(item => {
        const timeDiff = now - item.timestamp;
        return item.platform === donation.platform &&
               item.donor_name === donation.donor_name &&
               item.amount === donation.amount &&
               timeDiff < 3000; // 3 detik doang
    });
    
    return isDupe;
}

// ════════════════════════════════════════════════════════════
// 📝 MARK DONATION AS PROCESSED
// ════════════════════════════════════════════════════════════

function markAsProcessed(userKey, donation) {
    if (!processedIds[userKey]) {
        processedIds[userKey] = [];
    }
    
    processedIds[userKey].push({
        platform: donation.platform,
        donor_name: donation.donor_name,
        amount: donation.amount,
        timestamp: Date.now()
    });
    
    // Keep only last 50 entries (lebih banyak!)
    if (processedIds[userKey].length > 50) {
        processedIds[userKey] = processedIds[userKey].slice(-50);
    }
}

// ════════════════════════════════════════════════════════════
// 📥 UNLIMITED QUEUE MANAGEMENT
// ════════════════════════════════════════════════════════════

function addToQueue(userKey, donation) {
    if (!donationQueue[userKey]) {
        donationQueue[userKey] = [];
    }
    
    // NO LIMIT! TERIMA SEMUA!
    const donationId = generateDonationId(donation);
    donationQueue[userKey].push({
        id: donationId,
        data: donation,
        timestamp: Date.now()
    });
    
    console.log(`📥 [${userKey}] Added to queue. Queue size: ${donationQueue[userKey].length} 🚀`);
    
    // Auto-promote if no active donation
    if (!donations[userKey]) {
        promoteFromQueue(userKey);
    }
}

function promoteFromQueue(userKey) {
    if (!donationQueue[userKey] || donationQueue[userKey].length === 0) {
        return false;
    }
    
    const next = donationQueue[userKey].shift();
    donations[userKey] = next.data;
    timestamps[userKey] = Date.now();
    
    console.log(`⬆️ [${userKey}] Promoted from queue:`, next.data.donor_name, '-', next.data.amount, 'IDR');
    console.log(`   💰 Remaining in queue: ${donationQueue[userKey].length}`);
    
    return true;
}

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
// 📨 UNLIMITED WEBHOOK - TERIMA SEMUA!
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
    
    // VERY LIGHT duplicate check (cuma yang bener2 sama dalam 3 detik)
    if (isDuplicate(userKey, donation)) {
        console.log('⚠️ Exact duplicate in last 3s, ignoring');
        console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
        return res.status(200).json({ 
            success: true, 
            message: 'Duplicate',
            queued: false 
        });
    }
    
    console.log('✅ Donation accepted:');
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
    
    // If there's already an active donation, ALWAYS QUEUE
    if (donations[userKey]) {
        console.log('   📥 Queuing (active donation exists)');
        addToQueue(userKey, donation);
        markAsProcessed(userKey, donation);
        console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
        return res.status(200).json({ 
            success: true, 
            queued: true,
            queuePosition: donationQueue[userKey]?.length || 0
        });
    }
    
    // Save as active donation
    donations[userKey] = donation;
    timestamps[userKey] = Date.now();
    markAsProcessed(userKey, donation);
    
    console.log('   ✅ Set as active donation');
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
    
    res.status(200).json({ success: true, queued: false });
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
// 🗑️ ROBLOX - CLEAR DONATION (AUTO-PROMOTE!)
// ════════════════════════════════════════════════════════════

app.delete('/donation/:key/clear', (req, res) => {
    const userKey = req.params.key;
    
    if (!donations[userKey]) {
        return res.status(404).json({ error: 'NO_DONATION' });
    }
    
    console.log(`🗑️ [${userKey}] Cleared:`, donations[userKey].donor_name);
    delete donations[userKey];
    
    // Auto-promote next donation from queue
    const promoted = promoteFromQueue(userKey);
    
    const queueSize = donationQueue[userKey]?.length || 0;
    if (queueSize > 0) {
        console.log(`   💰 ${queueSize} donations still in queue!`);
    }
    
    res.json({ 
        success: true,
        promoted: promoted,
        queueSize: queueSize
    });
});

// ════════════════════════════════════════════════════════════
// 🔧 ADMIN ENDPOINTS
// ════════════════════════════════════════════════════════════

app.get('/donation/:key/status', (req, res) => {
    const userKey = req.params.key;
    
    res.json({
        has_pending: !!donations[userKey],
        donation: donations[userKey] || null,
        queue_size: donationQueue[userKey]?.length || 0,
        queue: donationQueue[userKey] || [],
        last_timestamp: timestamps[userKey] || null,
        override_enabled: USER_OVERRIDES[userKey]?.enabled || false,
        processed_count: processedIds[userKey]?.length || 0
    });
});

app.post('/donation/:key/force-clear', (req, res) => {
    const userKey = req.params.key;
    
    const cleared = {
        donation: !!donations[userKey],
        queue: donationQueue[userKey]?.length || 0
    };
    
    if (donations[userKey]) {
        console.log(`🔨 [${userKey}] Force clearing donation`);
        delete donations[userKey];
        delete timestamps[userKey];
    }
    
    if (donationQueue[userKey]) {
        console.log(`🔨 [${userKey}] Force clearing queue (${donationQueue[userKey].length} items)`);
        delete donationQueue[userKey];
    }
    
    res.json({ success: true, cleared });
});

// ════════════════════════════════════════════════════════════
// 🧹 AUTO-CLEANUP (MINIMAL)
// ════════════════════════════════════════════════════════════

setInterval(() => {
    const now = Date.now();
    
    // Cleanup VERY stuck donations only (60s+)
    for (const userKey in timestamps) {
        const elapsed = now - timestamps[userKey];
        
        if (elapsed > DONATION_TIMEOUT && donations[userKey]) {
            console.log(`⚠️ [${userKey}] Auto-clearing stuck donation (${Math.floor(elapsed/1000)}s old)`);
            delete donations[userKey];
            
            // Auto-promote from queue
            promoteFromQueue(userKey);
        }
    }
    
    // Cleanup old processed IDs (keep memory clean)
    for (const userKey in processedIds) {
        processedIds[userKey] = processedIds[userKey].filter(item => {
            return (now - item.timestamp) < DUPLICATE_CHECK_WINDOW;
        });
        
        if (processedIds[userKey].length === 0) {
            delete processedIds[userKey];
        }
    }
}, 10000); // Check every 10 seconds

// ════════════════════════════════════════════════════════════
// 📊 STATS ENDPOINT
// ════════════════════════════════════════════════════════════

app.get('/stats', (req, res) => {
    const stats = {
        active_donations: Object.keys(donations).length,
        total_queued: Object.values(donationQueue).reduce((sum, q) => sum + q.length, 0),
        users_with_queue: Object.keys(donationQueue).length,
        total_processed: Object.values(processedIds).reduce((sum, arr) => sum + arr.length, 0),
        uptime: process.uptime(),
        queue_details: {}
    };
    
    // Detail per user
    for (const userKey in donationQueue) {
        stats.queue_details[userKey] = donationQueue[userKey].length;
    }
    
    res.json(stats);
});

// ════════════════════════════════════════════════════════════
// 🚀 START SERVER
// ════════════════════════════════════════════════════════════

app.listen(PORT, () => {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🚀 UNLIMITED DONATION SERVER - PRODUCTION MODE');
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
    console.log('📊 Stats:   GET  /stats');
    console.log('');
    console.log('💎 UNLIMITED FEATURES:');
    console.log('   • NO queue size limit!');
    console.log('   • NO rate limiting!');
    console.log('   • Minimal duplicate check (3s exact match only)');
    console.log('   • Super fast processing (100ms interval)');
    console.log('   • Auto-promotion from queue');
    console.log('   • Spam-friendly! 🎉');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
});
