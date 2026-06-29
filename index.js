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
const AUTH_ROOT = path.join(__dirname, 'wa_sessions');

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ══════════════════════════════════════════════
// نظام الجلسات المتعددة — كل صفحة لها جلسة واتساب خاصة
// sessions[pageId] = { sock, connected, phone, pairingCode, pairingRequested }
// ══════════════════════════════════════════════
const sessions = {};

function getSession(pageId) {
  if (!sessions[pageId]) {
    sessions[pageId] = { sock: null, connected: false, phone: null, pairingCode: null, pairingRequested: false };
  }
  return sessions[pageId];
}

// ── Express ──
const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));

app.get('/', (req, res) => res.json({
  status: 'running',
  sessions: Object.keys(sessions).map((pid) => ({ pageId: pid, connected: sessions[pid].connected, phone: sessions[pid].phone })),
}));

// حالة جلسة صفحة معينة
app.get('/status/:pageId', (req, res) => {
  const s = sessions[req.params.pageId];
  res.json({
    connected: s?.connected || false,
    phone: s?.phone || null,
    pairingCode: s?.pairingCode || null,
  });
});

// حالة عامة (توافق مع النسخة القديمة)
app.get('/status', (req, res) => {
  const anyConnected = Object.values(sessions).some((s) => s.connected);
  res.json({ connected: anyConnected, sessions: Object.keys(sessions).length, uptime: process.uptime() });
});

