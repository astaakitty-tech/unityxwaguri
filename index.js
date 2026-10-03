const {
  Client,
  GatewayIntentBits
} = require("discord.js");

const mineflayer = require("mineflayer");
const { Pool } = require("pg");
const sharp = require("sharp");
const http = require("http");

// ============================================================
// ENV
// ============================================================

const {
  DISCORD_TOKEN,
  CHANNEL_ID,

  MINECRAFT_HOST,
  MINECRAFT_PORT,
  MINECRAFT_USERNAME,
  MINECRAFT_VERSION,
  SERVER_PASSWORD,

  DEXLAND_HOST,
  DEXLAND_PORT,
  DEXLAND_USERNAME,
  DEXLAND_VERSION,
  DEXLAND_PASSWORD,

  DATABASE_URL,
  PORT
} = process.env;

// ============================================================
// VALIDATION
// ============================================================

const requiredEnv = [
  "DISCORD_TOKEN",
  "CHANNEL_ID",

  "MINECRAFT_HOST",
  "MINECRAFT_PORT",
  "MINECRAFT_USERNAME",

  "DEXLAND_HOST",
  "DEXLAND_PORT",
  "DEXLAND_USERNAME",

  "DATABASE_URL"
];

for (const key of requiredEnv) {
  if (!process.env[key]) {
    console.error(`❌ Не задан ENV: ${key}`);
    process.exit(1);
  }
}

// ============================================================
// CONSTANTS
// ============================================================

const PREFIX = "#";

const MC_PORT = Number(MINECRAFT_PORT);
const DEX_PORT = Number(DEXLAND_PORT);

const RECONNECT_DELAY = 30000;
const AUTO_LEAVE_TIME = 10 * 60 * 1000;
const SKIN_CACHE_TIME = 30 * 60 * 1000;

// ============================================================
// DISCORD
// ============================================================

const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// ============================================================
// DATABASE
// ============================================================

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// ============================================================
// MINECRAFT STATES
// ============================================================

const states = {
  mineblaze: {
    bot: null,
    isConnecting: false,
    reconnectTimer: null,
    autoLeaveTimer: null,

    shouldReconnect: true,
    captchaDetected: false,
    anotherClientDetected: false
  },

  dexland: {
    bot: null,
    isConnecting: false,
    reconnectTimer: null,
    autoLeaveTimer: null,

    shouldReconnect: true,
    captchaDetected: false,
    anotherClientDetected: false
  }
};

// ============================================================
// GLOBAL BAN PROTECTION
// ============================================================

let ipBanDetected = false;

// ============================================================
// SKIN CACHE
// ============================================================

const skinCache = new Map();

// ============================================================
// HTTP SERVER FOR RENDER
// ============================================================

const server = http.createServer((req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8"
  });

  res.end("Minecraft Discord Bot is running.\n");
});

server.listen(
  Number(PORT) || 10000,
  "0.0.0.0",
  () => {
    console.log(
      `🌐 HTTP server запущен на порту ${Number(PORT) || 10000}`
    );
  }
);

// ============================================================
// UTILITIES
// ============================================================

