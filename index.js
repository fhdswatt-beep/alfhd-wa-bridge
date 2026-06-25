require('dotenv').config();

const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
} = require('@whiskeysockets/baileys');

const pino = require('pino');
const QRCode = require('qrcode-terminal');
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const fs = require('fs');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const PORT = process.env.PORT || 3001;
const WA_PHONE = process.env.WA_PHONE_NUMBER || '';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Express ──
const app = express();
app.use(express.json());

app.get('/', (req, res) => res.json({ status: 'running', connected: global.waConnected || false }));
app.get('/status', (req, res) => res.json({ connected: global.waConnected || false, phone: global.waPhone || null }));

// ── إرسال رسالة (للرد من الموقع) ──
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
      customer_name: direction === 'incoming' && name && name !== phone ? name : existing.customer_name,
    }).eq('id', existing.id);
    return existing.id;
  }

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
    let mediaUrl = null;

    const m = msg.message;
    if (!m) return;

    if (m.conversation) {
      content = m.conversation;
    } else if (m.extendedTextMessage?.text) {
      content = m.extendedTextMessage.text;
    } else if (m.imageMessage) {
      content = m.imageMessage.caption || '';
      msgType = 'image';
      // حفظ الصورة لاحقاً يمكن إضافته
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
      return; // تجاهل reactions
    } else {
      content = `[${Object.keys(m)[0] || 'رسالة'}]`;
    }

    // ابحث أو أنشئ محادثة
    const convId = await getOrCreateConv(phone, pushName, direction, content, timestamp);
    if (!convId) return;

    // تحقق من عدم وجود الرسالة مسبقاً (منع التكرار)
    const { data: dup } = await supabase
      .from('alfhd_messages')
      .select('id')
      .eq('external_id', msgId)
      .maybeSingle();

    if (dup) return; // رسالة مكررة

    await supabase.from('alfhd_messages').insert({
      conversation_id: convId,
      direction,
      content: content || '...',
      type: msgType,
      media_url: mediaUrl,
      external_id: msgId,
      created_at: timestamp,
      source: 'whatsapp',
    });

    const arrow = direction === 'incoming' ? '📨' : '📤';
    console.log(`${arrow} WA [${phone}] ${pushName}: ${content.slice(0, 60)}`);

  } catch (e) {
    console.error('saveMessage error:', e.message);
  }
}

// ── اتصال واتساب ──
let pairingDone = false;

async function connectToWhatsApp() {
  const authDir = path.join(__dirname, 'auth_info');
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  console.log(`📱 Baileys v${version.join('.')}`);

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['AlFhd', 'Chrome', '1.0.0'],
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  global.waSock = sock;

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // اطلب pairing code فور بدء الاتصال
    if (qr && !sock.authState.creds.registered && !pairingDone && WA_PHONE) {
      pairingDone = true;
      console.log('📲 QR جاهز — طلب كود الربط...');
      try {
        const code = await sock.requestPairingCode(WA_PHONE);
        console.log('\n══════════════════════════════');
        console.log(`📱 كود الربط: ${code}`);
        console.log('واتساب ← الأجهزة المرتبطة ← ربط جهاز ← ربط برقم الهاتف');
        console.log('══════════════════════════════\n');
      } catch (e) {
        pairingDone = false;
        console.error('pairing error:', e.message);
        // fallback QR
        QRCode.generate(qr, { small: true });
      }
    } else if (qr && !WA_PHONE) {
      QRCode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      global.waConnected = false;
      pairingDone = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      const retry = code !== DisconnectReason.loggedOut;
      console.log(`❌ انقطع (${code}). إعادة: ${retry}`);
      if (retry) setTimeout(connectToWhatsApp, 5000);
    }

    if (connection === 'open') {
      global.waConnected = true;
      global.waPhone = sock.user?.id?.split(':')[0];
      console.log(`✅ متصل! ${global.waPhone}`);
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
