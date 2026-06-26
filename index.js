require('dotenv').config();

const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');

const pino = require('pino');
const express = require('express');
const cors = require('cors'); // ✅ CORS
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const fs = require('fs');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const PORT = process.env.PORT || 3001;
const WA_PHONE = process.env.WA_PHONE_NUMBER || '';
const AUTH_DIR = path.join(__dirname, 'auth_info_business');

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Express ──
const app = express();
app.use(cors()); // ✅ السماح لكل الـ domains بالوصول
app.use(express.json({ limit: '20mb' })); // ✅ دعم الصور الكبيرة

app.get('/', (req, res) => res.json({ status: 'running', connected: global.waConnected || false }));

app.get('/status', (req, res) => res.json({
  connected: global.waConnected || false,
  phone: global.waPhone || null,
  uptime: process.uptime(),
}));

// ✅ إرسال رسالة نصية
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

// ✅ إرسال صورة (رابط URL)
app.post('/send-image', async (req, res) => {
  const { phone, imageUrl, caption } = req.body;
  if (!phone || !imageUrl) return res.status(400).json({ error: 'phone and imageUrl required' });
  if (!global.waSock || !global.waConnected) return res.status(503).json({ error: 'WhatsApp not connected' });
  try {
    const jid = phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;
    await global.waSock.sendMessage(jid, {
      image: { url: imageUrl },
      caption: caption || '',
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ✅ إرسال صوت (رابط URL)
app.post('/send-audio', async (req, res) => {
  const { phone, audioUrl } = req.body;
  if (!phone || !audioUrl) return res.status(400).json({ error: 'phone and audioUrl required' });
  if (!global.waSock || !global.waConnected) return res.status(503).json({ error: 'WhatsApp not connected' });
  try {
    const jid = phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;
    await global.waSock.sendMessage(jid, {
      audio: { url: audioUrl },
      mimetype: 'audio/webm',
      ptt: true, // رسالة صوتية (Push To Talk)
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// مسح الـ Session — محمي بكلمة سر
app.post('/reset-session', (req, res) => {
  // ✅ حماية: لازم ترسل secret key عشان يمسح الـ session
  const secret = req.body?.secret || req.headers['x-reset-secret'];
  if (secret !== (process.env.RESET_SECRET || 'alfhd-reset-2026')) {
    return res.status(403).json({ error: 'Forbidden — wrong secret' });
  }
  try {
    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      console.log('🗑️ تم مسح ملفات الـ Session');
    }
    global.pairingDone = false;
    global.waConnected = false;
    global.waPhone = null;
    res.json({ success: true, message: 'تم مسح الـ Session. سيتم إعادة التشغيل...' });
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
      customer_name: (direction === 'incoming' && name && name !== phone) ? name : existing.customer_name,
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

// ══════════════════════════════════════════════
// كشف رسالة "تم تثبيت طلبك" تلقائياً وتحويلها لطلب حقيقي
// (منقول حرف بحرف من fb-poll-messages ليطابق سلوك ماسنجر)
// ══════════════════════════════════════════════
function parseOrderConfirmation(text) {
  if (!text || !text.includes('تم تثبيت طلبك')) return null;
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const fields = {};
  for (const line of lines) {
    const match = line.match(/^([^:：]{2,30})[:：]\s*(.+)$/);
    if (match) {
      fields[match[1].trim()] = match[2].trim();
    }
  }
  return Object.keys(fields).length > 0 ? fields : null;
}

function buildOrderFromFields(fields) {
  const findValue = (...keys) => {
    for (const fieldKey of Object.keys(fields)) {
      if (keys.some((k) => fieldKey.includes(k))) return fields[fieldKey];
    }
    return '';
  };

  const nameKeys = ['اسم المستلم', 'اسم الزبون', 'اسم العميل', 'المستلم'];
  const phoneKeys = ['رقم التلفون', 'رقم الهاتف', 'الهاتف', 'موبايل', 'تلفون'];
  const addressKeys = ['العنوان', 'المنطقة'];
  const totalKeys = ['السعر الكلي', 'المبلغ الكلي', 'المبلغ', 'السعر'];
  const dateKeys = ['التاريخ'];
  const typeKeys = ['نوع الطلب', 'نوع الحجز', 'النوع'];
  const knownKeys = [...nameKeys, ...phoneKeys, ...addressKeys, ...totalKeys, ...dateKeys, ...typeKeys];

  const customer = findValue(...nameKeys);
  const phone = findValue(...phoneKeys);
  const address = findValue(...addressKeys);
  const totalRaw = findValue(...totalKeys);
  const dateRaw = findValue(...dateKeys);
  const orderType = findValue(...typeKeys);

  const itemLines = [];
  for (const [label, value] of Object.entries(fields)) {
    if (!knownKeys.some((k) => label.includes(k))) {
      itemLines.push(`${label}: ${value}`);
    }
  }

  // معالجة السعر: يدعم "85000" و "85 الف" و "85,000 دينار"
  let total = 0;
  {
    const raw = (totalRaw || '0').trim();
    const hasThousand = /الف|ألف|آلاف/i.test(raw);
    const num = Number(raw.replace(/[^0-9]/g, '')) || 0;
    total = (hasThousand && num < 1000) ? num * 1000 : num;
  }

  let orderDate = new Date().toISOString().slice(0, 10);
  const dateMatch = (dateRaw || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (dateMatch) {
    const [, d, mo, y] = dateMatch;
    orderDate = `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  return {
    customer_name: customer || 'زبون من المحادثة',
    phone,
    address,
    items: itemLines.join('\n'),
    order_type: orderType,
    total,
    order_date: orderDate,
  };
}

// جلب صفحة واتساب (كماليات ابو علي = أول صفحة مرتبطة) — مع تخزين مؤقت
let _cachedPageId = null;
async function getWhatsAppPageId() {
  if (_cachedPageId) return _cachedPageId;
  try {
    const { data } = await supabase
      .from('alfhd_pages')
      .select('id')
      .eq('connected', true)
      .order('created_at', { ascending: true })
      .limit(1);
    if (data && data[0]) { _cachedPageId = data[0].id; return _cachedPageId; }
    // احتياط: أول صفحة موجودة
    const { data: any } = await supabase
      .from('alfhd_pages').select('id').order('created_at', { ascending: true }).limit(1);
    if (any && any[0]) { _cachedPageId = any[0].id; return _cachedPageId; }
  } catch (e) {
    console.error('getWhatsAppPageId error:', e.message);
  }
  return null;
}

// عبارات تحويل المحادثة من المساعد الذكي إلى موظف بشري
const HANDOFF_PHRASES = [
  'transferred this chat',
  'Your AI Agent',
  'Your AI agent',
  'سأقوم بتحويلك',
  'سأحولك إلى أحد موظفينا',
  'تحويلك إلى أحد',
  'أحد الممثلين',
  'أحد موظفينا',
];

// معالجة رسالة صادرة: كشف handoff + كشف تثبيت الطلب (طبق ماسنجر)
async function processOutgoingForOrder(msgText, conversationId, msgId) {
  if (!msgText) return;

  // ── كشف تحويل المحادثة للموظف البشري ──
  const isHandoff = HANDOFF_PHRASES.some((p) => msgText.includes(p));
  if (isHandoff) {
    try {
      const { data: convRow } = await supabase
        .from('alfhd_conversations').select('tab').eq('id', conversationId).maybeSingle();
      // لا نحوّل المحادثات المثبّت بها طلب
      if (convRow?.tab !== 'pinned') {
        await supabase.from('alfhd_conversations').update({ tab: 'handoff' }).eq('id', conversationId);
      }
    } catch (e) {
      console.log('handoff detection failed:', e.message);
    }
  }

  // ── كشف رسالة تثبيت الطلب ──
  const fields = parseOrderConfirmation(msgText);
  if (!fields) return;

  try {
    // منع التكرار الخاطئ فقط: لا تنشئ طلباً من نفس رسالة التثبيت بالذات
    // (نفس external_id). يسمح بطلبات متعددة بنفس المحادثة لأن كل تثبيت رسالة جديدة.
    const { data: dup } = await supabase
      .from('alfhd_orders').select('id').eq('source_message_id', msgId).limit(1);
    if (dup && dup.length > 0) return;

    const orderData = buildOrderFromFields(fields);
    const pageId = await getWhatsAppPageId();

    const { data: createdOrder } = await supabase
      .from('alfhd_orders')
      .insert({
        order_no: String(Date.now()).slice(-6),
        page_id: pageId,
        customer_name: orderData.customer_name,
        phone: orderData.phone,
        address: orderData.address,
        items: orderData.items,
        order_type: orderData.order_type,
        total: orderData.total,
        status: 'pending',
        stage: 'ready',
        order_date: orderData.order_date,
        fahd_ref: `FHD-${Math.floor(10000 + Math.random() * 89999)}`,
        conversation_id: conversationId,
        source: 'chat',
        source_message_id: msgId,
      })
      .select('id');

    if (createdOrder && createdOrder[0]) {
      await supabase.from('alfhd_conversations').update({
        tab: 'pinned',
        order_id: createdOrder[0].id,
      }).eq('id', conversationId);
      console.log(`✅ طلب واتساب جديد #${createdOrder[0].id} — ${orderData.customer_name}`);
    }
  } catch (e) {
    console.log('auto order creation failed:', e.message);
  }
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
      content = m.imageMessage.caption || '📷 صورة';
      msgType = 'image';
      // حفظ رابط الصورة إذا كان متاحاً
      mediaUrl = m.imageMessage.url || null;
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
      media_url: mediaUrl,
      external_id: msgId,
      created_at: timestamp,
      source: 'whatsapp',
    });

    console.log(`${direction === 'incoming' ? '📨' : '📤'} WA [${phone}] ${pushName}: ${content.slice(0, 60)}`);

    // كشف تثبيت الطلب + التحويل — فقط للرسائل الصادرة (من رقمك للزبون)
    // تماماً مثل ماسنجر: البوت يرسل "تم تثبيت طلبك" فيتحول لطلب حقيقي
    if (direction === 'outgoing') {
      await processOutgoingForOrder(content, convId, msgId);
    }

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
    const { connection, lastDisconnect } = update;

    // طلب Pairing Code مباشرة
    if (!sock.authState.creds.registered && WA_PHONE && !global.pairingDone) {
      global.pairingDone = true;
      setTimeout(async () => {
        try {
          const code = await sock.requestPairingCode(WA_PHONE);
          console.log('\n══════════════════════════════');
          console.log(`📱 كود الربط: ${code}`);
          console.log('واتساب Business ← الأجهزة المرتبطة ← ربط جهاز ← ربط برقم الهاتف');
          console.log(`أدخل الكود: ${code}`);
          console.log('الكود صالح لمدة 160 ثانية — أدخله فوراً!');
          console.log('══════════════════════════════\n');
        } catch (e) {
          global.pairingDone = false;
          console.error('pairing error:', e.message);
        }
      }, 3000);
    }

    if (connection === 'close') {
      global.waConnected = false;
      global.pairingDone = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      const retry = code !== DisconnectReason.loggedOut;
      console.log(`❌ انقطع (${code}). إعادة: ${retry}`);
      if (retry) {
        setTimeout(connectToWhatsApp, 5000);
      } else {
        // ✅ تسجيل خروج — امسح Session فقط في هذه الحالة
        console.log('🗑️ تسجيل خروج — مسح Session...');
        if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        setTimeout(connectToWhatsApp, 5000);
      }
    }

    if (connection === 'open') {
      global.waConnected = true;
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
