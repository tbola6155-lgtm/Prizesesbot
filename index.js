require('dotenv').config();
const { Telegraf } = require('telegraf');
const { Pool } = require('pg');

if (!process.env.BOT_TOKEN) {
  console.error('Missing BOT_TOKEN in environment variables.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : false,
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS giveaways (
  id SERIAL PRIMARY KEY,
  chat_id BIGINT NOT NULL,
  prize TEXT NOT NULL,
  created_by BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ends_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  winner_id BIGINT,
  winner_username TEXT
);

CREATE TABLE IF NOT EXISTS entries (
  id SERIAL PRIMARY KEY,
  giveaway_id INTEGER NOT NULL REFERENCES giveaways(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL,
  username TEXT,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (giveaway_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_giveaways_status ON giveaways(status);
CREATE INDEX IF NOT EXISTS idx_entries_giveaway ON entries(giveaway_id);
`;

async function initSchema() {
  await pool.query(SCHEMA);
  console.log('Database schema ready.');
}

function isAdmin(userId) {
  const admins = (process.env.ADMIN_IDS || '')
    .split(',').map((id) => id.trim()).filter(Boolean);
  return admins.includes(String(userId));
}

const bot = new Telegraf(process.env.BOT_TOKEN);

bot.start((ctx) =>
  ctx.reply(
    `👋 Welcome to Prizesbot!\n\nCommands:\n/giveaways — see active giveaways\n/join <id> — enter a giveaway\n\nAdmins:\n/newgiveaway Prize | minutes — start a giveaway\n/endgiveaway <id> — end early and pick a winner`
  )
);

bot.command('newgiveaway', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('Only admins can start a giveaway.');

  const text = ctx.message.text.replace('/newgiveaway', '').trim();
  const [prizeRaw, minutesRaw] = text.split('|').map((s) => s && s.trim());

  if (!prizeRaw || !minutesRaw || isNaN(Number(minutesRaw))) {
    return ctx.reply('Usage: /newgiveaway Prize Name | duration_in_minutes\nExample: /newgiveaway $25 Gift Card | 60');
  }

  const minutes = Number(minutesRaw);
  const endsAt = new Date(Date.now() + minutes * 60 * 1000);

  const result = await pool.query(
    `INSERT INTO giveaways (chat_id, prize, created_by, ends_at) VALUES ($1, $2, $3, $4) RETURNING id`,
    [ctx.chat.id, prizeRaw, ctx.from.id, endsAt]
  );

  const giveawayId = result.rows[0].id;
  return ctx.reply(
    `🎉 New giveaway started!\n\n🏆 Prize: ${prizeRaw}\n⏳ Ends: ${endsAt.toLocaleString()}\n🆔 Giveaway ID: ${giveawayId}\n\nType /join ${giveawayId} to enter!`
  );
});

bot.command('join', async (ctx) => {
  const parts = ctx.message.text.split(' ').filter(Boolean);
  let giveawayId = parts[1];

  if (!giveawayId) {
    const active = await pool.query(
      `SELECT id FROM giveaways WHERE chat_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
      [ctx.chat.id]
    );
    if (active.rows.length === 0) return ctx.reply('No active giveaway in this chat. Use /giveaways to check.');
    giveawayId = active.rows[0].id;
  }

  const giveaway = await pool.query(`SELECT * FROM giveaways WHERE id = $1 AND chat_id = $2`, [giveawayId, ctx.chat.id]);
  if (giveaway.rows.length === 0) return ctx.reply('Giveaway not found in this chat.');
  if (giveaway.rows[0].status !== 'active') return ctx.reply('That giveaway has already ended.');

  try {
    await pool.query(
      `INSERT INTO entries (giveaway_id, user_id, username) VALUES ($1, $2, $3)`,
      [giveawayId, ctx.from.id, ctx.from.username || ctx.from.first_name]
    );
    return ctx.reply(`✅ You're entered into giveaway #${giveawayId}! Good luck.`);
  } catch (err) {
    if (err.code === '23505') return ctx.reply("You're already entered in this giveaway.");
    throw err;
  }
});

bot.command('giveaways', async (ctx) => {
  const result = await pool.query(
    `SELECT g.id, g.prize, g.ends_at, COUNT(e.id) AS entries
     FROM giveaways g LEFT JOIN entries e ON e.giveaway_id = g.id
     WHERE g.chat_id = $1 AND g.status = 'active'
     GROUP BY g.id ORDER BY g.created_at DESC`,
    [ctx.chat.id]
  );

  if (result.rows.length === 0) return ctx.reply('No active giveaways right now.');

  const list = result.rows.map((g) =>
    `🆔 #${g.id} — 🏆 ${g.prize}\n   👥 ${g.entries} entries • ⏳ ends ${new Date(g.ends_at).toLocaleString()}`
  ).join('\n\n');

  return ctx.reply(`Active giveaways:\n\n${list}`);
});

bot.command('endgiveaway', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('Only admins can end a giveaway.');
  const parts = ctx.message.text.split(' ').filter(Boolean);
  const giveawayId = parts[1];
  if (!giveawayId) return ctx.reply('Usage: /endgiveaway <giveaway_id>');
  await pickWinnerAndClose(giveawayId, ctx);
});

async function pickWinnerAndClose(giveawayId, ctx) {
  const giveaway = await pool.query(`SELECT * FROM giveaways WHERE id = $1`, [giveawayId]);
  if (giveaway.rows.length === 0) return ctx?.reply?.('Giveaway not found.');
  if (giveaway.rows[0].status !== 'active') return ctx?.reply?.('Giveaway already ended.');

  const entries = await pool.query(`SELECT * FROM entries WHERE giveaway_id = $1`, [giveawayId]);

  let winnerText;
  if (entries.rows.length === 0) {
    await pool.query(`UPDATE giveaways SET status = 'ended' WHERE id = $1`, [giveawayId]);
    winnerText = `Giveaway #${giveawayId} ended with no entries. No winner.`;
  } else {
    const winner = entries.rows[Math.floor(Math.random() * entries.rows.length)];
    await pool.query(
      `UPDATE giveaways SET status = 'ended', winner_id = $1, winner_username = $2 WHERE id = $3`,
      [winner.user_id, winner.username, giveawayId]
    );
    winnerText = `🎊 Giveaway #${giveawayId} has ended!\n🏆 Prize: ${giveaway.rows[0].prize}\n🥳 Winner: ${winner.username ? '@' + winner.username : 'user ' + winner.user_id}`;
  }

  const chatId = giveaway.rows[0].chat_id;
  if (ctx?.reply) return ctx.reply(winnerText);
  if (ctx?.telegram) return ctx.telegram.sendMessage(chatId, winnerText);
  return { chatId, winnerText };
}

bot.catch((err, ctx) => {
  console.error(`Error for ${ctx.updateType}:`, err);
  ctx.reply('Something went wrong. Please try again.').catch(() => {});
});

async function checkExpiredGiveaways() {
  try {
    const expired = await pool.query(`SELECT id FROM giveaways WHERE status = 'active' AND ends_at <= now()`);
    for (const row of expired.rows) {
      await pickWinnerAndClose(row.id, { telegram: bot.telegram });
    }
  } catch (err) {
    console.error('Error checking expired giveaways:', err);
  }
}

async function main() {
  await initSchema();
  setInterval(checkExpiredGiveaways, 60 * 1000);
  await bot.launch();
  console.log('Prizesbot is up and running.');
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
