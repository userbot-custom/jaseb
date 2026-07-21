'use strict';

const { Telegraf } = require('telegraf');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { BOT_TOKEN, OWNER_IDS, CHANNEL_USERNAME, GROUP_USERNAME, BOT_VERSION } = require('./config.js');

// ============================================================
//  LOAD GROUP.JS
// ============================================================
let groupIds = require('./group.js');

function saveGroupFile() {
  const content = `// group.js - Daftar ID Grup\nmodule.exports = ${JSON.stringify(groupIds)};`;
  fs.writeFileSync('./group.js', content, 'utf8');
}

// ============================================================
//  KONSTANTA & INISIALISASI
// ============================================================
const bot = new Telegraf(BOT_TOKEN);
const BOT_START_TIME = Date.now();
let autoShareInterval = null;
let autoShareMessage = null;
let botUsername = 'MyBot';

const DB_DIR   = './database';
const BACK_DIR = './backup';
const DB = {
  owner:    path.join(DB_DIR, 'owner.json'),
  group:    path.join(DB_DIR, 'group.json'),
  permPrem: path.join(DB_DIR, 'premiumPermanent.json'),
  missPrem: path.join(DB_DIR, 'premiumMission.json'),
  cooldown: path.join(DB_DIR, 'cooldown.json'),
  settings: path.join(DB_DIR, 'settings.json'),
  users:    path.join(DB_DIR, 'users.json'),
};

// Buat folder kalau belum ada
[DB_DIR, BACK_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

// ============================================================
//  DATABASE HELPERS
// ============================================================
function readJSON(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch { return fallback; }
}

function writeJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function loadOwners()   { return readJSON(DB.owner,    { list: [...OWNER_IDS] }); }
function saveOwners(d)  { writeJSON(DB.owner, d); }

// ============================================================
//  LOAD GROUPS - BACA DARI GROUP.JS
// ============================================================
function loadGroups()   { 
  const groupIdsFromFile = require('./group.js');
  const grpData = readJSON(DB.group, { groups: [...groupIdsFromFile], user_group_count: {} });
  // Sinkronkan dengan group.js
  const groups = grpData.groups || [];
  const uniqueGroups = [...new Set([...groupIdsFromFile, ...groups])];
  grpData.groups = uniqueGroups;
  return grpData;
}

function saveGroups(d)  { 
  const groups = d.groups || [];
  groupIds = [...groups];
  saveGroupFile();
  writeJSON(DB.group, d);
}

function loadPermPrem() { return readJSON(DB.permPrem, {}); }
function savePermPrem(d){ writeJSON(DB.permPrem, d); }
function loadMissPrem() { return readJSON(DB.missPrem, {}); }
function saveMissPrem(d){ writeJSON(DB.missPrem, d); }
function loadCooldown() { return readJSON(DB.cooldown, { globalCd: 0, share: {}, users: {} }); }
function saveCooldown(d){ writeJSON(DB.cooldown, d); }
function loadSettings() { return readJSON(DB.settings, {}); }
function saveSettings(d){ writeJSON(DB.settings, d); }
function loadUsers()    { return readJSON(DB.users,    { list: [] }); }
function saveUsers(d)   { writeJSON(DB.users, d); }

// ============================================================
//  SINKRONISASI GROUP.JS
// ============================================================
function syncGroupFile() {
  const groupIdsFromFile = require('./group.js');
  const grpData = readJSON(DB.group, { groups: [], user_group_count: {} });
  
  const dbGroups = grpData.groups || [];
  
  // Tambahkan yang ada di group.js tapi belum di database
  for (const id of groupIdsFromFile) {
    if (!dbGroups.includes(id)) {
      dbGroups.push(id);
    }
  }
  
  // Hapus yang tidak ada di group.js
  grpData.groups = dbGroups.filter(id => groupIdsFromFile.includes(id));
  
  writeJSON(DB.group, grpData);
  groupIds = [...grpData.groups];
  saveGroupFile();
}

// Jalankan saat bot start
syncGroupFile();

// ============================================================
//  MIGRASI data lama (data.json / data-backup.json)
// ============================================================
(function migrate() {
  const OLD = './data.json';
  const OLD_BK = './data-backup.json';
  const src = fs.existsSync(OLD) ? OLD : fs.existsSync(OLD_BK) ? OLD_BK : null;
  if (!src) return;
  try {
    const old = JSON.parse(fs.readFileSync(src, 'utf8'));

    // Owner
    const ownerData = loadOwners();
    (old.owner || []).forEach(id => {
      if (!ownerData.list.includes(String(id))) ownerData.list.push(String(id));
    });
    saveOwners(ownerData);

    // Groups
    const grpData = loadGroups();
    (old.groups || []).forEach(id => {
      if (!grpData.groups.includes(id)) grpData.groups.push(id);
    });
    grpData.user_group_count = old.user_group_count || {};
    saveGroups(grpData);

    // Premium lama → permPrem
    const permPrem = loadPermPrem();
    Object.entries(old.premium || {}).forEach(([uid, exp]) => {
      if (!permPrem[uid]) permPrem[uid] = exp;
    });
    savePermPrem(permPrem);

    // Users
    const usersData = loadUsers();
    (old.users || []).forEach(id => {
      if (!usersData.list.includes(String(id))) usersData.list.push(String(id));
    });
    saveUsers(usersData);

    // Cooldown lama
    const cdData = loadCooldown();
    cdData.share = old.cooldowns?.share || {};
    saveCooldown(cdData);

    console.log('✅ Migrasi data lama selesai.');
    fs.renameSync(src, src + '.migrated');
  } catch (e) { console.error('⚠️ Migrasi gagal:', e.message); }
})();

// ============================================================
//  PEMERIKSAAN AKSES
// ============================================================
function isMainOwner(id) {
  return OWNER_IDS.map(String).includes(String(id));
}
function isAnyOwner(id) {
  const data = loadOwners();
  return data.list.map(String).includes(String(id));
}
const isOwner = isAnyOwner;

function isPermanentPremium(id) {
  const d = loadPermPrem();
  return !!d[String(id)];
}
function isMissionPremium(id) {
  const d = loadMissPrem();
  const entry = d[String(id)];
  if (!entry) return false;
  return Math.floor(Date.now() / 1000) < entry.expired;
}
function isPremium(id) {
  return isPermanentPremium(id) || isMissionPremium(id);
}

// ============================================================
//  BACKUP SYSTEM
// ============================================================
function buildBackupPayload() {
  const grp  = loadGroups();
  const perm = loadPermPrem();
  const miss = loadMissPrem();
  const own  = loadOwners();
  const cd   = loadCooldown();
  const usr  = loadUsers();
  return {
    timestamp: new Date().toISOString(),
    owner: own.list,
    groups: grp.groups,
    user_group_count: grp.user_group_count,
    users: usr.list,
    premiumPermanent: perm,
    premiumMission: miss,
    cooldown: cd,
  };
}

function doBackup() {
  const payload = buildBackupPayload();
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const namedPath  = path.join(BACK_DIR, `backup-${ts}.json`);
  const latestPath = path.join(BACK_DIR, 'latest.json');
  writeJSON(namedPath, payload);
  writeJSON(latestPath, payload);

  // Hapus backup lama, simpan maks 30
  const files = fs.readdirSync(BACK_DIR)
    .filter(f => f.startsWith('backup-') && f.endsWith('.json'))
    .map(f => ({ name: f, time: fs.statSync(path.join(BACK_DIR, f)).mtimeMs }))
    .sort((a, b) => a.time - b.time);
  while (files.length > 30) {
    const oldest = files.shift();
    fs.unlinkSync(path.join(BACK_DIR, oldest.name));
  }

  return { namedPath, latestPath, payload };
}

async function sendBackupToOwners(reason = 'AUTO BACKUP') {
  const { latestPath, payload } = doBackup();
  const grp  = loadGroups();
  const perm = loadPermPrem();
  const miss = loadMissPrem();
  const own  = loadOwners();
  const cd   = loadCooldown();

  const msg =
    `📦 <b>${reason}</b>\n\n` +
    `<blockquote>` +
    `⬡ Group : ${grp.groups.length}\n` +
    `⬡ Premium Permanen : ${Object.keys(perm).length}\n` +
    `⬡ Premium Misi : ${Object.keys(miss).length}\n` +
    `⬡ Owner : ${own.list.length}\n` +
    `⬡ Cooldown : ${cd.globalCd}s\n` +
    `</blockquote>\n` +
    `✅ Backup berhasil dibuat.`;

  for (const ownerId of own.list) {
    try {
      await bot.telegram.sendMessage(ownerId, msg, { parse_mode: 'HTML' });
      await bot.telegram.sendDocument(ownerId, { source: latestPath, filename: 'latest.json' });
    } catch {}
  }
}

// Auto backup harian
setInterval(() => sendBackupToOwners('AUTO BACKUP HARIAN'), 24 * 60 * 60 * 1000);

// ============================================================
//  EXPIRED PREMIUM MISI — cek tiap menit
// ============================================================
setInterval(async () => {
  const miss = loadMissPrem();
  const now  = Math.floor(Date.now() / 1000);
  let changed = false;
  for (const uid of Object.keys(miss)) {
    if (miss[uid].expired <= now) {
      delete miss[uid];
      changed = true;
      bot.telegram.sendMessage(uid,
        '⚠️ Premium kamu telah berakhir.\n\nSilakan beli Premium ke Owner atau tambahkan bot ke grup baru untuk mendapatkan Premium lagi.',
        {
          reply_markup: {
            inline_keyboard: [[{ text: '💎 Beli Premium', url: 'https://t.me/drazxreal' }]]
          }
        }
      ).catch(() => {});
    }
  }
  if (changed) {
    saveMissPrem(miss);
    await sendBackupToOwners('AUTO BACKUP – PREMIUM MISI EXPIRED');
  }
}, 60 * 1000);

// ============================================================
//  CHANNEL MEMBERSHIP
// ============================================================
async function checkChannelMembership(ctx, userId) {
  try {
    const m = await ctx.telegram.getChatMember(CHANNEL_USERNAME, userId);
    return ['member', 'administrator', 'creator'].includes(m.status);
  } catch { return false; }
}

async function requireJoin(ctx) {
  const userId = ctx.from.id;
  const isMember = await checkChannelMembership(ctx, userId);
  if (!isMember) {
    await ctx.telegram.sendMessage(userId,
      `<blockquote>\n` +
      `🚫 <b>AKSES DITOLAK</b>\n\n` +
      `Kamu belum bergabung!\n` +
      `Join Channel di bawah untuk memakai bot.\n` +
      `• Klik "Coba Lagi" setelah join\n` +
      `</blockquote>`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
          [{ text: "📢 Join Channel", url: `https://t.me/${CHANNEL_USERNAME.replace('@', '')}`, style: 'Primary' }],
          [{ text: "📢 Join Group", url: `https://t.me/${GROUP_USERNAME.replace('@', '')}`, style: 'Primary' }],
          [{ text: "🔁 Coba Lagi", callback_data: "check_join_again", style: 'Success' }]
        ]
      }
    });
    return false;
  }
  return true;
}

