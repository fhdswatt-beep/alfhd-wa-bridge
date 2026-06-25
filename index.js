require('dotenv').config();

const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');

const pino = require('pino');
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const fs = require('fs');
const QRCodeLib = require('qrcode');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const PORT = process.env.PORT || 3001;
const WA_PHONE = process.env.WA_PHONE_NUMBER || '';
const AUTH_DIR = path.join(__dirname, 'auth_info_business');

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Express ──
const app = express();
app.use(express.json());

app.get('/', (req, res) => res.json({ status: 'running', connected: global.waConnected || false }));

app.get('/status', (req, res) => res.json({
  connected: global.waConnected || false,
  phone: global.waPhone || null,
  uptime: process.uptime(),
}));

// ✅ صفحة QR
app.get('/qr', async (req, res) => {
  if (global.waConnected) {
    return res.send('<h2 style="font-family:sans-serif;color:green;text-align:center;margin-top:50px">✅ واتساب متصل!</h2>');
  }
  if (!global.lastQR) {
    return res.send('<h2 style="font-family:sans-serif;color:orange;text-align:center;margin-top:50px">⏳ انتظر قليلاً وأعد تحميل الصفحة...<br><script>setTimeout(()=>location.reload(),5000)</script></h2>');
  }
  try {
    const qrImage = await QRCodeLib.toDataURL(global.lastQR, { width: 400 });
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WhatsApp QR</title>
    <style>body{font-family:sans-serif;text-align:center;background:#111;color:white;padding:30px}img{border-radius:16px;margin:20px auto;display:block}h2{color:#25D366}p{color:#aaa}button{background:#25D366;color:white;border:none;padding:12px 24px;border-radius:8px;font-size:16px;cursor:pointer;margin-top:10px}</style>
    </head><body>
    <h2>📱 امسح الكود بواتساب Business</h2>
    <p>واتساب ← الأجهزة المرتبطة ← ربط جهاز</p>
    <img src="${qrImage}" width="300" height="300"/>
    <br><button onclick="location.reload()">🔄 تحديث QR</button>
    <p style="color:#666;font-size:12px">الكود يتجدد كل 20 ثانية</p>
    <script>setTimeout(()=>location.reload(),20000)</script>
    </body></html>`);
  } catch (e) {
    res.send('<h2 style="color:red">خطأ في توليد QR</h2>');
  }
});

// ✅ إرسال رسالة من الموقع
app.post('/send', async (req, res) => {
  const { phone, message } = req.body;
  if (!phone || !message) return res.status(400).json({ error: 'phone and message required' });
  if (!global.waSock || !global.waConnected) return res.status(503).json({ error: 'WhatsApp not connected' });
  try {
    const jid = phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;
    await global.waSock.sendMessage(jid, { text: message });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// مسح الـ Session
app.post('/reset-session', (req, res) => {
  try {
    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    }
    global.pairingDone = false;
    global.waConnected = false;
    global.waPhone = null;
    global.lastQR = null;
    res.json({ success: true });
    setTimeout(() => process.exit(0), 1000);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.listen(PORT, () => console.log(`🌐 HTTP server on port ${PORT}`));

// ── Helper ──
function phoneFromJid(jid) {
  if (!jid) return '';
  return jid.replace(/@s\.whatsapp\.net|@g\.us|@c\.us/g, '').split(':')[0];
}
function isGroup(jid) { return jid?.endsWith('@g.us'); }

// ── حفظ أو تحديث محادثة ──
async function getOrCreateConv(phone, name, direction, content, timestamp) {
  const convKey = `wa_${phone}`;
  const { data: existing } = await supabase
    .from('alfhd_conversations')
    .select('id, unread_count, customer_name')
    .eq('customer_psid', convKey)
    .maybeSingle();

  if (existing) {
    await supabase.from('alfhd_conversations').update({
      last_message: content.slice(0, 200),
      last_message_time: timestamp,
      unread_count: direction === 'incoming' ? (existing.unread_count || 0) + 1 : (existing.unread_count || 0),
      // ✅ تحديث الاسم دائماً إذا جاء من الرسالة
      customer_name: (direction === 'incoming' && name && name !== phone) ? name : existing.customer_name,
    }).eq('id', existing.id);
    return existing.id;
  }

  // ✅ اسم صحيح بدل الـ ID
  const displayName = (name && name !== phone) ? name : `+${phone}`;
  const { data: newConv } = await supabase
    .from('alfhd_conversations')
    .insert({
      customer_name: displayName,
      customer_psid: convKey,
      phone: phone,
      source: 'whatsapp',
      last_message: content.slice(0, 200),
      last_message_time: timestamp,
      unread_count: direction === 'incoming' ? 1 : 0,
      tab: 'normal',
      avatar: displayName.charAt(0).toUpperCase(),
      page_id: null,
    })
    .select('id')
    .maybeSingle();

  return newConv?.id;
}

// ── حفظ رسالة ──
async function saveMessage(msg, direction) {
  try {
    const jid = msg.key.remoteJid;
    if (!jid || jid === 'status@broadcast') return;
    if (isGroup(jid)) return;

    const phone = phoneFromJid(jid);
    const msgId = msg.key.id;
    const timestamp = new Date(Number(msg.messageTimestamp || Date.now() / 1000) * 1000).toISOString();
    const pushName = msg.pushName || `+${phone}`;

    let content = '';
    let msgType = 'text';

    const m = msg.message;
    if (!m) return;

    if (m.conversation) {
      content = m.conversation;
    } else if (m.extendedTextMessage?.text) {
      content = m.extendedTextMessage.text;
    } else if (m.imageMessage) {
      content = m.imageMessage.caption || '📷 صورة';
      msgType = 'image';
    } else if (m.videoMessage) {
      content = m.videoMessage.caption || '🎥 فيديو';
      msgType = 'video';
    } else if (m.audioMessage || m.pttMessage) {
      content = '🎵 رسالة صوتية';
      msgType = 'audio';
    } else if (m.documentMessage) {
      content = `📎 ${m.documentMessage.fileName || 'ملف'}`;
      msgType = 'document';
    } else if (m.locationMessage) {
      content = `📍 موقع: ${m.locationMessage.degreesLatitude?.toFixed(4)}, ${m.locationMessage.degreesLongitude?.toFixed(4)}`;
      msgType = 'location';
    } else if (m.stickerMessage) {
      content = '🎭 ملصق';
      msgType = 'sticker';
    } else if (m.reactionMessage) {
      return;
    } else {
      content = `[${Object.keys(m)[0] || 'رسالة'}]`;
    }

    const convId = await getOrCreateConv(phone, pushName, direction, content, timestamp);
    if (!convId) return;

    // منع التكرار
    const { data: dup } = await supabase
      .from('alfhd_messages')
      .select('id')
      .eq('external_id', msgId)
      .maybeSingle();
    if (dup) return;

    await supabase.from('alfhd_messages').insert({
      conversation_id: convId,
      direction,
      content: content || '...',
      type: msgType,
      external_id: msgId,
      created_at: timestamp,
      source: 'whatsapp',
    });

    console.log(`${direction === 'incoming' ? '📨' : '📤'} WA [${phone}] ${pushName}: ${content.slice(0, 60)}`);

  } catch (e) {
    console.error('saveMessage error:', e.message);
  }
}

// ── اتصال واتساب ──
async function connectToWhatsApp() {
  if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  console.log(`📱 Baileys v${version.join('.')}`);

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['Ubuntu', 'Chrome', '22.0.0'],
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  global.waSock = sock;

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      global.lastQR = qr;
      console.log('📲 QR جاهز — افتح: /qr');

      // إذا ما في رقم هاتف — استخدم QR فقط
      if (!WA_PHONE) return;

      // إذا في رقم — اطلب pairing code
      if (!global.pairingDone && !sock.authState.creds.registered) {
        global.pairingDone = true;
        try {
          const code = await sock.requestPairingCode(WA_PHONE);
          console.log('\n══════════════════════════════');
          console.log(`📱 كود الربط: ${code}`);
          console.log('واتساب Business ← الأجهزة المرتبطة ← ربط جهاز ← ربط برقم الهاتف');
          console.log(`أدخل الكود: ${code}`);
          console.log('الكود صالح لمدة 160 ثانية');
          console.log('══════════════════════════════\n');
        } catch (e) {
          global.pairingDone = false;
          console.error('pairing error:', e.message);
          console.log('⚠️ فشل الـ Pairing Code — استخدم QR بدلاً منه على: /qr');
        }
      }
    }

    if (connection === 'close') {
      global.waConnected = false;
      global.pairingDone = false;
      global.lastQR = null;
      const code = lastDisconnect?.error?.output?.statusCode;
      const retry = code !== DisconnectReason.loggedOut;
      console.log(`❌ انقطع (${code}). إعادة: ${retry}`);
      if (retry) {
        setTimeout(connectToWhatsApp, 5000);
      } else {
        console.log('🗑️ تسجيل خروج — مسح Session...');
        if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        setTimeout(connectToWhatsApp, 5000);
      }
    }

    if (connection === 'open') {
      global.waConnected = true;
      global.lastQR = null;
      global.waPhone = sock.user?.id?.split(':')[0];
      console.log(`✅ واتساب Business متصل! ${global.waPhone}`);
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (!msg.message) continue;
      await saveMessage(msg, msg.key.fromMe ? 'outgoing' : 'incoming');
    }
  });
}

console.log('🚀 AlFhd WhatsApp Bridge starting...');
connectToWhatsApp().catch(console.error);