function sleep(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

function truncateText(text, maxLength = 1200) {
  text = String(text);

  if (text.length <= maxLength) {
    return text;
  }

  return text.slice(0, maxLength - 1) + "…";
}

function cleanText(value) {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "string") {
    return value
      .replace(/§[0-9a-fk-or]/gi, "")
      .replace(/\u00a7[0-9a-fk-or]/gi, "")
      .trim();
  }

  try {
    return cleanText(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

function extractUrls(text) {
  return (
    String(text).match(
      /https?:\/\/[^\s<>()]+/gi
    ) || []
  );
}

function getChannelIds() {
  return [String(CHANNEL_ID)];
}

// ============================================================
// DISCORD MESSAGE
// ============================================================

async function sendDiscordMessage(text) {
  try {
    const channel = await discord.channels.fetch(
      CHANNEL_ID
    );

    if (!channel) {
      return;
    }

    await channel.send(
      truncateText(text, 1900)
    );
  } catch (error) {
    console.log(
      `[Discord] Ошибка отправки: ${error.message}`
    );
  }
}

// ============================================================
// DATABASE INIT
// ============================================================

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tracked_players (
      username TEXT PRIMARY KEY,
      type TEXT NOT NULL
    )
  `);

  console.log("🗄️ PostgreSQL готов.");
}

// ============================================================
// TRACKED PLAYERS
// ============================================================

async function addTrackedPlayer(username, type) {
  username = String(username).trim();

  if (!username) {
    return;
  }

  await pool.query(
    `
    INSERT INTO tracked_players
      (username, type)
    VALUES
      ($1, $2)
    ON CONFLICT (username)
    DO UPDATE SET type = EXCLUDED.type
    `,
    [username, type]
  );
}

async function removeTrackedPlayer(username) {
  await pool.query(
    `
    DELETE FROM tracked_players
    WHERE LOWER(username) = LOWER($1)
    `,
    [username]
  );
}

async function getTrackedPlayers(type) {
  const result = await pool.query(
    `
    SELECT username
    FROM tracked_players
    WHERE type = $1
    ORDER BY LOWER(username)
    `,
    [type]
  );

  return result.rows.map(
    row => row.username
  );
}

// ============================================================
// NAME MC
// ============================================================

async function getNameMcSkin(username) {
  const key = username.toLowerCase();

  const cached = skinCache.get(key);

  if (
    cached &&
    Date.now() - cached.time < SKIN_CACHE_TIME
  ) {
    return cached.buffer;
  }

  try {
    const profileUrl =
      `https://ru.namemc.com/profile/${encodeURIComponent(username)}`;

    const response = await fetch(
      profileUrl,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
          "Accept-Language":
            "ru-RU,ru;q=0.9,en;q=0.8"
        }
      }
    );

    if (!response.ok) {
      throw new Error(
        `NameMC profile HTTP ${response.status}`
      );
    }

    const html = await response.text();

    const matches = [
      ...html.matchAll(
        /https?:\/\/s\.namemc\.com\/i\/([a-f0-9]+)\.png/gi
      )
    ];

    if (!matches.length) {
      throw new Error("Скин не найден");
    }

    const skinHash = matches[0][1];

    const skinUrl =
      `https://s.namemc.com/i/${skinHash}.png`;

    const skinResponse = await fetch(
      skinUrl,
      {
        headers: {
          "User-Agent": "Mozilla/5.0"
        }
      }
    );

    if (!skinResponse.ok) {
      throw new Error(
        `NameMC skin HTTP ${skinResponse.status}`
      );
    }

    const buffer = Buffer.from(
      await skinResponse.arrayBuffer()
    );

    skinCache.set(
      key,
      {
        time: Date.now(),
        buffer
      }
    );

    return buffer;
  } catch (error) {
    console.log(
      `[NameMC] ${username}: ${error.message}`
    );

    return null;
  }
}

// ============================================================
// PLAYER HEAD
// ============================================================

async function getPlayerHead(username) {
  const skin =
    await getNameMcSkin(username);

  if (!skin) {
    return null;
  }

  try {
    const face =
      await sharp(skin)
        .extract({
          left: 8,
          top: 8,
          width: 8,
          height: 8
        })
        .resize(
          40,
          40,
          {
            kernel: "nearest"
          }
        )
        .png()
        .toBuffer();

    const hat =
      await sharp(skin)
        .extract({
          left: 40,
          top: 8,
          width: 8,
          height: 8
        })
        .resize(
          40,
          40,
          {
            kernel: "nearest"
          }
        )
        .png()
        .toBuffer();

    return await sharp({
      create: {
        width: 40,
        height: 40,
        channels: 4,
        background: {
          r: 0,
          g: 0,
          b: 0,
          alpha: 0
        }
      }
    })
      .composite([
        {
          input: face,
          left: 0,
          top: 0
        },
        {
          input: hat,
          left: 0,
          top: 0
        }
      ])
      .png()
      .toBuffer();

  } catch (error) {
    console.log(
      `[NameMC] Ошибка головы ${username}: ${error.message}`
    );

    return null;
  }
}

// ============================================================
// PING COLOR
// ============================================================