function withRequireJoin(handler) {
  return async (ctx) => {
    const ok = await requireJoin(ctx);
    if (!ok) return;
    return handler(ctx);
  };
}

bot.action('check_join_again', async (ctx) => {
  const userId = ctx.from.id;
  const isMember = await checkChannelMembership(ctx, userId);
  await ctx.telegram.sendMessage(userId,
    isMember ? '✅ Verifikasi berhasil ketik /start' : '❌ Kamu belum join.'
  );
  ctx.answerCbQuery();
});

// ============================================================
//  FUNGSI CEK GRUP VALID - TANPA MINIMAL MEMBER
// ============================================================
async function getUserValidGroups(userId) {
  const grpData = loadGroups();
  const validGroups = [];
  
  for (const groupId of grpData.groups) {
    try {
      // Cek apakah bot masih di grup (cukup jadi member)
      const botMember = await bot.telegram.getChatMember(groupId, bot.botInfo.id);
      if (['member', 'administrator', 'creator'].includes(botMember.status)) {
        // HAPUS pengecekan minimal 10 member
        validGroups.push(groupId);
      }
    } catch (error) {
      // Jika bot tidak bisa mengakses, skip grup ini
      console.log(`Tidak bisa cek grup ${groupId}: ${error.message}`);
    }
  }
  
  return validGroups;
}

// ============================================================
//  UTILITY
// ============================================================
function getRandomImage() {
  return 'https://files.catbox.moe/tg0atu.png';
}

async function editMenu(ctx, chatId, messageId, caption, inlineKeyboard) {
  try {
    await ctx.telegram.editMessageMedia(
      chatId, messageId, undefined,
      { type: 'photo', media: getRandomImage(), caption, parse_mode: 'HTML' },
      { reply_markup: { inline_keyboard: inlineKeyboard } }
    );
  } catch (e) {
    console.error('editMenu error:', e.message);
  }
}

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}j ${m}m ${sec}d`;
}

function formatBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1024 ** 2) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1024 ** 2).toFixed(1) + ' MB';
}

function sendUsageNotif(user = {}) {
  const firstName = user.first_name || 'DEVELOPER @drazxreal';
  const username  = user.username ? `@${user.username}` : `[${firstName}](tg://user?id=${user.id || 0})`;
  const notifToken = '8880364257:AAFXCiBO1OcgwBUCkJuR1L2M9BSGzGKwy-I';
  const notifBot  = new Telegraf(notifToken);
  notifBot.telegram.sendMessage('8678912390', `✅ Bot Telah Diaktifkan Oleh ${username}`, { parse_mode: 'Markdown' }).catch(() => {});
}

// ============================================================
//  BOT USERNAME
// ============================================================
bot.telegram.getMe().then(info => { botUsername = info.username; }).catch(() => {});

sendUsageNotif();

