const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    isJidBroadcast,
} = require('@whiskeysockets/baileys');

const pino = require('pino');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ─────────────────────────────────────────
// SESSION STORE
// ─────────────────────────────────────────
const sessions = {};
const sessionStatus = {};

// SESSION_DIR: use env var for Railway Volume support
// On Railway: set SESSION_DIR=/data in environment variables + mount a Volume at /data
// On VPS: leave unset, defaults to ./sessions
const SESSION_DIR = process.env.SESSION_DIR || path.join(__dirname, 'sessions');
if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
}

// ─────────────────────────────────────────
// CREATE SESSION
// ─────────────────────────────────────────
async function createSession(userId, sessionNum = 1) {
    const key = `${userId}_${sessionNum}`;
    const sessionPath = path.join(SESSION_DIR, key);

    if (sessions[key] && sessionStatus[key] === 'connected') {
        return sessions[key];
    }

    if (!fs.existsSync(sessionPath)) {
        fs.mkdirSync(sessionPath, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();
    const logger = pino({ level: 'silent' });

    const sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        printQRInTerminal: false,
        logger,
        generateHighQualityLinkPreview: false,
        shouldIgnoreJid: jid => isJidBroadcast(jid),
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'open') {
            console.log(`✅ Session ${key} connected!`);
            sessionStatus[key] = 'connected';
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode
                !== DisconnectReason.loggedOut;

            console.log(`❌ Session ${key} closed. Reconnect: ${shouldReconnect}`);
            sessionStatus[key] = 'disconnected';

            if (shouldReconnect) {
                setTimeout(() => createSession(userId, sessionNum), 5000);
            } else {
                sessions[key] = null;
                sessionStatus[key] = 'logged_out';
                try { fs.rmSync(sessionPath, { recursive: true }); } catch (e) {}
            }
        }
    });

    sessions[key] = sock;
    sessionStatus[key] = 'connecting';
    return sock;
}

// ─────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────
function getJid(number) {
    const clean = number.replace(/\D/g, '');
    return `${clean}@s.whatsapp.net`;
}

function getGroupJid(groupId) {
    if (groupId.includes('@')) return groupId;
    return `${groupId}@g.us`;
}

async function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// ─────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────

// Health Check
app.get('/', (req, res) => {
    res.json({
        status: 'running',
        message: 'WhatsApp API Server ✅',
        activeSessions: Object.keys(sessions).length,
        uptime: Math.floor(process.uptime()),
    });
});

// /health — Railway health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', uptime: Math.floor(process.uptime()) });
});

// /sessions — list all active sessions (debug)
app.get('/sessions', (req, res) => {
    const list = Object.entries(sessionStatus).map(([key, status]) => ({
        key,
        status,
        phone: sessions[key]?.user?.id?.split(':')[0] || null,
    }));
    res.json({ sessions: list });
});

// ── PAIR ──────────────────────────────────
app.post('/pair', async (req, res) => {
    try {
        const { phone, user_id, session = 1 } = req.body;
        console.log(`📱 Pair request: ${phone}`);

        const sock = await createSession(user_id, session);
        await sleep(3000);

        const code = await sock.requestPairingCode(phone);
        console.log(`🔑 Code: ${code}`);

        res.json({ success: true, code });
    } catch (err) {
        console.error('Pair error:', err.message);
        res.json({ success: false, error: err.message });
    }
});

// ── STATUS ────────────────────────────────
app.get('/status/:userId/:session', (req, res) => {
    const { userId, session } = req.params;
    const key = `${userId}_${session}`;
    const status = sessionStatus[key] || 'not_started';

    res.json({
        connected: status === 'connected',
        status,
        phone: sessions[key]?.user?.id?.split(':')[0] || null,
    });
});

