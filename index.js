const mineflayer = require('mineflayer');
const {
    Client,
    GatewayIntentBits,
    EmbedBuilder
} = require('discord.js');

// ======================================================
// CONFIG
// ======================================================

const config = {
    minecraft: {
        host: 'mc.mineblaze.net',
        port: 25565,

        // Если сервер требует лицензионный аккаунт:
        // auth: 'microsoft',
        //
        // username тогда будет email Microsoft-аккаунта.
        username: 'YOUR_MINECRAFT_NICK',

        version: false
    },

    discord: {
        token: 'YOUR_DISCORD_BOT_TOKEN',

        // Канал, в котором разрешена команда !tab
        channelId: 'YOUR_CHANNEL_ID'
    }
};

// ======================================================
// MINECRAFT BOT
// ======================================================

let mcBot = null;

function createMinecraftBot() {
    console.log('[MC] Подключение к MineBlaze...');

    mcBot = mineflayer.createBot(config.minecraft);

    mcBot.once('spawn', () => {
        console.log('[MC] Бот вошёл на сервер');
        console.log(`[MC] Ник: ${mcBot.username}`);
    });

    mcBot.on('login', () => {
        console.log('[MC] Login OK');
    });

    mcBot.on('error', err => {
        console.log('[MC] ERROR:', err.message);
    });

    mcBot.on('kicked', reason => {
        console.log('[MC] KICK:', reason);
    });

    mcBot.on('end', () => {
        console.log('[MC] Соединение закрыто');

        // Переподключение через 10 секунд
        setTimeout(() => {
            createMinecraftBot();
        }, 10000);
    });
}

createMinecraftBot();

// ======================================================
// УДАЛЯЕМ §-ЦВЕТА ИЗ MINECRAFT ТЕКСТА
// ======================================================

function stripMinecraftColors(text) {
    if (!text) return '';

    return String(text)
        .replace(/§[0-9a-fk-or]/gi, '')
        .replace(/&[0-9a-fk-or]/gi, '');
}

// ======================================================
// ПОЛУЧАЕМ PREFIX / RANK
// ======================================================

function getPlayerPrefix(username) {
    if (!mcBot) return '';

    // Сначала пробуем teamMap
    const teamName = mcBot.teamMap?.[username];

    if (teamName) {
        const team = mcBot.teams?.[teamName];

        if (team?.prefix) {
            return stripMinecraftColors(
                team.prefix.toString()
            ).trim();
        }
    }

    // Иногда проще найти команду вручную
    for (const team of Object.values(mcBot.teams || {})) {
        if (!team.members) continue;

        if (team.members.includes(username)) {
            if (team.prefix) {
                return stripMinecraftColors(
                    team.prefix.toString()
                ).trim();
            }
        }
    }

    return '';
}

// ======================================================
// ПОЛУЧАЕМ ИГРОКОВ
// ======================================================

function getTabPlayers() {
    if (!mcBot) return [];

    const players = Object.values(mcBot.players || {});

    return players
        .map(player => {
            const username = player.username || 'Unknown';

            return {
                username,
                ping: typeof player.ping === 'number'
                    ? player.ping
                    : 0,

                prefix: getPlayerPrefix(username),

                displayName: player.displayName
                    ? stripMinecraftColors(
                        player.displayName.toString()
                    )
                    : username
            };
        })
        .sort((a, b) =>
            a.username.localeCompare(
                b.username,
                'en',
                { sensitivity: 'base' }
            )
        );
}

// ======================================================
// ДЕЛАЕМ TAB
// ======================================================

function createTabText(players) {
    let result = '';

    result += `Minecraft TAB\n`;
    result += `Игроков: ${players.length}\n`;
    result += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;

    for (const player of players) {
        let prefix = player.prefix;

        // Если prefix не найден, пробуем displayName
        if (!prefix || prefix === player.username) {
            prefix = '';
        }

        const ping = `${player.ping} ms`;

        let line = '';

        if (prefix) {
            line += `${prefix} `;
        }

        line += player.username;

        line += `  ${ping}`;

        result += line + '\n';
    }

    result += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

    return result;
}

// ======================================================
// DISCORD
// ======================================================

const discord = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

discord.once('ready', () => {
    console.log(
        `[DISCORD] Авторизован как ${discord.user.tag}`
    );
});

discord.on('messageCreate', async message => {
    if (message.author.bot) return;

    // Только нужный канал
    if (
        config.discord.channelId &&
        message.channel.id !== config.discord.channelId
    ) {
        return;
    }

    const command = message.content
        .trim()
        .toLowerCase();

    // ==================================================
    // !TAB
    // ==================================================

    if (command === '!tab') {
        if (!mcBot) {
            return message.reply(
                '❌ Minecraft-бот сейчас не подключён.'
            );
        }

        const players = getTabPlayers();

        if (!players.length) {
            return message.reply(
                '❌ Mineflayer пока не получил список игроков.'
            );
        }

        const tab = createTabText(players);

        // Discord лимит сообщения — 2000 символов.
        // Разбиваем TAB на несколько сообщений.
        const lines = tab.split('\n');

        let chunk = '```ansi\n';

        for (const line of lines) {
            if (
                (chunk + line + '\n').length >= 1900
            ) {
                chunk += '```';

                await message.channel.send(chunk);

                chunk = '```ansi\n';
            }

            chunk += line + '\n';
        }

        if (chunk.length > 10) {
            chunk += '```';

            await message.channel.send(chunk);
        }
    }

    // ==================================================
    // !TABDEBUG
    // ==================================================

    if (command === '!tabdebug') {
        if (!mcBot) {
            return message.reply(
                '❌ Minecraft-бот не подключён.'
            );
        }

        const players = getTabPlayers();

        let debug = '```text\n';
        debug += `Players: ${players.length}\n`;
        debug += `Teams: ${
            Object.keys(mcBot.teams || {}).length
        }\n\n`;

        for (const team of Object.values(
            mcBot.teams || {}
        )) {
            debug += `TEAM: ${team.name}\n`;
            debug += `PREFIX: ${
                team.prefix
                    ? team.prefix.toString()
                    : ''
            }\n`;
            debug += `MEMBERS: ${
                team.members?.join(', ') || ''
            }\n\n`;
        }

        debug += '```';

        // Если debug слишком большой
        if (debug.length > 1900) {
            debug = debug.slice(0, 1850) + '\n...```';
        }

        await message.reply(debug);
    }
});

// ======================================================
// DISCORD LOGIN
// ======================================================

discord.login(config.discord.token);