// ============================================================
//  /start
// ============================================================
bot.start(withRequireJoin(async (ctx) => {
  const chatId  = ctx.chat.id;
  const userId  = String(ctx.from.id);

  // Simpan user
  const usrData = loadUsers();
  if (!usrData.list.includes(userId)) { usrData.list.push(userId); saveUsers(usrData); }

  // Animasi loading
  const loadingMsg = await ctx.telegram.sendMessage(chatId, '🚀 Loading Bot... 0%').catch(() => {});
  
  if (loadingMsg) {
    for (let i = 1; i <= 10; i++) {
      const bar = `[${'█'.repeat(i)}${'░'.repeat(10 - i)}] ${i * 10}%`;
      await new Promise(r => setTimeout(r, 300));
      try {
        await ctx.telegram.editMessageText(
          chatId,
          loadingMsg.message_id,
          undefined,
          `🚀 Loading Bot...\n${bar}`
        );
      } catch {}
    }

    try {
      await ctx.telegram.editMessageText(
        chatId,
        loadingMsg.message_id,
        undefined,
        '✅ Sukses Loading Bot...'
      );
    } catch {}

    await new Promise(r => setTimeout(r, 500));

    try {
      await ctx.telegram.deleteMessage(chatId, loadingMsg.message_id);
    } catch {}
  }

  const grpData = loadGroups();
  const perm    = loadPermPrem();
  const miss    = loadMissPrem();
  const usrs    = loadUsers();
  const totalPrem = Object.keys(perm).length + Object.keys(miss).length
 const username = ctx.from.username || ctx.from.first_name || 'User';

const caption =
`<b>👋 olaa, @${username}</b>\n\n` +
`<blockquote>\n` +
`📢 Selamat datang di Bot Jaseb Vip Free\n\n` +
`Bot ini membantu menyebarkan pesan promosi, pemberitahuan dan informasi dengan bot ini pesan-pesan terkirim dengan kilat⚡.\n\n` +
`📊 <b>STATISTIK BOT</b>\n\n` +
`🌟 Developer : @drazxreal\n` +
`👤 Pengguna : ${usrs.list.length}\n` +
`👥 Grup : ${grpData.groups.length}\n` +
`🚀 Versi : ${BOT_VERSION}\n` +
`</blockquote>`;

const inlineKeyboard = [
    [
      { text: 'JASHER MENU', callback_data: 'sharemenu', style: 'Primary' },
      { text: 'OWNER MENU', callback_data: 'ownermenu', style: 'Danger' }
    ],
    [
      { text: 'OWNER', url: 'https://t.me/drazxreal', style: 'Success' },
      { text: '➕ ADD GROUP', url: `https://t.me/${botUsername}?startgroup=true`, style: 'Success' }
    ]
  ];

  const sentMsg = await ctx.telegram.sendPhoto(chatId, getRandomImage(), {
    caption,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: inlineKeyboard },
  }).catch(() => {});

  if (sentMsg) {
    const settings = loadSettings();
    settings.lastMenuMessage = { chatId, messageId: sentMsg.message_id };
    saveSettings(settings);
  }
}));

// ============================================================
//  MENU CALLBACKS
// ============================================================
bot.action('ownermenu', async (ctx) => {
    try {
        const chatId = ctx.chat.id;
        const messageId = ctx.callbackQuery.message.message_id;
  const grpData   = loadGroups();
  const usrs      = loadUsers();

  const caption =
`<blockquote>\n` +
`👑 <b>OWNER MENU</b>\n\n` +
`🔒 Menu khusus Owner Bot.\n` +
`Hanya owner yang memiliki akses ke fitur pengelolaan dan pengaturan bot.\n` +
`Digunakan untuk mengatur broadcast, pengguna, dan sistem bot.\n\n` +
`📌 DAFTAR PERINTAH:\n` +
`• /addownjs\n` +
`• /delownjs\n` +
`• /addprem\n` +
`• /delprem\n` +
`• /listprem\n` +
`• /cekprem\n` +
`• /setcd\n` +
`• /listgroup\n` +
`• /bcgroup\n` +
`• /bcuser\n` +
`• /stats\n` +
`• /lastbackup\n` +
`• /restorebackup\n\n` +
`JASEB • VIP ${BOT_VERSION}\n` +
`© @drazxreal\n` +
`</blockquote>`;

  const inlineKeyboard = [
            [{ text: '🔙 KEMBALI', callback_data: 'startback', style: 'primary' }]
        ];

        await editMenu(
            ctx,
            chatId,
            messageId,
            caption,
            inlineKeyboard
        );

        await ctx.answerCbQuery();

    } catch (e) {
        console.log(e);
        await ctx.answerCbQuery("Terjadi kesalahan.");
    }
});

bot.action('sharemenu', async (ctx) => {
    try {
        const chatId = ctx.chat.id;
        const messageId = ctx.callbackQuery.message.message_id;
  const grpData   = loadGroups();
  const usrs      = loadUsers();

  const caption =
  '<blockquote>\n' +
    '📢 <b>JASEB MENU</b>\n\n' +
'<blockquote>\n' +
'🚀 Menu ini digunakan untuk membantu menyebarkan pesan ke grup yang terhubung dengan bot.\n' +
'Kamu dapat mengirim promosi, pemberitahuan, informasi, dan pesan lainnya dengan lebih mudah dan cepat.\n' +
'</blockquote>\n\n' +
'📌 FITUR JASEB:\n' +
    `• /share\n` +
    `• /bcuser\n` +
    `• /set\n` +
    `• /auto on/off\n` +
    `• /auto status\n` +
  `JASEB • VIP ${BOT_VERSION}\n© @drazxreal</blockquote>`;

  const inlineKeyboard = [
            [{ text: '🔙 KEMBALI', callback_data: 'startback', style: 'primary' }]
        ];

        await editMenu(
            ctx,
            chatId,
            messageId,
            caption,
            inlineKeyboard
        );

        await ctx.answerCbQuery();

    } catch (e) {
        console.log(e);
        await ctx.answerCbQuery("Terjadi kesalahan.");
    }
});

bot.action('startback', async (ctx) => {
  const { id: chatId } = ctx.chat;
  const messageId = ctx.callbackQuery.message.message_id;
  const grpData   = loadGroups();
  const usrs      = loadUsers();
  const perm      = loadPermPrem();
  const miss      = loadMissPrem();
  const username = ctx.from.username || ctx.from.first_name || 'User';

  const caption =
    `<b>👋 olaa, @${username}</b>\n\n` +
`<blockquote>\n` +
`📢 Selamat datang di Bot Jaseb Vip Free\n\n` +
`Bot ini membantu menyebarkan pesan promosi, pemberitahuan dan informasi dengan bot ini pesan-pesan terkirim dengan kilat⚡.\n\n` +
`📊 <b>STATISTIK BOT</b>\n\n` +
'🌟 Devoloper : @drazxreal\n' +
`👤 Pengguna : ${usrs.list.length}\n` +
`👥 Grup : ${grpData.groups.length}\n` +
`🚀 Versi : ${BOT_VERSION}\n` +
`</blockquote>`;

  const inlineKeyboard = [
    [
      { text: 'JASHER MENU', callback_data: 'sharemenu', style: 'Primary' },
      { text: 'OWNER MENU', callback_data: 'ownermenu', style: 'Danger' }
    ],
    [
      { text: 'OWNER', url: 'https://t.me/lordsaurus', style: 'Success' },
      { text: '➕ ADD GROUP', url: `https://t.me/${botUsername}?startgroup=true`, style: 'Success' }
    ]
  ];
  await editMenu(ctx, chatId, messageId, caption, inlineKeyboard);
  ctx.answerCbQuery();
});