function getPingColor(ping) {
  const value = Number(ping);

  if (!Number.isFinite(value)) {
    return "#aaaaaa";
  }

  if (value <= 80) {
    return "#55ff55";
  }

  if (value <= 150) {
    return "#ffff55";
  }

  if (value <= 250) {
    return "#ffaa00";
  }

  return "#ff5555";
}

// ============================================================
// VERIFICATION / CAPTCHA
// ============================================================

function looksLikeVerification(text) {
  const lower =
    String(text).toLowerCase();

  const keywords = [
    "captcha",
    "verify",
    "verification",
    "verification required",
    "robot",
    "anti bot",
    "antibot",
    "подтверд",
    "провер",
    "капча"
  ];

  return keywords.some(
    keyword =>
      lower.includes(keyword)
  );
}

async function handlePossibleVerification(
  key,
  text
) {
  const state = states[key];

  const clean =
    cleanText(text);

  if (!looksLikeVerification(clean)) {
    return false;
  }

  state.captchaDetected = true;
  state.shouldReconnect = false;

  const urls =
    extractUrls(clean);

  const urlText =
    urls.length
      ? `\n\n🔗 ${urls.join("\n")}`
      : "";

  await sendDiscordMessage(
    `⚠️ **Обнаружена проверка/капча на ${key}.**\n\n` +
    `Автоматический reconnect остановлен.` +
    urlText
  );

  console.log(
    `[${key}] Обнаружена проверка. Reconnect остановлен.`
  );

  return true;
}

// ============================================================
// OTHER CLIENT
// ============================================================

function looksLikeOtherClientKick(text) {
  const lower =
    String(text).toLowerCase();

  return (
    lower.includes("с другого майнкрафта") ||
    lower.includes("другого майнкрафта") ||
    lower.includes("already logged in") ||
    lower.includes("logged in from another") ||
    lower.includes("another minecraft")
  );
}

// ============================================================
// IP BAN DETECTION
// ============================================================

function looksLikeBan(text) {
  const lower =
    String(text).toLowerCase();

  return (
    lower.includes("вы забанены по ip") ||
    lower.includes("забанены по ip") ||
    lower.includes("бан по ip") ||
    lower.includes("banned by ip") ||
    lower.includes("ip ban") ||
    lower.includes("you are banned") ||
    lower.includes("подозрение в использовании читов") ||
    lower.includes("забанил: console")
  );
}

// ============================================================
// STOP ALL AFTER IP BAN
// ============================================================

async function stopAllMinecraftReconnects(reason) {
  if (ipBanDetected) {
    return;
  }

  ipBanDetected = true;

  console.log(
    "[Minecraft] ОБНАРУЖЕН IP-БАН. Все reconnect остановлены."
  );

  for (const key of [
    "mineblaze",
    "dexland"
  ]) {
    const state = states[key];

    state.shouldReconnect = false;

    if (state.reconnectTimer) {
      clearTimeout(
        state.reconnectTimer
      );

      state.reconnectTimer = null;
    }
  }

  await sendDiscordMessage(
    "🛑 **Обнаружен бан по IP Minecraft.**\n\n" +
    "Автоматический reconnect **обоих ботов остановлен**.\n\n" +
    `Причина: \`${truncateText(
      reason,
      1000
    )}\``
  );
}

// ============================================================
// AUTO LEAVE
// ============================================================

function clearAutoLeaveTimer(key) {
  const state = states[key];

  if (state.autoLeaveTimer) {
    clearTimeout(
      state.autoLeaveTimer
    );

    state.autoLeaveTimer = null;
  }
}

function scheduleAutoLeave(key) {
  const state = states[key];

  clearAutoLeaveTimer(key);

  state.autoLeaveTimer =
    setTimeout(() => {
      if (!state.bot) {
        return;
      }

      try {
        state.bot.quit(
          "10 minute auto leave"
        );

        console.log(
          `[${key}] Автоматический выход после 10 минут.`
        );
      } catch (error) {
        console.log(
          `[${key}] Auto leave error: ${error.message}`
        );
      }
    }, AUTO_LEAVE_TIME);
}

// ============================================================
// CONNECT SERVER
// ============================================================

