require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const db = require('./database');

const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(id => parseInt(id.trim()));

bot.use(async (ctx, next) => {
  if (ctx.from) {
    const user = db.prepare('SELECT * FROM users WHERE user_id = ?').get(ctx.from.id);
    if (!user) {
      db.prepare('INSERT INTO users (user_id, username, first_name) VALUES (?, ?, ?)').run(
        ctx.from.id, ctx.from.username || null, ctx.from.first_name
      );
    }
  }
  return next();
});

// Start command
bot.start(async (ctx) => {
  const user = db.prepare('SELECT * FROM users WHERE user_id = ?').get(ctx.from.id);
  await ctx.reply(
    `🎉 <b>¡Bienvenido a TikTok Rewards Bot!</b>\n\n` +
    `Hola <b>${ctx.from.first_name}</b>! Aquí puedes ganar puntos dando like a videos de TikTok y canjearlos por recompensas.\n\n` +
    `📋 <b>Comandos disponibles:</b>\n` +
    `• /tasks - Ver tareas disponibles\n` +
    `• /mytask - Recibir una tarea\n` +
    `• /points - Ver mis puntos\n` +
    `• /redeem - Canjear recompensas\n` +
    `• /help - Ayuda`,
    { parse_mode: 'HTML' }
  );
});

// Help command
bot.help(async (ctx) => {
  await ctx.reply(
    `📖 <b>¿Cómo funciona?</b>\n\n` +
    `1️⃣ Usa /mytask para recibir un video de TikTok\n` +
    `2️⃣ Dale like al video en TikTok\n` +
    `3️⃣ Toma una captura de pantalla como prueba\n` +
    `4️⃣ Envía la captura al bot\n` +
    `5️⃣ Un administrador revisa y aprueba\n` +
    `6️⃣ ¡Recibes tus puntos!\n\n` +
    `7️⃣ Con /redeem puedes canjear tus puntos por recompensas\n\n` +
    `📊 /points - Ver tu saldo de puntos`,
    { parse_mode: 'HTML' }
  );
});

// Tasks command - list available tasks
bot.command('tasks', async (ctx) => {
  const tasks = db.prepare(`
    SELECT t.*, u.username, u.first_name
    FROM tasks t
    JOIN users u ON t.user_id = u.user_id
    WHERE t.status = 'pending'
    ORDER BY t.created_at DESC
    LIMIT 10
  `).all();

  if (tasks.length === 0) {
    return ctx.reply('📭 No hay tareas pendientes en este momento.');
  }

  let msg = '📋 <b>Tareas pendientes:</b>\n\n';
  tasks.forEach((t, i) => {
    msg += `${i+1}. 👤 ${t.first_name} (@${t.username || 'sin username'})\n   🎬 <a href="${t.video_url}">Ver video</a>\n   ⏰ ${t.created_at}\n\n`;
  });

  await ctx.reply(msg, { parse_mode: 'HTML', disable_web_page_preview: true });
});

// My task - get a new task
bot.command('mytask', async (ctx) => {
  const user = db.prepare('SELECT * FROM users WHERE user_id = ?').get(ctx.from.id);

  // Check for pending task
  const pending = db.prepare("SELECT * FROM tasks WHERE user_id = ? AND status = 'pending'").get(ctx.from.id);
  if (pending) {
    return ctx.reply('⏳ Ya tienes una tarea pendiente. Espera a que sea revisada o usa /tasks para ver el estado.');
  }

  // Check cooldown - 5 minutes
  const lastTask = db.prepare("SELECT * FROM tasks WHERE user_id = ? ORDER BY created_at DESC LIMIT 1").get(ctx.from.id);
  if (lastTask) {
    const elapsed = (Date.now() - new Date(lastTask.created_at).getTime()) / 1000;
    if (elapsed < 300) {
      const wait = Math.ceil(300 - elapsed);
      return ctx.reply(`⏳ Debes esperar ${wait} segundos antes de solicitar otra tarea.`);
    }
  }

  // Sample TikTok videos for tasks
  const sampleVideos = [
    'https://vm.tiktok.com/ZMhYxKabc/',
    'https://vm.tiktok.com/ZMhYxKdef/',
    'https://vm.tiktok.com/ZMhYxKghi/'
  ];

  const videoUrl = sampleVideos[Math.floor(Math.random() * sampleVideos.length)];

  db.prepare('INSERT INTO tasks (user_id, video_url) VALUES (?, ?)').run(ctx.from.id, videoUrl);

  const buttons = Markup.inlineKeyboard([
    Markup.button.callback('✅ Ya le di like', 'verify_like')
  ]);

  await ctx.reply(
    `🎬 <b>Tu tarea:</b>\n\n` +
    `1️⃣ Abre este video de TikTok: ${videoUrl}\n` +
    `2️⃣ Dale like ❤️\n` +
    `3️⃣ Toma una captura de pantalla\n` +
    `4️⃣ Presiona el botón "Ya le di like" y envía la captura\n\n` +
    `⏰ Tienes 5 minutos.\n` +
    `💰 Recompensa: <b>10 puntos</b>`,
    { parse_mode: 'HTML', ...buttons, disable_web_page_preview: true }
  );
});