// ── ربط صفحة بواتساب: يستقبل pageId + phone، يرجّع pairing code ──
app.post('/pair', async (req, res) => {
  const { pageId, phone } = req.body;
  if (!pageId || !phone) return res.status(400).json({ error: 'pageId and phone required' });
  const cleanPhone = String(phone).replace(/[^0-9]/g, '');
  if (cleanPhone.length < 10) return res.status(400).json({ error: 'رقم هاتف غير صالح' });
  try {
    const s = getSession(pageId);
    // إن كانت متصلة مسبقاً
    if (s.connected) return res.json({ success: true, alreadyConnected: true, phone: s.phone });
    // أعد ضبط الجلسة وابدأ ربطاً جديداً
    s.pairingRequested = true;
    s.pendingPhone = cleanPhone;
    s.pairingCode = null;
    await connectSession(pageId, cleanPhone);
    // انتظر توليد الكود (حتى 12 ثانية)
    let waited = 0;
    while (!s.pairingCode && !s.connected && waited < 12000) {
      await new Promise((r) => setTimeout(r, 500));
      waited += 500;
    }
    if (s.pairingCode) return res.json({ success: true, pairingCode: s.pairingCode });
    if (s.connected) return res.json({ success: true, alreadyConnected: true });
    return res.status(504).json({ error: 'تعذّر توليد كود الربط، حاول مجدداً' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ✅ إرسال رسالة نصية (يدعم pageId لاختيار الجلسة)
app.post('/send', async (req, res) => {
  const { phone, message, pageId } = req.body;
  if (!phone || !message) return res.status(400).json({ error: 'phone and message required' });
  const s = pickSession(pageId);
  if (!s || !s.sock || !s.connected) return res.status(503).json({ error: 'WhatsApp not connected' });
  try {
    const jid = phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;
    await s.sock.sendMessage(jid, { text: message });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ✅ إرسال صورة
app.post('/send-image', async (req, res) => {
  const { phone, imageUrl, caption, pageId } = req.body;
  if (!phone || !imageUrl) return res.status(400).json({ error: 'phone and imageUrl required' });
  const s = pickSession(pageId);
  if (!s || !s.sock || !s.connected) return res.status(503).json({ error: 'WhatsApp not connected' });
  try {
    const jid = phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;
    await s.sock.sendMessage(jid, { image: { url: imageUrl }, caption: caption || '' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ✅ إرسال صوت
app.post('/send-audio', async (req, res) => {
  const { phone, audioUrl, pageId } = req.body;
  if (!phone || !audioUrl) return res.status(400).json({ error: 'phone and audioUrl required' });
  const s = pickSession(pageId);
  if (!s || !s.sock || !s.connected) return res.status(503).json({ error: 'WhatsApp not connected' });
  try {
    const jid = phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;
    await s.sock.sendMessage(jid, { audio: { url: audioUrl }, mimetype: 'audio/webm', ptt: true });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// اختيار الجلسة: بالـ pageId إن وُجد، وإلا أول جلسة متصلة (توافق خلفي)
function pickSession(pageId) {
  if (pageId && sessions[pageId]) return sessions[pageId];
  return Object.values(sessions).find((s) => s.connected) || null;
}

// إلغاء ربط صفحة (تسجيل خروج + مسح الجلسة)
app.post('/unpair', async (req, res) => {
  const { pageId } = req.body;
  if (!pageId) return res.status(400).json({ error: 'pageId required' });
  try {
    const s = sessions[pageId];
    if (s?.sock) { try { await s.sock.logout(); } catch (_e) {} }
    const dir = path.join(AUTH_ROOT, String(pageId));
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    delete sessions[pageId];
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
async function getOrCreateConv(phone, name, direction, content, timestamp, pageId) {
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
      page_id: pageId || null,
    })
    .select('id')
    .maybeSingle();

  return newConv?.id;
}

// ══════════════════════════════════════════════
// المحافظات العراقية بأكوادها (مطابقة لـ App.jsx و Jenni)
// ══════════════════════════════════════════════
const IRAQ_GOVERNORATES = [
  { code: 'BGD', name: 'بغداد' },
  { code: 'BAS', name: 'البصرة' },
  { code: 'NIN', name: 'نينوى' },
  { code: 'ARB', name: 'أربيل' },
  { code: 'NJF', name: 'النجف' },
  { code: 'KRB', name: 'كربلاء' },
  { code: 'BBL', name: 'بابل' },
  { code: 'DHI', name: 'ذي قار' },
  { code: 'DYL', name: 'ديالى' },
  { code: 'ANB', name: 'الأنبار' },
  { code: 'KRK', name: 'كركوك' },
  { code: 'WST', name: 'واسط' },
  { code: 'SAH', name: 'صلاح الدين' },
  { code: 'QAD', name: 'القادسية' },
  { code: 'MYS', name: 'ميسان' },
  { code: 'MTH', name: 'المثنى' },
  { code: 'DOH', name: 'دهوك' },
  { code: 'SMH', name: 'السليمانية' },
];

// تطبيع النص العربي: توحيد الهمزات والألف والتاء المربوطة لمطابقة مرنة
function normalizeAr(s) {
  return (s || '')
    .replace(/[إأآا]/g, 'ا')   // كل أشكال الألف → ا
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[ًٌٍَُِّْ]/g, '') // التشكيل
    .trim();
}

// استخراج المحافظة والمنطقة من نص العنوان (منقول طبق الأصل من App.jsx)
// "بغداد - السنك" → {govCode:'BGD', govName:'بغداد', area:'السنك', detail:''}
function extractGovernorate(addressText) {
  const cleanText = (addressText || '').replace(/[*#@!]/g, ' ').replace(/\s+/g, ' ').trim();
  const normText = normalizeAr(cleanText);
  let govCode = '', govName = '', area = '', detail = '';

  // طابق بالنص المطبّع (يتسامح مع الهمزات و"ال")
  const govFound = IRAQ_GOVERNORATES.find((g) => {
    const n = normalizeAr(g.name);
    const nNoAl = n.replace(/^ال/, '');
    return normText.includes(n) || normText.includes(nNoAl);
  });

  if (govFound) {
    govCode = govFound.code;
    govName = govFound.name;
    // احذف المحافظة من النص الأصلي (بكل صيغها المحتملة) لاستخراج الباقي
    const n = normalizeAr(govFound.name);
    const nNoAl = n.replace(/^ال/, '');
    // ابنِ regex يطابق المحافظة في النص الأصلي متسامحاً مع الهمزات
    let rest = cleanText;
    // جرّب حذف الاسم الكامل ثم بدون "ال"
    for (const variant of [govFound.name, govFound.name.replace(/^ال/, ''), n, nNoAl]) {
      const idx = normalizeAr(rest).indexOf(normalizeAr(variant));
      if (idx >= 0) {
        rest = rest.slice(0, idx) + rest.slice(idx + variant.length);
        break;
      }
    }
    rest = rest.replace(/^[\s\-،,]+/, '').trim();
    const parts = rest.split(/[\-،,\s]+/).map((p) => p.trim()).filter(Boolean);
    area = parts[0] || '';
    detail = parts.slice(1).join(' ') || '';
  } else {
    detail = cleanText;
  }
  return { govCode, govName, area, detail };
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

  // ── تفكيك العنوان للحقول الصحيحة المطلوبة من شركة التوصيل (Jenni) ──
  // "الأنبار - الرمادي" → governorate_code=ANB, governorate_name=الأنبار, area=الرمادي
  const geo = extractGovernorate(address);

  return {
    customer_name: customer || 'زبون من المحادثة',
    phone,
    governorate_code: geo.govCode,
    governorate_name: geo.govName,
    area: geo.area,
    address: geo.detail,            // العنوان التفصيلي = الباقي فقط (بدون المحافظة والمنطقة)
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

// ── تطبيع عربي ومطابقة المنطقة بأقرب مدينة رسمية في جيني ──
function normalizeArCity(s) {
  return (s || '')
    .replace(/[إأآا]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .replace(/[ًٌٍَُِّْ]/g, '').replace(/\s+/g, ' ').trim();
}

// مسافة تحرير (Levenshtein) للمطابقة المرنة
function levDist(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      d[i][j] = Math.min(d[i-1][j]+1, d[i][j-1]+1, d[i-1][j-1] + (a[i-1] === b[j-1] ? 0 : 1));
  return d[m][n];
}

// تطابق "بكرجو" → "بكره جو" الرسمية. ترجع اسم المدينة الرسمي أو الأصلي إن لم تجد.
async function matchCityToJenni(areaText, govCode) {
  const area = normalizeArCity(areaText);
  if (!area || !govCode) return areaText;
  try {
    const { data } = await supabase
      .from('jenni_cities')
      .select('city_name, city_name_norm')
      .eq('governorate_code', govCode);
    if (!data || !data.length) return areaText;

    const areaNoSpace = area.replace(/\s/g, '');

    // 1) تطابق تام بعد التطبيع
    let hit = data.find((c) => c.city_name_norm === area);
    if (hit) return hit.city_name;

    // 2) تطابق بإزالة الفراغات
    hit = data.find((c) => (c.city_name_norm || '').replace(/\s/g, '') === areaNoSpace);
    if (hit) return hit.city_name;

    // 3) احتواء جزئي
    hit = data.find((c) => {
      const n = (c.city_name_norm || '').replace(/\s/g, '');
      return n.length >= 3 && (n.includes(areaNoSpace) || areaNoSpace.includes(n));
    });
    if (hit) return hit.city_name;

    // 4) أقرب مدينة بمسافة تحرير ≤ 2 (يحل بكرجو ≈ بكره جو)
    let best = null, bestD = 99;
    for (const c of data) {
      const n = (c.city_name_norm || '').replace(/\s/g, '');
      if (!n) continue;
      const dist = levDist(areaNoSpace, n);
      if (dist < bestD && dist <= 2 && Math.abs(n.length - areaNoSpace.length) <= 2) {
        bestD = dist; best = c;
      }
    }
    if (best) return best.city_name;

    return areaText; // ما لقينا — نرجع الأصلي
  } catch (e) {
    console.error('matchCityToJenni error:', e.message);
    return areaText;
  }
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

    // مطابقة المنطقة بأقرب مدينة رسمية في جيني (بكرجو → بكره جو)
    const matchedCity = await matchCityToJenni(orderData.area, orderData.governorate_code);

    const { data: createdOrder } = await supabase
      .from('alfhd_orders')
      .insert({
        order_no: String(Date.now()).slice(-6),
        page_id: pageId,
        customer_name: orderData.customer_name,
        phone: orderData.phone,
        governorate_code: orderData.governorate_code || null,
        governorate_name: orderData.governorate_name || null,
        area: matchedCity || orderData.area || null,
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
async function saveMessage(msg, direction, pageId) {
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

    const convId = await getOrCreateConv(phone, pushName, direction, content, timestamp, pageId);
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

// ── اتصال واتساب لصفحة معينة (multi-session) ──
async function connectSession(pageId, phone) {
  const s = getSession(pageId);
  const authDir = path.join(AUTH_ROOT, String(pageId));
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();
  console.log(`📱 [${pageId}] Baileys v${version.join('.')}`);

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['Ubuntu', 'Chrome', '22.0.0'],
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  s.sock = sock;

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    // طلب Pairing Code (رقم → كود يدخله المستخدم بواتساب)
    if (!sock.authState.creds.registered && phone && !s.pairingRequestedInternal) {
      s.pairingRequestedInternal = true;
      setTimeout(async () => {
        try {
          const code = await sock.requestPairingCode(phone);
          s.pairingCode = code;
          console.log(`📱 [${pageId}] كود الربط: ${code}`);
        } catch (e) {
          s.pairingRequestedInternal = false;
          console.error(`pairing error [${pageId}]:`, e.message);
        }
      }, 3000);
    }

    if (connection === 'close') {
      s.connected = false;
      s.pairingRequestedInternal = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      const retry = code !== DisconnectReason.loggedOut;
      console.log(`❌ [${pageId}] انقطع (${code}). إعادة: ${retry}`);
      if (retry) {
        setTimeout(() => connectSession(pageId, phone), 5000);
      } else {
        // تسجيل خروج — امسح الجلسة
        if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true });
        delete sessions[pageId];
        console.log(`🗑️ [${pageId}] تسجيل خروج — مُسحت الجلسة`);
      }
    }

    if (connection === 'open') {
      s.connected = true;
      s.pairingCode = null;
      s.phone = sock.user?.id?.split(':')[0];
      console.log(`✅ [${pageId}] واتساب متصل! ${s.phone}`);
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (!msg.message) continue;
      await saveMessage(msg, msg.key.fromMe ? 'outgoing' : 'incoming', pageId);
    }
  });

  return sock;
}

// ── استعادة الجلسات المحفوظة عند الإقلاع ──
async function restoreSessions() {
  try {
    if (!fs.existsSync(AUTH_ROOT)) { fs.mkdirSync(AUTH_ROOT, { recursive: true }); return; }
    const dirs = fs.readdirSync(AUTH_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory());
    for (const d of dirs) {
      const pageId = d.name;
      // تحقق أن الجلسة فيها بيانات اعتماد
      const credsFile = path.join(AUTH_ROOT, pageId, 'creds.json');
      if (fs.existsSync(credsFile)) {
        console.log(`🔄 استعادة جلسة الصفحة ${pageId}...`);
        await connectSession(pageId, null);
      }
    }
  } catch (e) {
    console.error('restoreSessions error:', e.message);
  }
}

console.log('🚀 AlFhd WhatsApp Bridge (multi-session) starting...');
restoreSessions().catch(console.error);