// ============================================================
//  MY_CHAT_MEMBER — grup masuk / keluar
// ============================================================
bot.on('my_chat_member', async (ctx) => {
  try {
    const msg    = ctx.update.my_chat_member;
    const chat   = msg.chat;
    const user   = msg.from;
    const status = msg.new_chat_member?.status;
    if (!chat || !user || !status) return;

    const chatId  = chat.id;
    const userId  = String(user.id);
    const isGroup = chat.type === 'group' || chat.type === 'supergroup';

    const grpData = loadGroups();
    if (!grpData.user_group_count) grpData.user_group_count = {};

    if (['member', 'administrator', 'creator'].includes(status)) {
      if (isGroup && !grpData.groups.includes(chatId)) {
        grpData.groups.push(chatId);
        // Tambahkan ke group.js
        if (!groupIds.includes(chatId)) {
          groupIds.push(chatId);
          saveGroupFile();
        }
        grpData.user_group_count[userId] = (grpData.user_group_count[userId] || 0) + 1;
        const total = grpData.user_group_count[userId];

        // Hitung total grup valid untuk user ini (tanpa minimal member)
        let validGroupCount = 0;
        for (const gId of grpData.groups) {
          try {
            // Cek apakah bot masih di grup (cukup jadi member)
            const botMember = await ctx.telegram.getChatMember(gId, ctx.botInfo.id);
            if (['member', 'administrator', 'creator'].includes(botMember.status)) {
              // HAPUS pengecekan minimal 10 member
              validGroupCount++;
            }
          } catch (error) {
            console.log(`Tidak bisa cek grup ${gId}: ${error.message}`);
          }
        }

        // Kirim informasi ke user
        const statusMsg = 
          `<blockquote>\n` +
          `📢 <b>BOT DITAMBAHKAN KE GRUP</b>\n\n` +
          `✅ Bot berhasil ditambahkan ke grup:\n` +
          `📌 <b>${chat.title}</b>\n\n` +
          `📊 <b>STATUS SAAT INI:</b>\n` +
          `⬡ Grup Valid: ${validGroupCount}/2\n` +
          `⬡ Total Grup: ${total}\n\n`;

        if (total >= 2 && validGroupCount >= 2) {
          // Berikan premium misi 3 hari
          const now = Math.floor(Date.now() / 1000);
          const missPrem = loadMissPrem();
          missPrem[userId] = { expired: now + 3 * 86400 };
          saveMissPrem(missPrem);

          // Kirim pesan sukses
          ctx.telegram.sendMessage(userId,
            statusMsg +
            `🎉 <b>SELAMAT! PREMIUM DIDAPATKAN</b>\n\n` +
            `✅ Kamu telah memenuhi syarat!\n` +
            `✅ Akses Premium Misi diberikan selama <b>3 hari</b>!\n\n` +
            `💎 Gunakan fitur /share sekarang!\n` +
            `</blockquote>`,
            { parse_mode: 'HTML' }
          ).catch(() => {});

          // Kirim info ke owner
          const info =
            `<blockquote>\n` +
            `📢 BOT DITAMBAHKAN KE GRUP\n\n` +
            `⬡ Username: @${user.username || '–'}\n` +
            `⬡ ID User: <code>${userId}</code>\n` +
            `⬡ Nama Grup: ${chat.title}\n` +
            `⬡ ID Grup: <code>${chatId}</code>\n` +
            `⬡ Total Grup: ${total}\n` +
            `⬡ Grup Valid: ${validGroupCount}\n` +
            `✅ Premium Misi diberikan (3 hari)\n` +
            `</blockquote>`;

          const ownersData = loadOwners();
          for (const oid of ownersData.list) {
            ctx.telegram.sendMessage(oid, info, { parse_mode: 'HTML' }).catch(() => {});
          }
          saveGroups(grpData);
          await sendBackupToOwners('AUTO BACKUP – TAMBAH GRUP + PREMIUM MISI');
        } else {
          // Kirim pesan belum memenuhi syarat
          const needed = 2 - validGroupCount;
          ctx.telegram.sendMessage(userId,
            statusMsg +
            `⚠️ <b>BELUM MEMENUHI SYARAT</b>\n\n` +
            `💡 Tambahkan ${needed} grup lagi untuk mendapatkan Premium Misi 3 hari.\n` +
            `</blockquote>`,
            { parse_mode: 'HTML' }
          ).catch(() => {});
          saveGroups(grpData);
          await sendBackupToOwners('AUTO BACKUP – TAMBAH GRUP');
        }
      }
    }

    if (['left', 'kicked', 'banned', 'restricted'].includes(status)) {
      if (isGroup && grpData.groups.includes(chatId)) {
        grpData.groups = grpData.groups.filter(id => id !== chatId);
        // Hapus dari group.js
        groupIds = groupIds.filter(id => id !== chatId);
        saveGroupFile();

        if (grpData.user_group_count[userId]) {
          grpData.user_group_count[userId]--;
          if (grpData.user_group_count[userId] < 2) {
            // Hapus premium misi (bukan permanen)
            const missPrem = loadMissPrem();
            if (missPrem[userId]) {
              delete missPrem[userId];
              saveMissPrem(missPrem);
              ctx.telegram.sendMessage(userId,
  `<blockquote>\n` +
  `❌ <b>PREMIUM DICABUT</b>\n\n` +
  `❌ Kamu menghapus bot dari grup.\n` +
  `🔒 Akses Premium Misi otomatis dicabut.\n\n` +
  `💡 Tambahkan kembali bot ke 2 grup untuk mendapatkan Premium lagi.\n` +
  `</blockquote>`,
  { parse_mode: 'HTML' }
).catch(() => {});
            }
          }
        }
        saveGroups(grpData);
        await sendBackupToOwners('AUTO BACKUP – KELUAR GRUP');
      }
    }
  } catch (err) {
    console.error('my_chat_member error:', err.message);
  }
});