// Verify like callback
bot.action('verify_like', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(
    '📸 Perfecto. Ahora envía la <b>captura de pantalla</b> mostrando que diste like al video.\n\n' +
    'La captura debe mostrar:\n' +
    '• El video reproduciéndose\n' +
    '• El corazón ❤️ en rojo (like dado)',
    { parse_mode: 'HTML' }
  );
});

// Handle photo/screenshot evidence
bot.on('photo', async (ctx) => {
  const pending = db.prepare("SELECT * FROM tasks WHERE user_id = ? AND status = 'pending'").get(ctx.from.id);
  if (!pending) {
    return ctx.reply('❌ No tienes ninguna tarea pendiente. Usa /mytask para solicitar una.');
  }

  const photo = ctx.message.photo[ctx.message.photo.length - 1];
  db.prepare('UPDATE tasks SET screenshot_file_id = ? WHERE id = ?').run(photo.file_id, pending.id);

  // Notify admins
  const user = db.prepare('SELECT * FROM users WHERE user_id = ?').get(ctx.from.id);

  for (const adminId of ADMIN_IDS) {
    try {
      await ctx.telegram.sendPhoto(
        adminId,
        photo.file_id,
        {
          caption:
            `📸 <b>Nueva tarea para revisar</b>\n\n` +
            `👤 Usuario: ${user.first_name} (@${user.username || 'sin username'})\n` +
            `🆔 ID: ${ctx.from.id}\n` +
            `🎬 Video: ${pending.video_url}\n` +
            `🆔 Tarea: #${pending.id}`,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '✅ Aprobar', callback_data: `approve_${pending.id}` },
                { text: '❌ Rechazar', callback_data: `reject_${pending.id}` }
              ]
            ]
          }
        }
      );
    } catch(e) { /* admin may have blocked */ }
  }

  await ctx.reply(
    '✅ ¡Captura recibida! Un administrador la revisará pronto.\n\n' +
    'Recibirás una notificación cuando sea aprobada o rechazada.',
    { parse_mode: 'HTML' }
  );
});

// Admin approve callback
bot.action(/approve_(\d+)/, async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return ctx.answerCbQuery('No autorizado', true);

  const taskId = parseInt(ctx.match[1]);
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  if (!task || task.status !== 'pending') return ctx.answerCbQuery('Tarea ya procesada', true);

  db.prepare("UPDATE tasks SET status = 'approved', approved_at = CURRENT_TIMESTAMP WHERE id = ?").run(taskId);
  db.prepare('UPDATE users SET points = points + ?, tasks_completed = tasks_completed + 1 WHERE user_id = ?').run(task.reward, task.user_id);

  await ctx.editMessageCaption(
    ctx.callbackQuery.message.caption + '\n\n✅ <b>APROBADA</b>',
    { parse_mode: 'HTML' }
  );

  try {
    await ctx.telegram.sendMessage(
      task.user_id,
      `✅ <b>¡Tarea aprobada!</b>\n\nHas ganado <b>${task.reward} puntos</b> por dar like al video.\n\n📊 Usa /points para ver tu saldo.\n🎯 Usa /mytask para una nueva tarea.`,
      { parse_mode: 'HTML' }
    );
  } catch(e) { /* user may have blocked */ }

  await ctx.answerCbQuery('✅ Tarea aprobada');
});

// Admin reject callback
bot.action(/reject_(\d+)/, async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return ctx.answerCbQuery('No autorizado', true);

  const taskId = parseInt(ctx.match[1]);
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  if (!task || task.status !== 'pending') return ctx.answerCbQuery('Tarea ya procesada', true);

  db.prepare("UPDATE tasks SET status = 'rejected' WHERE id = ?").run(taskId);

  await ctx.editMessageCaption(
    ctx.callbackQuery.message.caption + '\n\n❌ <b>RECHAZADA</b>',
    { parse_mode: 'HTML' }
  );

  try {
    await ctx.telegram.sendMessage(
      task.user_id,
      '❌ <b>Tarea rechazada</b>\n\nLa captura no fue válida. Asegúrate de que se vea claramente el like (corazón rojo). Usa /mytask para intentar de nuevo.',
      { parse_mode: 'HTML' }
    );
  } catch(e) { /* user may have blocked */ }

  await ctx.answerCbQuery('❌ Tarea rechazada');
});