// ── GET GROUPS ────────────────────────────
app.get('/groups/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const { admin_only } = req.query;
        const sock = sessions[`${userId}_1`];

        if (!sock || sessionStatus[`${userId}_1`] !== 'connected') {
            return res.json({ success: false, error: 'Not connected', groups: [] });
        }

        const groups = await sock.groupFetchAllParticipating();
        const myId = sock.user.id;

        let list = Object.values(groups).map(g => {
            const me = g.participants.find(
                p => p.id === myId || p.id.startsWith(myId.split(':')[0])
            );
            const isAdmin = me?.admin === 'admin' || me?.admin === 'superadmin';
            return {
                id: g.id,
                name: g.subject,
                member_count: g.participants.length,
                is_admin: isAdmin,
            };
        });

        if (admin_only === 'true') {
            list = list.filter(g => g.is_admin);
        }

        res.json({ success: true, groups: list });
    } catch (err) {
        res.json({ success: false, error: err.message, groups: [] });
    }
});

// ── GET GROUP LINKS ───────────────────────
app.get('/groups/:userId/links', async (req, res) => {
    try {
        const { userId } = req.params;
        const { filter } = req.query;
        const sock = sessions[`${userId}_1`];
        if (!sock) return res.json({ success: false, groups: [] });

        const groups = await sock.groupFetchAllParticipating();
        const result = [];

        for (const [id, g] of Object.entries(groups)) {
            if (filter && !g.subject.toLowerCase().includes(filter.toLowerCase())) continue;
            try {
                const link = await sock.groupInviteCode(id);
                result.push({
                    id,
                    name: g.subject,
                    invite_link: `https://chat.whatsapp.com/${link}`,
                });
                await sleep(300);
            } catch (e) {
                result.push({ id, name: g.subject, invite_link: 'N/A' });
            }
        }

        res.json({ success: true, groups: result });
    } catch (err) {
        res.json({ success: false, error: err.message, groups: [] });
    }
});