async function connectServer(key) {
  const state = states[key];

  if (ipBanDetected) {
    console.log(
      `[${key}] Подключение отменено: обнаружен IP-бан.`
    );

    return;
  }

  if (state.isConnecting) {
    return;
  }

  if (
    state.bot &&
    state.bot.player
  ) {
    return;
  }

  state.isConnecting = true;
  state.anotherClientDetected = false;

  const isMineBlaze =
    key === "mineblaze";

  const host =
    isMineBlaze
      ? MINECRAFT_HOST
      : DEXLAND_HOST;

  const port =
    isMineBlaze
      ? MC_PORT
      : DEX_PORT;

  const username =
    isMineBlaze
      ? MINECRAFT_USERNAME
      : DEXLAND_USERNAME;

  const version =
    isMineBlaze
      ? MINECRAFT_VERSION
      : DEXLAND_VERSION;

  const password =
    isMineBlaze
      ? SERVER_PASSWORD
      : DEXLAND_PASSWORD;

  const serverName =
    isMineBlaze
      ? "MineBlaze"
      : "DexLand";

  const modeCommand =
    isMineBlaze
      ? "/kp2"
      : "/kp1";

  console.log(
    `[${serverName}] Подключение к ${host}:${port}...`
  );

  try {
    const options = {
      host,
      port,
      username,
      auth: "offline"
    };

    if (version) {
      options.version = version;
    }

    const bot =
      mineflayer.createBot(
        options
      );

    state.bot = bot;

    // ========================================================
    // LOGIN
    // ========================================================

    bot.once(
      "login",
      async () => {
        console.log(
          `[${serverName}] Вошёл как ${username}`
        );

        await sleep(3000);

        if (
          ipBanDetected ||
          !state.shouldReconnect
        ) {
          return;
        }

        if (
          password &&
          password.trim()
        ) {
          try {
            bot.chat(
              `/login ${password.trim()}`
            );

            console.log(
              `[${serverName}] Отправлен /login`
            );
          } catch (error) {
            console.log(
              `[${serverName}] Ошибка /login: ${error.message}`
            );
          }
        }

        await sleep(4000);

        if (
          ipBanDetected ||
          !state.shouldReconnect ||
          state.captchaDetected ||
          state.anotherClientDetected
        ) {
          return;
        }

        if (
          bot &&
          bot.player
        ) {
          try {
            bot.chat(
              modeCommand
            );

            console.log(
              `[${serverName}] Отправлен ${modeCommand}`
            );
          } catch (error) {
            console.log(
              `[${serverName}] Ошибка ${modeCommand}: ${error.message}`
            );
          }
        }
      }
    );

    // ========================================================
    // SPAWN
    // ========================================================

    bot.once(
      "spawn",
      () => {
        console.log(
          `[${serverName}] Spawn.`
        );

        scheduleAutoLeave(key);
      }
    );

    // ========================================================
    // CHAT
    // ========================================================

    bot.on(
      "messagestr",
      async message => {
        const text =
          cleanText(message);

        if (!text) {
          return;
        }

        console.log(
          `[${serverName}] ${text}`
        );

        if (
          looksLikeBan(text)
        ) {
          await stopAllMinecraftReconnects(
            `[${serverName}] ${text}`
          );

          return;
        }

        if (
          looksLikeOtherClientKick(text)
        ) {
          state.anotherClientDetected =
            true;

          state.shouldReconnect =
            false;

          await sendDiscordMessage(
            `⚠️ **${serverName}: аккаунт уже используется другим клиентом.**\n\n` +
            `Автоматический reconnect остановлен.`
          );

          return;
        }

        await handlePossibleVerification(
          key,
          text
        );
      }
    );

    // ========================================================
    // GENERIC MESSAGE
    // ========================================================

    bot.on(
      "message",
      async message => {
        try {
          const text =
            cleanText(
              message.toString()
            );

          if (!text) {
            return;
          }

          if (
            looksLikeBan(text)
          ) {
            await stopAllMinecraftReconnects(
              `[${serverName}] ${text}`
            );

            return;
          }

          if (
            looksLikeOtherClientKick(text)
          ) {
            state.anotherClientDetected =
              true;

            state.shouldReconnect =
              false;

            await sendDiscordMessage(
              `⚠️ **${serverName}: аккаунт уже используется другим клиентом.**\n\n` +
              `Автоматический reconnect остановлен.`
            );
          }
        } catch {
          // ignore
        }
      }
    );

    // ========================================================
    // KICK
    // ========================================================

    bot.on(
      "kicked",
      async reason => {
        const text =
          cleanText(reason);

        console.log(
          `[${serverName}] Kicked: ${text}`
        );

        if (
          looksLikeBan(text)
        ) {
          await stopAllMinecraftReconnects(
            `[${serverName}] ${text}`
          );

          return;
        }

        if (
          looksLikeOtherClientKick(text)
        ) {
          state.anotherClientDetected =
            true;

          state.shouldReconnect =
            false;

          await sendDiscordMessage(
            `⚠️ **${serverName}: аккаунт уже используется другим клиентом.**\n\n` +
            `Автоматический reconnect остановлен.`
          );

          return;
        }

        await sendDiscordMessage(
          `⚠️ **${serverName} бот был кикнут.**\n` +
          `\`${truncateText(
            text,
            1200
          )}\``
        );
      }
    );

    // ========================================================
    // ERROR
    // ========================================================

    bot.on(
      "error",
      error => {
        console.log(
          `[${serverName}] Error: ${error.message}`
        );
      }
    );

    // ========================================================
    // END
    // ========================================================

    bot.on(
      "end",
      async reason => {
        console.log(
          `[${serverName}] Соединение закрыто: ${
            reason || "unknown"
          }`
        );

        if (state.bot === bot) {
          state.bot = null;
        }

        state.isConnecting = false;

        clearAutoLeaveTimer(key);

        if (ipBanDetected) {
          console.log(
            `[${serverName}] Reconnect остановлен: IP-бан.`
          );

          return;
        }

        if (state.captchaDetected) {
          console.log(
            `[${serverName}] Reconnect остановлен: CAPTCHA.`
          );

          return;
        }

        if (state.anotherClientDetected) {
          console.log(
            `[${serverName}] Reconnect остановлен: другой клиент.`
          );

          return;
        }

        if (state.shouldReconnect) {
          scheduleReconnect(key);
        }
      }
    );

    // ========================================================
    // DEATH
    // ========================================================

    bot.on(
      "death",
      () => {
        console.log(
          `[${serverName}] Игрок умер.`
        );
      }
    );

  } catch (error) {
    console.log(
      `[${serverName}] Ошибка подключения: ${error.message}`
    );

    state.bot = null;

    if (
      !ipBanDetected &&
      state.shouldReconnect &&
      !state.captchaDetected &&
      !state.anotherClientDetected
    ) {
      scheduleReconnect(key);
    }

  } finally {
    state.isConnecting = false;
  }
}