// Points command
bot.command('points', async (ctx) => {
  const user = db.prepare('SELECT * FROM users WHERE user_id = ?').get(ctx.from.id);
  const topUsers = db.prepare('SELECT * FROM users ORDER BY points DESC LIMIT 5').all();

  let msg = `📊 <b>Mis puntos</b>\n\n🏆 Puntos: <b>${user.points}</b>\n✅ Tareas completadas: <b>${user.tasks_completed}</b>\n\n`;

  if (topUsers.length > 0) {
    msg += '🏅 <b>Top 5 usuarios:</b>\n';
    topUsers.forEach((u, i) => {
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i+1}.`;
      msg += `${medal} ${u.first_name} — ${u.points} pts\n`;
    });
  }

  await ctx.reply(msg, { parse_mode: 'HTML' });
});

// Redeem command
bot.command('redeem', async (ctx) => {
  const rewards = db.prepare('SELECT * FROM rewards WHERE active = 1 AND (stock = -1 OR stock > 0)').all();
  const user = db.prepare('SELECT * FROM users WHERE user_id = ?').get(ctx.from.id);

  if (rewards.length === 0) {
    return ctx.reply('🎁 No hay recompensas disponibles en este momento. Vuelve más tarde.');
  }

  let msg = `🎁 <b>Recompensas disponibles</b>\n\n💰 Tus puntos: <b>${user.points}</b>\n\n`;

  const buttons = [];
  rewards.forEach((r) => {
    msg += `• <b>${r.name}</b> — ${r.cost} pts\n  ${r.description || ''}\n`;
    buttons.push([Markup.button.callback(`🎁 ${r.name} (${r.cost} pts)`, `redeem_${r.id}`)]);
  });

  const markup = Markup.inlineKeyboard(buttons);
  await ctx.reply(msg, { parse_mode: 'HTML', ...markup });
});

// Redeem callback
bot.action(/redeem_(\d+)/, async (ctx) => {
  const rewardId = parseInt(ctx.match[1]);
  const reward = db.prepare('SELECT * FROM rewards WHERE id = ?').get(rewardId);
  const user = db.prepare('SELECT * FROM users WHERE user_id = ?').get(ctx.from.id);

  if (!reward || !reward.active) return ctx.answerCbQuery('Recompensa no disponible', true);
  if (user.points < reward.cost) return ctx.answerCbQuery(`❌ Necesitas ${reward.cost} pts, tienes ${user.points}`, true);

  db.prepare('UPDATE users SET points = points - ? WHERE user_id = ?').run(reward.cost, ctx.from.id);
  db.prepare('INSERT INTO redemptions (user_id, reward_id) VALUES (?, ?)').run(ctx.from.id, rewardId);

  if (reward.stock > 0) {
    db.prepare('UPDATE rewards SET stock = stock - 1 WHERE id = ?').run(rewardId);
  }

  await ctx.answerCbQuery(`✅ ¡Canjeaste ${reward.name}!`);
  await ctx.reply(
    `✅ <b>¡Canje exitoso!</b>\n\nHas canjeado: <b>${reward.name}</b>\nCosto: ${reward.cost} pts\n\nUn administrador procesará tu solicitud pronto.`,
    { parse_mode: 'HTML' }
  );

  // Notify admins
  for (const adminId of ADMIN_IDS) {
    try {
      await ctx.telegram.sendMessage(
        adminId,
        `🎁 <b>Nuevo canje</b>\n\n👤 ${user.first_name} (@${user.username || 'sin username'})\n🎁 ${reward.name}\n💰 ${reward.cost} pts`,
        { parse_mode: 'HTML' }
      );
    } catch(e) {}
  }
});

// Admin: Add reward
bot.command('addreward', async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return;
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 3) {
    return ctx.reply('Uso: /addreward "Nombre" costo "Descripción" [stock]');
  }

  const name = args[0];
  const cost = parseInt(args[1]);
  const desc = args[2] || '';
  const stock = args[3] ? parseInt(args[3]) : -1;

  db.prepare('INSERT INTO rewards (name, description, cost, stock) VALUES (?, ?, ?, ?)').run(name, desc, cost, stock);
  ctx.reply(`✅ Recompensa "${name}" creada por ${cost} pts.`);
});

// Admin: Stats
bot.command('stats', async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return;

  const totalUsers = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
  const totalTasks = db.prepare('SELECT COUNT(*) as count FROM tasks').get().count;
  const approvedTasks = db.prepare("SELECT COUNT(*) as count FROM tasks WHERE status = 'approved'").get().count;
  const pendingTasks = db.prepare("SELECT COUNT(*) as count FROM tasks WHERE status = 'pending'").get().count;
  const totalPoints = db.prepare('SELECT SUM(points) as total FROM users').get().total || 0;

  await ctx.reply(
    `📊 <b>Estadísticas del Bot</b>\n\n` +
    `👥 Usuarios registrados: <b>${totalUsers}</b>\n` +
    `📋 Total tareas: <b>${totalTasks}</b>\n` +
    `✅ Aprobadas: <b>${approvedTasks}</b>\n` +
    `⏳ Pendientes: <b>${pendingTasks}</b>\n` +
    `💰 Puntos en circulación: <b>${totalPoints}</b>`,
    { parse_mode: 'HTML' }
  );
});

// Launch
bot.launch({ dropPendingUpdates: true });
console.log('🤖 TikTok Rewards Bot started!');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));