// ── CREATE GROUP ──────────────────────────
app.post('/group/create', async (req, res) => {
    try {
        const { user_id, name, description, friends = [], permissions = {}, disappearing = 0 } = req.body;
        const sock = sessions[`${user_id}_1`];
        if (!sock) return res.json({ success: false, error: 'Not connected' });

        const myNumber = sock.user.id.split(':')[0];
        const participants = friends.length > 0
            ? friends.map(n => getJid(n))
            : [getJid(myNumber)];

        const result = await sock.groupCreate(name, participants);
        const groupId = result.id;
        await sleep(1000);

        if (description) {
            try { await sock.groupUpdateDescription(groupId, description); await sleep(500); } catch (e) {}
        }
        if (permissions.msg === false) {
            try { await sock.groupSettingUpdate(groupId, 'announcement'); await sleep(300); } catch (e) {}
        }
        if (permissions.approval === true) {
            try { await sock.groupSettingUpdate(groupId, 'membership_approval_mode'); await sleep(300); } catch (e) {}
        }
        if (disappearing > 0) {
            try { await sock.groupToggleEphemeral(groupId, disappearing); await sleep(300); } catch (e) {}
        }

        res.json({ success: true, group_id: groupId });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// ── JOIN GROUP ────────────────────────────
app.post('/group/join', async (req, res) => {
    try {
        const { user_id, link } = req.body;
        const sock = sessions[`${user_id}_1`];
        if (!sock) return res.json({ success: false, error: 'Not connected' });

        const code = link.split('/').pop().trim();
        await sock.groupAcceptInvite(code);
        res.json({ success: true });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// ── LEAVE GROUP ───────────────────────────
app.post('/group/leave', async (req, res) => {
    try {
        const { user_id, group_id } = req.body;
        const sock = sessions[`${user_id}_1`];
        if (!sock) return res.json({ success: false, error: 'Not connected' });

        await sock.groupLeave(getGroupJid(group_id));
        res.json({ success: true });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// ── ADD MEMBERS ───────────────────────────
app.post('/group/add', async (req, res) => {
    try {
        const { user_id, link, numbers, mode = 'one_by_one' } = req.body;
        const sock = sessions[`${user_id}_1`];
        if (!sock) return res.json({ success: false, error: 'Not connected' });

        const code = link.split('/').pop().trim();
        const info = await sock.groupGetInviteInfo(code);
        const groupId = info.id;

        let successCount = 0;
        let failedCount = 0;

        if (mode === 'together') {
            const participants = numbers.map(n => getJid(n));
            const result = await sock.groupParticipantsUpdate(groupId, participants, 'add');
            result.forEach(r => {
                if (r.status === '200') successCount++;
                else failedCount++;
            });
        } else {
            for (const num of numbers) {
                try {
                    const result = await sock.groupParticipantsUpdate(
                        groupId, [getJid(num)], 'add'
                    );
                    if (result[0]?.status === '200') successCount++;
                    else failedCount++;
                } catch (e) { failedCount++; }
                await sleep(2000);
            }
        }

        res.json({ success: true, added: successCount, failed: failedCount });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// ── REMOVE ALL ────────────────────────────
app.post('/group/remove_all', async (req, res) => {
    try {
        const { user_id, group_id, exclude = [] } = req.body;
        const sock = sessions[`${user_id}_1`];
        if (!sock) return res.json({ success: false, error: 'Not connected' });

        const gId = getGroupJid(group_id);
        const meta = await sock.groupMetadata(gId);
        const myId = sock.user.id.split(':')[0];

        const toRemove = meta.participants.filter(p => {
            const num = p.id.split('@')[0].split(':')[0];
            return p.admin !== 'admin' && p.admin !== 'superadmin'
                && num !== myId && !exclude.includes(num);
        }).map(p => p.id);

        let removed = 0;
        for (let i = 0; i < toRemove.length; i += 5) {
            const batch = toRemove.slice(i, i + 5);
            try {
                await sock.groupParticipantsUpdate(gId, batch, 'remove');
                removed += batch.length;
            } catch (e) {}
            await sleep(1000);
        }

        res.json({ success: true, removed });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// ── MAKE ADMIN ────────────────────────────
app.post('/group/make_admin', async (req, res) => {
    try {
        const { user_id, group_id, numbers } = req.body;
        const sock = sessions[`${user_id}_1`];
        if (!sock) return res.json({ success: false, error: 'Not connected' });

        const result = await sock.groupParticipantsUpdate(
            getGroupJid(group_id),
            numbers.map(n => getJid(n)),
            'promote'
        );

        const promoted = result.filter(r => r.status === '200').length;
        res.json({ success: true, promoted, failed: result.length - promoted });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// ── APPROVE PENDING ───────────────────────
app.post('/group/approve', async (req, res) => {
    try {
        const { user_id, group_id, mode } = req.body;
        const sock = sessions[`${user_id}_1`];
        if (!sock) return res.json({ success: false, error: 'Not connected' });

        const gId = getGroupJid(group_id);
        let pending = [];
        try { pending = await sock.groupRequestParticipantsList(gId); } catch (e) {
            return res.json({ success: true, approved: 0 });
        }

        const ids = pending.map(p => p.jid);
        let approved = 0;

        if (mode === 'together') {
            try {
                await sock.groupSettingUpdate(gId, 'not_announcement');
                await sleep(2000);
                await sock.groupSettingUpdate(gId, 'announcement');
                approved = ids.length;
            } catch (e) {}
        } else {
            for (const id of ids) {
                try {
                    await sock.groupRequestParticipantsUpdate(gId, [id], 'approve');
                    approved++;
                    await sleep(500);
                } catch (e) {}
            }
        }

        res.json({ success: true, approved });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// ── PENDING LIST ──────────────────────────
app.get('/groups/:userId/pending', async (req, res) => {
    try {
        const { userId } = req.params;
        const sock = sessions[`${userId}_1`];
        if (!sock) return res.json({ success: false, groups: [] });

        const myId = sock.user.id;
        const groups = await sock.groupFetchAllParticipating();
        const result = [];

        for (const [id, g] of Object.entries(groups)) {
            const me = g.participants.find(
                p => p.id === myId || p.id.startsWith(myId.split(':')[0])
            );
            const isAdmin = me?.admin === 'admin' || me?.admin === 'superadmin';
            if (!isAdmin) continue;

            try {
                const pending = await sock.groupRequestParticipantsList(id);
                if (pending.length > 0) {
                    result.push({ id, name: g.subject, pending: pending.length, is_admin: true });
                }
                await sleep(200);
            } catch (e) { continue; }
        }

        res.json({ success: true, groups: result });
    } catch (err) {
        res.json({ success: false, error: err.message, groups: [] });
    }
});

// ── EDIT SETTINGS ─────────────────────────
app.post('/group/settings', async (req, res) => {
    try {
        const { user_id, group_id, settings } = req.body;
        const sock = sessions[`${user_id}_1`];
        if (!sock) return res.json({ success: false, error: 'Not connected' });

        const gId = getGroupJid(group_id);

        if (settings.permissions) {
            const p = settings.permissions;
            try {
                if (p.msg === false) await sock.groupSettingUpdate(gId, 'announcement');
                else await sock.groupSettingUpdate(gId, 'not_announcement');
                await sleep(300);
            } catch (e) {}
        }

        if (settings.description) {
            try { await sock.groupUpdateDescription(gId, settings.description); await sleep(300); } catch (e) {}
        }

        if (settings.disappearing !== undefined) {
            try { await sock.groupToggleEphemeral(gId, settings.disappearing); await sleep(300); } catch (e) {}
        }

        res.json({ success: true });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// ── SEND MESSAGE ──────────────────────────
app.post('/message/send', async (req, res) => {
    try {
        const { user_id, session = 2, target, message } = req.body;
        const sock = sessions[`${user_id}_${session}`];
        if (!sock) return res.json({ success: false, error: 'Not connected' });

        await sock.sendMessage(getJid(target), { text: message });
        res.json({ success: true });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// ── SEND GROUP MESSAGE ────────────────────
app.post('/group/send', async (req, res) => {
    try {
        const { user_id, session = 2, target, message } = req.body;
        const sock = sessions[`${user_id}_${session}`];
        if (!sock) return res.json({ success: false, error: 'Not connected' });

        const links = Array.isArray(target) ? target : [target];
        for (const link of links) {
            try {
                const code = link.split('/').pop().trim();
                const info = await sock.groupGetInviteInfo(code);
                await sock.sendMessage(info.id, { text: message });
                await sleep(1000);
            } catch (e) {}
        }

        res.json({ success: true });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// ── CTC CHECK ─────────────────────────────
app.post('/ctc/check', async (req, res) => {
    try {
        const { user_id, contact, links } = req.body;
        const sock = sessions[`${user_id}_1`];
        if (!sock) return res.json({ status: 'error' });

        let status = 'not_found';

        for (const link of links) {
            try {
                const code = link.split('/').pop().trim();
                const info = await sock.groupGetInviteInfo(code);
                const meta = await sock.groupMetadata(info.id);

                const inGroup = meta.participants.some(
                    p => p.id.split('@')[0] === contact
                );
                if (inGroup) { status = 'already_in'; break; }

                try {
                    const pending = await sock.groupRequestParticipantsList(info.id);
                    const inPending = pending.some(p => p.jid.split('@')[0] === contact);
                    if (inPending) { status = 'pending'; break; }
                } catch (e) {}

            } catch (e) { continue; }
        }

        res.json({ status });
    } catch (err) {
        res.json({ status: 'error', error: err.message });
    }
});

// ─────────────────────────────────────────
// START
// ─────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`
╔══════════════════════════════════╗
║  WhatsApp API Server Running!    ║
║  Port: ${PORT}                      ║
║  Status: ✅ Ready                ║
╚══════════════════════════════════╝
    `);
});

process.on('uncaughtException', err => console.error('Exception:', err));
process.on('unhandledRejection', err => console.error('Rejection:', err));
            
