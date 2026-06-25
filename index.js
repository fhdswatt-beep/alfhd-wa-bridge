// ══════════════════════════════════════════════════════════════════
// AlFhd WhatsApp Bridge — Baileys
// يستقبل كل رسائل واتساب ويحفظها في Supabase
// ══════════════════════════════════════════════════════════════════
require('dotenv').config();

const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeInMemoryStore,
  jidNormalizedUser,
  proto,
} = require('@whiskeysockets/baileys');

const pino = require('pino');
const QRCode = require('qrcode-terminal');
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const fs = require('fs');

// ── Config ──
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://wqfuovvebgipiowaarbo.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndxZnVvdnZlYmdpcGlvd2FhcmJvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE5MTM2ODEsImV4cCI6MjA5NzQ4OTY4MX0.xeQ80kco6TOpbyMnYonzSCBDI3Hn_EKiavKKfC7kLl8';
const PORT = process.env.PORT || 3001;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Express server (health check + status) ──
const app = express();
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'running', connected: global.waConnected || false });
});

app.get('/status', (req, res) => {
  res.json({
    connected: global.waConnected || false,
    phone: global.waPhone || null,
    uptime: process.uptime(),
  });
});

app.listen(PORT, () => {
  console.log(`🌐 HTTP server running on port ${PORT}`);
});

// ── Helper: normalize phone ──
function normalizePhone(jid) {
  if (!jid) return '';
  return jid.replace('@s.whatsapp.net', '').replace('@g.us', '');
}

function isGroup(jid) {
  return jid?.endsWith('@g.us');
}

// ── Save message to Supabase ──
async function saveMessage(msg, direction) {
  try {
    const jid = msg.key.remoteJid;
    if (!jid || jid === 'status@broadcast') return;
    if (isGroup(jid)) return; // تجاهل المجموعات

    const phone = normalizePhone(jid);
    const msgId = msg.key.id;
    const timestamp = new Date((msg.messageTimestamp || Date.now() / 1000) * 1000).toISOString();

    // استخراج النص
    let content = '';
    let msgType = 'text';

    if (msg.message?.conversation) {
      content = msg.message.conversation;
    } else if (msg.message?.extendedTextMessage?.text) {
      content = msg.message.extendedTextMessage.text;
    } else if (msg.message?.imageMessage) {
      content = msg.message.imageMessage.caption || '📷 صورة';
      msgType = 'image';
    } else if (msg.message?.videoMessage) {
      content = msg.message.videoMessage.caption || '🎥 فيديو';
      msgType = 'video';
    } else if (msg.message?.audioMessage) {
      content = '🎵 رسالة صوتية';
      msgType = 'audio';
    } else if (msg.message?.documentMessage) {
      content = msg.message.documentMessage.fileName || '📎 ملف';
      msgType = 'document';
    } else if (msg.message?.locationMessage) {
      const loc = msg.message.locationMessage;
      content = `📍 موقع: ${loc.degreesLatitude}, ${loc.degreesLongitude}`;
      msgType = 'location';
    } else if (msg.message?.stickerMessage) {
      content = '🎭 ملصق';
      msgType = 'sticker';
    } else {
      return; // رسالة غير معروفة
    }

    // اسم المرسل
    const pushName = msg.pushName || phone;

    // ابحث عن محادثة موجودة أو أنشئ واحدة
    const convKey = `wa_${phone}`;
    
    const { data: existing } = await supabase
      .from('alfhd_conversations')
      .select('id, unread_count')
      .eq('customer_psid', convKey)
      .limit(1)
      .single();

    let convId;

    if (existing) {
      convId = existing.id;
      // تحديث آخر رسالة
      await supabase.from('alfhd_conversations').update({
        last_message: content.slice(0, 200),
        last_message_time: timestamp,
        unread_count: direction === 'incoming' ? (existing.unread_count || 0) + 1 : existing.unread_count,
        customer_name: direction === 'incoming' ? pushName : existing.customer_name,
      }).eq('id', convId);
    } else {
      // محادثة جديدة
      const { data: newConv } = await supabase
        .from('alfhd_conversations')
        .insert({
          customer_name: pushName,
          customer_psid: convKey,
          source: 'whatsapp',
          last_message: content.slice(0, 200),
          last_message_time: timestamp,
          unread_count: direction === 'incoming' ? 1 : 0,
          tab: 'normal',
          avatar: pushName.charAt(0).toUpperCase() || 'W',
          page_id: null,
        })
        .select('id')
        .single();
      convId = newConv?.id;
    }

    if (!convId) return;

    // حفظ الرسالة
    const { error } = await supabase.from('alfhd_messages').insert({
      conversation_id: convId,
      direction,
      content,
      type: msgType,
      external_id: msgId,
      created_at: timestamp,
      source: 'whatsapp',
    });

    if (error && error.code !== '23505') { // تجاهل duplicate
      console.error('DB error:', error.message);
    } else {
      console.log(`✅ ${direction === 'incoming' ? '📨' : '📤'} WA: ${pushName} → ${content.slice(0, 50)}`);
    }

  } catch (e) {
    console.error('saveMessage error:', e.message);
  }
}

const readline = require('readline');

// ── WhatsApp Connection ──
async function connectToWhatsApp() {
  const authDir = path.join(__dirname, 'auth_info');
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  console.log(`📱 Baileys version: ${version.join('.')}`);

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['AlFhd', 'Chrome', '1.0.0'],
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  // ── ربط برقم الهاتف ──
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // لو لم يتم التسجيل بعد — استخدم pairing code
    if (!sock.authState.creds.registered) {
      const phoneNumber = process.env.WA_PHONE_NUMBER;
      if (phoneNumber && !global.pairingRequested) {
        global.pairingRequested = true;
        try {
          await new Promise(r => setTimeout(r, 3000));
          const code = await sock.requestPairingCode(phoneNumber);
          console.log('\n═══════════════════════════════════');
          console.log(`📱 كود الربط: ${code}`);
          console.log('افتح واتساب ← الأجهزة المرتبطة ← ربط جهاز ← ربط برقم الهاتف');
          console.log(`أدخل الكود: ${code}`);
          console.log('الكود صالح لمدة 160 ثانية');
          console.log('═══════════════════════════════════\n');
        } catch (e) {
          global.pairingRequested = false;
          console.error('خطأ في طلب كود الربط:', e.message);
        }
      } else {
        // fallback للـ QR
        if (qr) {
          console.log('\n═══════════════════════════════════');
          console.log('امسح هذا الكود بواتساب:');
          QRCode.generate(qr, { small: true });
          console.log('═══════════════════════════════════\n');
        }
      }
    }

    if (connection === 'close') {
      global.waConnected = false;
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('❌ انقطع الاتصال. إعادة محاولة:', shouldReconnect);
      if (shouldReconnect) {
        setTimeout(connectToWhatsApp, 3000);
      }
    }

    if (connection === 'open') {
      global.waConnected = true;
      global.waPhone = sock.user?.id?.split(':')[0];
      console.log(`\n✅ واتساب متصل! الرقم: ${global.waPhone}`);
    }
  });

  // ── حفظ الـ credentials ──
  sock.ev.on('creds.update', saveCreds);

  // ── استقبال الرسائل ──
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message) continue;
      const direction = msg.key.fromMe ? 'outgoing' : 'incoming';
      await saveMessage(msg, direction);
    }
  });

  return sock;
}

// ── Start ──
console.log('🚀 AlFhd WhatsApp Bridge starting...');
connectToWhatsApp().catch(console.error);