// ============================================================
// RECONNECT TIMER
// ============================================================

function scheduleReconnect(key) {
  const state = states[key];

  if (
    ipBanDetected ||
    state.reconnectTimer ||
    !state.shouldReconnect ||
    state.captchaDetected ||
    state.anotherClientDetected
  ) {
    return;
  }

  console.log(
    `[${key}] Следующая попытка через ${
      RECONNECT_DELAY / 1000
    } сек.`
  );

  state.reconnectTimer =
    setTimeout(
      async () => {
        state.reconnectTimer =
          null;

        if (
          !ipBanDetected &&
          state.shouldReconnect &&
          !state.captchaDetected &&
          !state.anotherClientDetected
        ) {
          await connectServer(key);
        }
      },
      RECONNECT_DELAY
    );
}

// ============================================================
// MANUAL RECONNECT
// ============================================================

async function reconnectServer(key) {
  if (ipBanDetected) {
    return false;
  }

  const state = states[key];

  state.captchaDetected = false;
  state.anotherClientDetected = false;
  state.shouldReconnect = true;

  if (state.reconnectTimer) {
    clearTimeout(
      state.reconnectTimer
    );

    state.reconnectTimer = null;
  }

  if (state.bot) {
    try {
      state.bot.quit(
        "Manual reconnect"
      );
    } catch {
      // ignore
    }

    state.bot = null;
  }

  await sleep(1500);

  if (ipBanDetected) {
    return false;
  }

  await connectServer(key);

  return true;
}