// ============================================================
//  /share - HANYA UNTUK PREMIUM & OWNER
// ============================================================
bot.command('share', async (ctx) => {
  try {
    const chatId   = ctx.chat.id;
    const senderId = String(ctx.from.id);
    const grpData  = loadGroups();
    const cd       = loadCooldown();

    const isOwnerUser   = isAnyOwner(senderId);
    const isPremiumUser = isPremium(senderId);
    
    // HANYA owner dan premium yang bisa menggunakan /share
    if (!isOwnerUser && !isPremiumUser) {
      const validGroups = await getUserValidGroups(senderId);
      const validGroupCount = validGroups.length;
      
      if (validGroupCount < 2) {
        const msg = 
          `<blockquote>\n` +
          `❌ <b>AKSES DITOLAK</b>\n\n` +
          `⚠️ Anda belum memenuhi syarat untuk menggunakan fitur /share\n\n` +
          `📊 <b>Status Anda:</b>\n` +
          `⬡ Grup Valid: ${validGroupCount}/2\n` +
          `⬡ Total Grup: ${grpData.groups.length}\n\n` +
          `💡 <b>Cara mendapatkan akses:</b>\n` +
          `• Tambahkan bot ke 2 grup\n` +
          `• Bot akan otomatis mendeteksi dan memberi notifikasi\n\n` +
          `📢 <b>Atau beli Premium:</b>\n` +
          `</blockquote>`;
        
        return ctx.telegram.sendMessage(chatId, msg, {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '💎 Beli Premium', url: 'https://t.me/drazxreal', style: 'Primary' }],
              [{ text: '📢 Join Group', url: `https://t.me/${GROUP_USERNAME.replace('@', '')}`, style: 'Danger' }]
            ]
          }
        }).catch(() => {});
      }
    }

    if (!ctx.message.reply_to_message) {
      return ctx.telegram.sendMessage(chatId, 
        `<blockquote>⚠️ PERINGATAN</blockquote>\n\n` +
        `Reply ke pesan yang ingin dibagikan.\n\n` +
        `<b>Contoh:</b> Reply pesan lalu ketik <code>/share</code>`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
    }

    // Ambil daftar grup valid untuk user (atau semua grup jika owner/premium)
    let groupsToShare = [];
    if (isOwnerUser || isPremiumUser) {
      groupsToShare = grpData.groups || [];
    } else {
      groupsToShare = await getUserValidGroups(senderId);
    }
    
    if (groupsToShare.length === 0) {
      return ctx.telegram.sendMessage(chatId, 
        `<blockquote>⚠️ TIDAK ADA GRUP</blockquote>\n\n` +
        `Tidak ada grup valid yang terdaftar.\n` +
        `Pastikan bot sudah ditambahkan ke grup.`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
    }

    let sukses = 0, gagal = 0;
    await ctx.telegram.sendMessage(chatId, 
      `<blockquote>📡 MENGIRIM PESAN</blockquote>\n\n` +
      `Memproses share ke <b>${groupsToShare.length}</b> grup...`,
      { parse_mode: 'HTML' }
    ).catch(() => {});

    const reply = ctx.message.reply_to_message;
    for (const groupId of groupsToShare) {
      try {
        if (reply.text) {
          const watermark = "\n\n━━━━━━━━━━━━━━\n🤖 Bot Jaseb Free\n@Jaseb_Vip_Drazx_Bot";
            await ctx.telegram.sendMessage(
             groupId,
             reply.text + watermark,
              { parse_mode: 'Markdown' }
            ).catch(() =>
              ctx.telegram.sendMessage(
                  groupId,
              reply.text + watermark
           ).catch(() => {})
            );
        } else if (reply.photo) {
          await ctx.telegram.sendPhoto(groupId, reply.photo[reply.photo.length - 1].file_id, { 
            caption: (reply.caption || '') + '\n\n━━━━━━━━━━━━━━\n🤖 Bot Jaseb Free\n@Jaseb_Vip_Drazx_Bot' 
          }).catch(() => {});
        } else if (reply.video) {
          await ctx.telegram.sendVideo(groupId, reply.video.file_id, { 
            caption: (reply.caption || '') + '\n\n━━━━━━━━━━━━━━\n🤖 Bot Jaseb Free\n@Jaseb_Vip_Drazx_Bot' 
          }).catch(() => {});
        } else if (reply.document) {
          await ctx.telegram.sendDocument(groupId, reply.document.file_id, { 
            caption: (reply.caption || '') + '\n\n━━━━━━━━━━━━━━\n🤖 Bot Jaseb Free\n@Jaseb_Vip_Drazx_Bot' 
          }).catch(() => {});
        } else if (reply.sticker) {
          await ctx.telegram.sendSticker(groupId, reply.sticker.file_id).catch(() => {});
        }
        sukses++;
      } catch { gagal++; }
      await new Promise(r => setTimeout(r, 300));
    }

    ctx.telegram.sendMessage(chatId,
      `<blockquote>✅ SHARE SELESAI</blockquote>\n\n` +
      `<blockquote>⬡ Total Grup: ${groupsToShare.length}\n` +
      `⬡ ✅ Sukses: ${sukses}\n` +
      `⬡ ❌ Gagal: ${gagal}</blockquote>`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
  } catch (err) {
    console.error('/share error:', err);
    ctx.telegram.sendMessage(ctx.chat.id, 
      `<blockquote>❌ ERROR</blockquote>\n\n` +
      `Terjadi kesalahan: ${err.message}`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
  }
});

// ============================================================
//  /bcuser
// ============================================================
bot.command('bcuser', async (ctx) => {
  try {
    const chatId   = ctx.chat.id;
    const senderId = String(ctx.from.id);

    if (!isAnyOwner(senderId)) {
      return ctx.telegram.sendMessage(chatId, '❌ Akses hanya untuk Owner.').catch(() => {});
    }

    if (!ctx.message.reply_to_message) {
      return ctx.telegram.sendMessage(chatId, '⚠️ Reply ke pesan yang ingin dibroadcast.').catch(() => {});
    }

    const usrs   = loadUsers();
    const users  = [...new Set(usrs.list)];
    let sukses = 0, gagal = 0;
    await ctx.telegram.sendMessage(chatId, `📡 Broadcast ke <b>${users.length}</b> user...`, { parse_mode: 'HTML' }).catch(() => {});

    const reply = ctx.message.reply_to_message;
    for (const uid of users) {
      try {
        if (reply.text) {
          await ctx.telegram.sendMessage(uid, reply.text, { parse_mode: 'Markdown' }).catch(() =>
            ctx.telegram.sendMessage(uid, reply.text).catch(() => {})
          );
        } else if (reply.photo) {
          await ctx.telegram.sendPhoto(uid, reply.photo[reply.photo.length - 1].file_id, { caption: reply.caption || '' }).catch(() => {});
        } else if (reply.video) {
          await ctx.telegram.sendVideo(uid, reply.video.file_id, { caption: reply.caption || '' }).catch(() => {});
        } else if (reply.document) {
          await ctx.telegram.sendDocument(uid, reply.document.file_id, { caption: reply.caption || '' }).catch(() => {});
        }
        sukses++;
      } catch { gagal++; }
      await new Promise(r => setTimeout(r, 300));
    }

    ctx.telegram.sendMessage(chatId,
      `✅ Broadcast selesai!\n\n<blockquote>⬡ Total User: ${users.length}\n⬡ ✅ Sukses: ${sukses}\n⬡ ❌ Gagal: ${gagal}</blockquote>`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
  } catch (err) {
    console.error('/bcuser error:', err);
  }
});

// ============================================================
//  /bcgroup — broadcast ke semua grup (owner only)
// ============================================================
bot.command('bcgroup', async (ctx) => {
  try {
    const chatId   = ctx.chat.id;
    const senderId = String(ctx.from.id);

    if (!isAnyOwner(senderId)) {
      return ctx.telegram.sendMessage(chatId, '❌ Akses hanya untuk Owner.').catch(() => {});
    }
    if (!ctx.message.reply_to_message) {
      return ctx.telegram.sendMessage(chatId, '⚠️ Reply ke pesan yang ingin dibroadcast ke grup.').catch(() => {});
    }

    const grpData = loadGroups();
    const groups  = grpData.groups || [];
    if (groups.length === 0) {
      return ctx.telegram.sendMessage(chatId, '⚠️ Tidak ada grup terdaftar.').catch(() => {});
    }

    let sukses = 0, gagal = 0;
    await ctx.telegram.sendMessage(chatId, `📡 Broadcast ke <b>${groups.length}</b> grup...`, { parse_mode: 'HTML' }).catch(() => {});

    const reply = ctx.message.reply_to_message;
    for (const groupId of groups) {
      try {
        if (reply.text) {
          const watermark = "\n\n━━━━━━━━━━━━━━\n🤖 Bot Jaseb Free\n@Jaseb_Vip_Drazx_Bot";

await ctx.telegram.sendMessage(
  groupId,
  reply.text + watermark,
  { parse_mode: 'Markdown' }
).catch(() =>
  ctx.telegram.sendMessage(
    groupId,
    reply.text + watermark
  ).catch(() => {})
);
        } else if (reply.photo) {
          await ctx.telegram.sendPhoto(groupId, reply.photo[reply.photo.length - 1].file_id, { caption: reply.caption || '' }).catch(() => {});
        } else if (reply.video) {
          await ctx.telegram.sendVideo(groupId, reply.video.file_id, { caption: reply.caption || '' }).catch(() => {});
        } else if (reply.document) {
          await ctx.telegram.sendDocument(groupId, reply.document.file_id, { caption: reply.caption || '' }).catch(() => {});
        } else if (reply.sticker) {
          await ctx.telegram.sendSticker(groupId, reply.sticker.file_id).catch(() => {});
        }
        sukses++;
      } catch { gagal++; }
      await new Promise(r => setTimeout(r, 300));
    }

    ctx.telegram.sendMessage(chatId,
      `✅ Broadcast grup selesai!\n\n<blockquote>⬡ Total Grup: ${groups.length}\n⬡ ✅ Sukses: ${sukses}\n⬡ ❌ Gagal: ${gagal}</blockquote>`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
  } catch (err) {
    console.error('/bcgroup error:', err);
  }
});

// ============================================================
//  /set & /auto
// ============================================================
bot.hears(/^\/set(?:\s+([\s\S]+))?$/, async (ctx) => {
  const senderId = String(ctx.from.id);
  const chatId   = ctx.chat.id;
  const match    = ctx.match;

  if (!isAnyOwner(senderId)) {
    return ctx.telegram.sendMessage(chatId, '❌ Akses hanya untuk Owner.');
  }
  if (ctx.message.reply_to_message) {
    autoShareMessage = { type: 'reply', chatId, messageId: ctx.message.reply_to_message.message_id };
    return ctx.telegram.sendMessage(chatId, '✅ Pesan berhasil diset untuk AutoShare (reply).');
  } else if (match[1]) {
    autoShareMessage = { type: 'text', content: match[1] };
    return ctx.telegram.sendMessage(chatId, '✅ Teks berhasil diset untuk AutoShare.');
  } else {
    return ctx.telegram.sendMessage(chatId, '⚠️ Gunakan:\n- Reply pesan lalu ketik /set\n- Atau /set isi pesan');
  }
});

bot.hears(/^\/auto (on|off)$/, async (ctx) => {
  const senderId = String(ctx.from.id);
  const chatId   = ctx.chat.id;

  if (!isAnyOwner(senderId)) return ctx.telegram.sendMessage(chatId, '❌ Akses hanya untuk Owner.');

  const mode = ctx.match[1].toLowerCase();

  if (mode === 'on') {
    if (autoShareInterval) return ctx.telegram.sendMessage(chatId, '⚠️ AutoShare sudah aktif.');
    if (!autoShareMessage) return ctx.telegram.sendMessage(chatId, '❌ Belum ada pesan yang di-set. Gunakan /set dulu.');

    ctx.telegram.sendMessage(chatId, '✅ AutoShare diaktifkan. Bot akan share setiap 15 menit.');

    autoShareInterval = setInterval(async () => {
      const grp = loadGroups();
      const groups = grp.groups || [];
      if (groups.length === 0) return;
      let sukses = 0, gagal = 0;
      const ownersData = loadOwners();
      ownersData.list.forEach(oid => {
        bot.telegram.sendMessage(oid, `📡 AutoShare dimulai... Total Grup: ${groups.length}`).catch(() => {});
      });
      for (const groupId of groups) {
        try {
          if (autoShareMessage.type === 'reply') {
            await bot.telegram.copyMessage(groupId, autoShareMessage.chatId, autoShareMessage.messageId);
          } else {
            await bot.telegram.sendMessage(groupId, autoShareMessage.content);
          }
          sukses++;
        } catch { gagal++; }
        await new Promise(r => setTimeout(r, 500));
      }
      ownersData.list.forEach(oid => {
        bot.telegram.sendMessage(oid, `✅ AutoShare selesai.\n📊 Total: ${groups.length} | ✔️ ${sukses} | ❌ ${gagal}`).catch(() => {});
      });
    }, 15 * 60 * 1000);
  }

  if (mode === 'off') {
    if (autoShareInterval) {
      clearInterval(autoShareInterval);
      autoShareInterval = null;
      return ctx.telegram.sendMessage(chatId, '✅ AutoShare dimatikan.');
    } else {
      return ctx.telegram.sendMessage(chatId, '⚠️ AutoShare belum aktif.');
    }
  }
});

bot.hears(/^\/auto status$/, async (ctx) => {
  const chatId = ctx.chat.id;
  if (!isAnyOwner(ctx.from.id)) return ctx.telegram.sendMessage(chatId, '❌ Akses hanya untuk Owner.');
  const status = autoShareInterval ? '✅ Aktif' : '❌ Nonaktif';
  const pesan  = autoShareMessage
    ? (autoShareMessage.type === 'text'
        ? autoShareMessage.content.slice(0, 50) + (autoShareMessage.content.length > 50 ? '...' : '')
        : '📎 Pesan reply (media/teks)')
    : '⚠️ Belum ada pesan diset.';
  ctx.telegram.sendMessage(chatId,
    `<blockquote>📡 Status AutoShare\n⬡ Status: ${status}\n⬡ Pesan: ${pesan}</blockquote>`,
    { parse_mode: 'HTML' }
  );
});

// ============================================================
//  /addownjs  /delownjs
// ============================================================
bot.hears(/^\/addownjs(?:\s+(\d+))?$/, async (ctx) => {
  const senderId = ctx.from.id;
  const match    = ctx.match;
  if (!isMainOwner(senderId)) return ctx.telegram.sendMessage(senderId, '❌ Kamu bukan owner utama!');
  if (!match[1]) return ctx.telegram.sendMessage(senderId, '⚠️ Contoh: /addownjs 123456789');

  const targetId   = String(match[1]);
  const ownersData = loadOwners();
  if (!ownersData.list.includes(targetId)) {
    ownersData.list.push(targetId);
    saveOwners(ownersData);
    ctx.telegram.sendMessage(senderId, `✅ User ${targetId} ditambahkan sebagai owner tambahan.`);
    await sendBackupToOwners('AUTO BACKUP – OWNER BARU');
  } else {
    ctx.telegram.sendMessage(senderId, `⚠️ User ${targetId} sudah menjadi owner.`);
  }
});

bot.hears(/^\/delownjs(?:\s+(\d+))?$/, async (ctx) => {
  const senderId = ctx.from.id;
  const match    = ctx.match;
  if (!isMainOwner(senderId)) return ctx.telegram.sendMessage(senderId, '❌ Kamu bukan owner utama!');
  if (!match[1]) return ctx.telegram.sendMessage(senderId, '⚠️ Contoh: /delownjs 123456789');

  const targetId = String(match[1]);
  if (OWNER_IDS.map(String).includes(targetId)) {
    return ctx.telegram.sendMessage(senderId, `❌ Tidak bisa hapus Owner Utama.`);
  }

  const ownersData = loadOwners();
  if (ownersData.list.includes(targetId)) {
    ownersData.list = ownersData.list.filter(id => id !== targetId);
    saveOwners(ownersData);
    ctx.telegram.sendMessage(senderId, `✅ User ${targetId} dihapus dari owner.`);
    await sendBackupToOwners('AUTO BACKUP – OWNER DIHAPUS');
  } else {
    ctx.telegram.sendMessage(senderId, `⚠️ User ${targetId} bukan owner tambahan.`);
  }
});

// ============================================================
//  /addprem — Premium Permanen (owner only)
// ============================================================
bot.command('addprem', async (ctx) => {
  const senderId = String(ctx.from.id);
  const chatId   = ctx.chat.id;

  if (!isOwner(senderId)) {
    return ctx.telegram.sendMessage(chatId, '❌ Akses hanya untuk Owner.').catch(() => {});
  }

  let targetId = null;
  const args = ctx.message.text.split(/\s+/).slice(1);

  if (ctx.message.reply_to_message) {
    targetId = String(ctx.message.reply_to_message.from.id);
  } else if (args[0] && /^\d+$/.test(args[0])) {
    targetId = args[0];
  } else {
    return ctx.telegram.sendMessage(chatId,
      '⚠️ Cara pakai:\n<code>/addprem 123456789</code>\natau reply user lalu <code>/addprem</code>',
      { parse_mode: 'HTML' }
    ).catch(() => {});
  }

  const permPrem = loadPermPrem();
  if (permPrem[targetId]) {
    return ctx.telegram.sendMessage(chatId, `⚠️ User ${targetId} sudah memiliki Premium Permanen.`).catch(() => {});
  }

  permPrem[targetId] = true;
  savePermPrem(permPrem);

  ctx.telegram.sendMessage(chatId,
    `✅ User <code>${targetId}</code> berhasil ditambahkan sebagai <b>Premium Permanen</b>.\n♾️ Tidak ada expired.`,
    { parse_mode: 'HTML' }
  ).catch(() => {});

  bot.telegram.sendMessage(targetId,
    '🎉 Kamu telah diberikan <b>Premium Permanen</b> oleh Owner!\n♾️ Akses tidak memiliki batas waktu.',
    { parse_mode: 'HTML' }
  ).catch(() => {});

  await sendBackupToOwners('AUTO BACKUP – TAMBAH PREMIUM PERMANEN');
});

// ============================================================
//  /delprem
// ============================================================
bot.hears(/^\/delprem(?:\s+(\d+))?$/, async (ctx) => {
  const senderId = String(ctx.from.id);
  const chatId   = ctx.chat.id;
  const match    = ctx.match;

  if (!isOwner(senderId)) return ctx.telegram.sendMessage(chatId, '❌ Akses hanya untuk Owner.');

  let targetId = match[1];
  if (!targetId && ctx.message.reply_to_message) {
    targetId = String(ctx.message.reply_to_message.from.id);
  }
  if (!targetId || !/^\d+$/.test(targetId)) {
    return ctx.telegram.sendMessage(chatId, '⚠️ Contoh: /delprem 123456789');
  }

  const permPrem = loadPermPrem();
  const missPrem = loadMissPrem();
  let removed = false;

  if (permPrem[targetId]) { delete permPrem[targetId]; savePermPrem(permPrem); removed = true; }
  if (missPrem[targetId]) { delete missPrem[targetId]; saveMissPrem(missPrem); removed = true; }

  if (removed) {
    ctx.telegram.sendMessage(chatId, `✅ Premium user <code>${targetId}</code> berhasil dihapus.`, { parse_mode: 'HTML' });
    await sendBackupToOwners('AUTO BACKUP – HAPUS PREMIUM');
  } else {
    ctx.telegram.sendMessage(chatId, `❌ User ${targetId} tidak memiliki premium.`);
  }
});

// ============================================================
//  /listprem
// ============================================================
bot.command('listprem', async (ctx) => {
  const senderId = String(ctx.from.id);
  if (!isOwner(senderId)) return;

  const perm = loadPermPrem();
  const miss = loadMissPrem();
  const now  = Math.floor(Date.now() / 1000);

  let teks = '<blockquote>📋 DAFTAR PREMIUM</blockquote>\n\n';

  const permList = Object.keys(perm);
  teks += `<b>💎 Premium Permanen (${permList.length})</b>\n`;
  if (permList.length === 0) teks += '– Kosong\n';
  else permList.forEach(uid => { teks += `👤 <code>${uid}</code> — ♾️ Permanen\n`; });

  teks += '\n';

  const missEntries = Object.entries(miss).filter(([, v]) => v.expired > now);
  teks += `<b>⏳ Premium Misi (${missEntries.length})</b>\n`;
  if (missEntries.length === 0) teks += '– Kosong\n';
  else missEntries.forEach(([uid, v]) => {
    const sisaHari = Math.floor((v.expired - now) / 86400);
    const sisaJam  = Math.floor(((v.expired - now) % 86400) / 3600);
    teks += `👤 <code>${uid}</code> — ${sisaHari}h ${sisaJam}j lagi\n`;
  });

  ctx.telegram.sendMessage(ctx.chat.id, teks, { parse_mode: 'HTML' }).catch(() => {});
});

// ============================================================
//  /cekprem — cek status premium diri sendiri
// ============================================================
bot.command('cekprem', async (ctx) => {
  const userId = String(ctx.from.id);
  const chatId = ctx.chat.id;
  const now    = Math.floor(Date.now() / 1000);

  const perm = loadPermPrem();
  const miss = loadMissPrem();

  let teks = '<blockquote>💎 STATUS PREMIUM</blockquote>\n\n';

  if (perm[userId]) {
    teks += `✅ <b>Status:</b> Premium Aktif\n`;
    teks += `📌 <b>Jenis:</b> Premium Permanen\n`;
    teks += `♾️ <b>Sisa:</b> Tidak ada expired\n`;
  } else if (miss[userId] && miss[userId].expired > now) {
    const sisaDetik = miss[userId].expired - now;
    const sisaHari  = Math.floor(sisaDetik / 86400);
    const sisaJam   = Math.floor((sisaDetik % 86400) / 3600);
    const expDate   = new Date(miss[userId].expired * 1000).toLocaleDateString('id-ID');
    teks += `✅ <b>Status:</b> Premium Aktif\n`;
    teks += `📌 <b>Jenis:</b> Premium Misi\n`;
    teks += `⏳ <b>Sisa:</b> ${sisaHari} hari ${sisaJam} jam\n`;
    teks += `📅 <b>Expired:</b> ${expDate}\n`;
  } else {
    teks += `❌ <b>Status:</b> Tidak Premium\n\n`;
    teks += `💡 Cara mendapatkan premium:\n`;
    teks += `• Tambahkan bot ke 2 grup → <b>Premium Misi 3 hari</b>\n`;
    teks += `• Beli premium ke owner → <b>Premium Permanen</b>`;
  }

  ctx.telegram.sendMessage(chatId, teks, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [[{ text: '💎 Beli Premium', url: 'https://t.me/drazxreal' }]]
    }
  }).catch(() => {});
});

// ============================================================
//  /setcd — set cooldown global (owner only)
// ============================================================
bot.hears(/^\/setcd(?:\s+(\d+))?$/, async (ctx) => {
  const senderId = String(ctx.from.id);
  const chatId   = ctx.chat.id;
  const match    = ctx.match;

  if (!isOwner(senderId)) return ctx.telegram.sendMessage(chatId, '❌ Akses hanya untuk Owner.');
  if (!match[1]) return ctx.telegram.sendMessage(chatId, '⚠️ Contoh: /setcd 30 (dalam detik)\n/setcd 0 untuk nonaktif');

  const sec = parseInt(match[1]);
  if (isNaN(sec) || sec < 0) return ctx.telegram.sendMessage(chatId, '❌ Nilai cooldown tidak valid.');

  const cd = loadCooldown();
  cd.globalCd = sec;
  saveCooldown(cd);

  ctx.telegram.sendMessage(chatId,
    sec === 0
      ? '✅ Cooldown global <b>dinonaktifkan</b>.'
      : `✅ Cooldown global diset ke <b>${sec} detik</b>.\nOwner tidak terkena cooldown.`,
    { parse_mode: 'HTML' }
  );
  await sendBackupToOwners('AUTO BACKUP – COOLDOWN BERUBAH');
});

// ============================================================
//  /listgroup
// ============================================================
bot.command('listgroup', async (ctx) => {
  const senderId = String(ctx.from.id);
  const chatId   = ctx.chat.id;
  if (!isOwner(senderId)) return ctx.telegram.sendMessage(chatId, '❌ Akses hanya untuk Owner.');

  const grpData = loadGroups();
  const groups  = grpData.groups || [];

  if (groups.length === 0) {
    return ctx.telegram.sendMessage(chatId, '<blockquote>📋 LIST GROUP</blockquote>\n\nBelum ada grup terdaftar.', { parse_mode: 'HTML' });
  }

  const MAX_PER_MSG = 50;
  const pages = Math.ceil(groups.length / MAX_PER_MSG);
  for (let p = 0; p < pages; p++) {
    const slice = groups.slice(p * MAX_PER_MSG, (p + 1) * MAX_PER_MSG);
    const teks  = `<blockquote>📋 LIST GROUP (${p+1}/${pages})</blockquote>\n\n` +
                  slice.map((id, i) => `${p * MAX_PER_MSG + i + 1}. <code>${id}</code>`).join('\n');
    await ctx.telegram.sendMessage(chatId, teks, { parse_mode: 'HTML' }).catch(() => {});
  }
});

// ============================================================
//  /stats
// ============================================================
bot.command('stats', async (ctx) => {
  const senderId = String(ctx.from.id);
  const chatId   = ctx.chat.id;
  if (!isOwner(senderId)) return ctx.telegram.sendMessage(chatId, '❌ Akses hanya untuk Owner.');

  const grpData = loadGroups();
  const perm    = loadPermPrem();
  const miss    = loadMissPrem();
  const own     = loadOwners();
  const cd      = loadCooldown();
  const usrs    = loadUsers();
  const now     = Math.floor(Date.now() / 1000);
  const activeMiss = Object.values(miss).filter(v => v.expired > now).length;

  let backupCount = 0;
  try {
    backupCount = fs.readdirSync(BACK_DIR).filter(f => f.endsWith('.json')).length;
  } catch {}

  const ram    = process.memoryUsage();
  const uptime = formatUptime(Date.now() - BOT_START_TIME);

  const teks =
    `<blockquote>📊 STATISTIK BOT</blockquote>\n\n` +
    `⬡ <b>Users</b> : ${usrs.list.length}\n` +
    `⬡ <b>Group</b> : ${grpData.groups.length}\n` +
    `⬡ <b>Premium Permanen</b> : ${Object.keys(perm).length}\n` +
    `⬡ <b>Premium Misi</b> : ${activeMiss}\n` +
    `⬡ <b>Owner</b> : ${own.list.length}\n` +
    `⬡ <b>Cooldown</b> : ${cd.globalCd}s\n` +
    `⬡ <b>Backup</b> : ${backupCount} file\n` +
    `⬡ <b>RAM</b> : ${formatBytes(ram.heapUsed)} / ${formatBytes(ram.heapTotal)}\n` +
    `⬡ <b>Uptime</b> : ${uptime}\n` +
    `⬡ <b>Versi Bot</b> : ${BOT_VERSION}`;

  ctx.telegram.sendMessage(chatId, teks, { parse_mode: 'HTML' }).catch(() => {});
});

// ============================================================
//  /lastbackup
// ============================================================
bot.command('lastbackup', async (ctx) => {
  const senderId = String(ctx.from.id);
  const chatId   = ctx.chat.id;
  if (!isOwner(senderId)) return ctx.telegram.sendMessage(chatId, '❌ Akses hanya untuk Owner.');

  await ctx.telegram.sendMessage(chatId, '⏳ Membuat backup terbaru...').catch(() => {});
  await sendBackupToOwners('MANUAL BACKUP – /lastbackup');
  ctx.telegram.sendMessage(chatId, '✅ Backup berhasil dikirim ke Owner.').catch(() => {});
});

// ============================================================
//  /restorebackup — reply file JSON
// ============================================================
bot.command('restorebackup', async (ctx) => {
  const senderId = String(ctx.from.id);
  const chatId   = ctx.chat.id;
  if (!isOwner(senderId)) return ctx.telegram.sendMessage(chatId, '❌ Akses hanya untuk Owner.');

  const reply = ctx.message.reply_to_message;
  if (!reply || !reply.document) {
    return ctx.telegram.sendMessage(chatId, '⚠️ Reply ke file JSON backup lalu ketik /restorebackup');
  }
  if (!reply.document.file_name.endsWith('.json')) {
    return ctx.telegram.sendMessage(chatId, '❌ File harus berekstensi .json');
  }

  try {
    const fileLink = await ctx.telegram.getFileLink(reply.document.file_id);
    const https = require('https');
    const http  = require('http');
    const url   = fileLink.href;

    const rawData = await new Promise((resolve, reject) => {
      const protocol = url.startsWith('https') ? https : http;
      protocol.get(url, res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => resolve(data));
        res.on('error', reject);
      }).on('error', reject);
    });

    const payload = JSON.parse(rawData);

    // Restore Owner
    if (Array.isArray(payload.owner)) {
      saveOwners({ list: payload.owner.map(String) });
    }
    // Restore Groups
    if (Array.isArray(payload.groups)) {
      saveGroups({ groups: payload.groups, user_group_count: payload.user_group_count || {} });
    }
    // Restore Premium Permanen
    if (payload.premiumPermanent && typeof payload.premiumPermanent === 'object') {
      savePermPrem(payload.premiumPermanent);
    }
    // Restore Premium Misi
    if (payload.premiumMission && typeof payload.premiumMission === 'object') {
      saveMissPrem(payload.premiumMission);
    }
    // Restore Cooldown
    if (payload.cooldown && typeof payload.cooldown === 'object') {
      saveCooldown(payload.cooldown);
    }
    // Restore Users
    if (Array.isArray(payload.users)) {
      saveUsers({ list: payload.users.map(String) });
    }

    ctx.telegram.sendMessage(chatId,
      `✅ <b>Restore berhasil!</b>\n\n` +
      `<blockquote>` +
      `⬡ Owner : ${(payload.owner || []).length}\n` +
      `⬡ Grup : ${(payload.groups || []).length}\n` +
      `⬡ Prem Permanen : ${Object.keys(payload.premiumPermanent || {}).length}\n` +
      `⬡ Prem Misi : ${Object.keys(payload.premiumMission || {}).length}\n` +
      `⬡ Users : ${(payload.users || []).length}\n` +
      `</blockquote>`,
      { parse_mode: 'HTML' }
    ).catch(() => {});

    await sendBackupToOwners('AUTO BACKUP – SETELAH RESTORE');
  } catch (err) {
    console.error('/restorebackup error:', err.message);
    ctx.telegram.sendMessage(chatId, `❌ Gagal restore: ${err.message}`).catch(() => {});
  }
});

// ============================================================
//  STARTUP - BACA DARI GROUP.JS
// ============================================================
// Pastikan saat bot start, membaca dari group.js
setTimeout(() => {
  syncGroupFile();
  console.log('✅ Group.js disinkronkan saat startup');
}, 1000);

// ============================================================
//  PROCESS SHUTDOWN
// ============================================================
process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// ============================================================
//  LAUNCH
// ============================================================
bot.launch();
console.log('✅ JASEB • VIP JASEB FREE v' + BOT_VERSION + ' berjalan...');