// ============================================================
// HELP
// ============================================================

function getHelpText() {
  return [
    "🤖 **Minecraft Discord Bot**",
    "",
    "`#help` — список команд",
    "`#tab` — TAB MineBlaze + DexLand",
    "`#kp2` — MineBlaze KitPvP 2",
    "`#reconnect` — переподключить оба сервера",
    "",
    "`#friendadd Nick` — добавить друга",
    "`#friendremove Nick` — удалить друга",
    "`#friends` — список друзей",
    "",
    "`#enemyadd Nick` — добавить врага",
    "`#enemyremove Nick` — удалить врага",
    "`#enemies` — список врагов"
  ].join("\n");
}

// ============================================================
// TAB HELPER
// ============================================================

function getTabText(bot, serverName, modeName) {
  if (
    !bot ||
    !bot.player ||
    !bot.players
  ) {
    return null;
  }

  const players =
    Object.values(
      bot.players
    );

  const lines =
    players.map(player => {
      const ping =
        Number.isFinite(
          Number(player.ping)
        )
          ? `${Math.round(
              Number(player.ping)
            )}ms`
          : "?";

      return `${player.username} — ${ping}`;
    });

  return (
    `📋 **${serverName} — ${modeName} (${players.length})**\n\n` +
    truncateText(
      lines.join("\n"),
      1800
    )
  );
}

// ============================================================
// DISCORD COMMANDS
// ============================================================

discord.on(
  "messageCreate",
  async message => {
    try {
      if (message.author.bot) {
        return;
      }

      if (
        !getChannelIds().includes(
          String(message.channel.id)
        )
      ) {
        return;
      }

      const content =
        message.content.trim();

      if (
        !content.startsWith(PREFIX)
      ) {
        return;
      }

      const args =
        content.split(/\s+/);

      const command =
        args[0]
          .slice(PREFIX.length)
          .toLowerCase();

      const value =
        args
          .slice(1)
          .join(" ")
          .trim();

      // ======================================================
      // HELP
      // ======================================================

      if (command === "help") {
        await message.reply(
          getHelpText()
        );

        return;
      }

      // ======================================================
      // TAB
      // ======================================================

      if (command === "tab") {
        if (ipBanDetected) {
          await message.reply(
            "🛑 TAB отменён: обнаружен IP-бан."
          );

          return;
        }

        await message.reply(
          "⏳ Подключаю серверы и захожу на KitPvP..."
        );

        try {
          // --------------------------------------------------
          // MINEBLAZE
          // --------------------------------------------------

          const mbState =
            states.mineblaze;

          if (
            !mbState.bot ||
            !mbState.bot.player
          ) {
            await connectServer(
              "mineblaze"
            );

            /*
             * connectServer сам:
             * /login
             * ждёт
             * /kp2
             *
             * Ждём достаточно долго,
             * чтобы сервер успел перевести бота.
             */
            await sleep(9000);

          } else {
            /*
             * Бот уже подключён.
             * Значит отправляем /kp2 вручную.
             */
            mbState.bot.chat(
              "/kp2"
            );

            console.log(
              "[MineBlaze] #tab: отправлен /kp2"
            );

            await sleep(5000);
          }

          // --------------------------------------------------
          // IP BAN CHECK
          // --------------------------------------------------

          if (ipBanDetected) {
            await message.channel.send(
              "🛑 Во время подключения MineBlaze обнаружен IP-бан. TAB отменён."
            );

            return;
          }

          // --------------------------------------------------
          // DEXLAND
          // --------------------------------------------------

          const dexState =
            states.dexland;

          if (
            !dexState.bot ||
            !dexState.bot.player
          ) {
            await connectServer(
              "dexland"
            );

            /*
             * connectServer сам:
             * /login
             * ждёт
             * /kp1
             */
            await sleep(9000);

          } else {
            /*
             * Бот уже подключён.
             * Отправляем /kp1 вручную.
             */
            dexState.bot.chat(
              "/kp1"
            );

            console.log(
              "[DexLand] #tab: отправлен /kp1"
            );

            await sleep(5000);
          }

          // --------------------------------------------------
          // IP BAN CHECK
          // --------------------------------------------------

          if (ipBanDetected) {
            await message.channel.send(
              "🛑 Во время подключения DexLand обнаружен IP-бан. TAB отменён."
            );

            return;
          }

          // --------------------------------------------------
          // MINEBLAZE TAB
          // --------------------------------------------------

          const mineBlazeTab =
            getTabText(
              mbState.bot,
              "MineBlaze",
              "KitPvP 2"
            );

          if (mineBlazeTab) {
            await message.channel.send(
              mineBlazeTab
            );
          } else {
            await message.channel.send(
              "❌ MineBlaze: не удалось получить TAB."
            );
          }

          // --------------------------------------------------
          // DEXLAND TAB
          // --------------------------------------------------

          const dexLandTab =
            getTabText(
              dexState.bot,
              "DexLand",
              "KitPvP 1"
            );

          if (dexLandTab) {
            await message.channel.send(
              dexLandTab
            );
          } else {
            await message.channel.send(
              "❌ DexLand: не удалось получить TAB."
            );
          }

        } catch (error) {
          console.log(
            `[TAB] Ошибка: ${
              error.stack ||
              error.message
            }`
          );

          await message.channel.send(
            `❌ Ошибка TAB: \`${error.message}\``
          );
        }

        return;
      }

      // ======================================================
      // KP2
      // ======================================================

      if (command === "kp2") {
        if (ipBanDetected) {
          await message.reply(
            "🛑 `/kp2` отменён: обнаружен IP-бан."
          );

          return;
        }

        const state =
          states.mineblaze;

        try {
          if (
            state.bot &&
            state.bot.player
          ) {
            state.bot.chat(
              "/kp2"
            );

            await message.reply(
              "🎮 Отправил `/kp2`."
            );

          } else {
            await message.reply(
              "⏳ MineBlaze не подключён. Подключаюсь..."
            );

            await connectServer(
              "mineblaze"
            );

            await sleep(9000);

            if (
              !ipBanDetected &&
              state.bot
            ) {
              state.bot.chat(
                "/kp2"
              );

              await message.channel.send(
                "🎮 Подключился и отправил `/kp2`."
              );
            } else {
              await message.channel.send(
                "❌ Подключение отменено."
              );
            }
          }

        } catch (error) {
          await message.channel.send(
            `❌ Ошибка: \`${error.message}\``
          );
        }

        return;
      }

      // ======================================================
      // RECONNECT
      // ======================================================

      if (command === "reconnect") {
        if (ipBanDetected) {
          await message.reply(
            "🛑 **Reconnect запрещён.**\nОбнаружен IP-бан, поэтому оба Minecraft-бота остановлены."
          );

          return;
        }

        await message.reply(
          "🔄 Переподключаю оба Minecraft-сервера..."
        );

        try {
          const first =
            await reconnectServer(
              "mineblaze"
            );

          if (ipBanDetected) {
            await message.channel.send(
              "🛑 Обнаружен IP-бан. Все дальнейшие подключения остановлены."
            );

            return;
          }

          const second =
            await reconnectServer(
              "dexland"
            );

          if (ipBanDetected) {
            await message.channel.send(
              "🛑 Обнаружен IP-бан. Все дальнейшие подключения остановлены."
            );

            return;
          }

          if (
            first &&
            second
          ) {
            await message.channel.send(
              "✅ Оба подключения перезапущены."
            );
          } else {
            await message.channel.send(
              "⚠️ Reconnect выполнен частично."
            );
          }

        } catch (error) {
          await message.channel.send(
            `❌ Ошибка reconnect: \`${error.message}\``
          );
        }

        return;
      }

      // ======================================================
      // FRIEND ADD
      // ======================================================

      if (command === "friendadd") {
        if (!value) {
          await message.reply(
            "Использование: `#friendadd Nick`"
          );

          return;
        }

        await addTrackedPlayer(
          value,
          "friend"
        );

        await message.reply(
          `🟢 **${value}** добавлен в Friend.`
        );

        return;
      }

      // ======================================================
      // FRIEND REMOVE
      // ======================================================

      if (command === "friendremove") {
        if (!value) {
          await message.reply(
            "Использование: `#friendremove Nick`"
          );

          return;
        }

        await removeTrackedPlayer(
          value
        );

        await message.reply(
          `🗑️ **${value}** удалён из списка.`
        );

        return;
      }

      // ======================================================
      // FRIENDS
      // ======================================================

      if (command === "friends") {
        const friends =
          await getTrackedPlayers(
            "friend"
          );

        if (!friends.length) {
          await message.reply(
            "🟢 Friend список пуст."
          );

          return;
        }

        await message.reply(
          `🟢 **Friends (${friends.length})**\n\n` +
          friends
            .map(
              username =>
                `• ${username}`
            )
            .join("\n")
        );

        return;
      }

      // ======================================================
      // ENEMY ADD
      // ======================================================

      if (command === "enemyadd") {
        if (!value) {
          await message.reply(
            "Использование: `#enemyadd Nick`"
          );

          return;
        }

        await addTrackedPlayer(
          value,
          "enemy"
        );

        await message.reply(
          `🔴 **${value}** добавлен в Enemy.`
        );

        return;
      }

      // ======================================================
      // ENEMY REMOVE
      // ======================================================

      if (command === "enemyremove") {
        if (!value) {
          await message.reply(
            "Использование: `#enemyremove Nick`"
          );

          return;
        }

        await removeTrackedPlayer(
          value
        );

        await message.reply(
          `🗑️ **${value}** удалён из списка.`
        );

        return;
      }

      // ======================================================
      // ENEMIES
      // ======================================================

      if (command === "enemies") {
        const enemies =
          await getTrackedPlayers(
            "enemy"
          );

        if (!enemies.length) {
          await message.reply(
            "🔴 Enemy список пуст."
          );

          return;
        }

        await message.reply(
          `🔴 **Enemies (${enemies.length})**\n\n` +
          enemies
            .map(
              username =>
                `• ${username}`
            )
            .join("\n")
        );

        return;
      }

    } catch (error) {
      console.log(
        `[Discord] Command error: ${
          error.stack ||
          error.message
        }`
      );
    }
  }
);

// ============================================================
// DISCORD READY
// ============================================================

discord.once(
  "ready",
  async () => {
    console.log(
      `🤖 Discord подключён как ${discord.user.tag}`
    );

    console.log(
      "🛑 Автоматический запуск Minecraft отключён до ручной команды."
    );

    await sendDiscordMessage(
      "🤖 Бот Discord запущен.\n" +
      "Minecraft подключается только по командам."
    );
  }
);

// ============================================================
// DISCORD ERROR
// ============================================================

discord.on(
  "error",
  error => {
    console.log(
      `[Discord] Error: ${error.message}`
    );
  }
);

// ============================================================
// START
// ============================================================

async function start() {
  try {
    await initDatabase();

    await discord.login(
      DISCORD_TOKEN
    );

  } catch (error) {
    console.error(
      "❌ Ошибка запуска:",
      error
    );

    process.exit(1);
  }
}

// ============================================================
// SHUTDOWN
// ============================================================

async function shutdown() {
  console.log(
    "🛑 Завершение работы..."
  );

  for (const key of [
    "mineblaze",
    "dexland"
  ]) {
    const state = states[key];

    state.shouldReconnect = false;

    if (state.reconnectTimer) {
      clearTimeout(
        state.reconnectTimer
      );

      state.reconnectTimer = null;
    }

    if (state.autoLeaveTimer) {
      clearTimeout(
        state.autoLeaveTimer
      );

      state.autoLeaveTimer = null;
    }

    if (state.bot) {
      try {
        state.bot.quit(
          "Bot shutdown"
        );
      } catch {
        // ignore
      }
    }
  }

  try {
    await discord.destroy();
  } catch {
    // ignore
  }

  try {
    await pool.end();
  } catch {
    // ignore
  }

  try {
    server.close();
  } catch {
    // ignore
  }

  process.exit(0);
}

process.on(
  "SIGINT",
  shutdown
);

process.on(
  "SIGTERM",
  shutdown
);

// ============================================================
// RUN
// ============================================================

start();
