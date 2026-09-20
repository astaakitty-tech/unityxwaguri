const mineflayer = require('mineflayer');
const { pathfinder } = require('mineflayer-pathfinder');
const Discord = require('discord.js');
const fs = require('fs');
const path = require('path');
const http = require('http');
require('dotenv').config();

// ============================================
// CANVAS
// ============================================
let canvas;
try {
    canvas = require('@napi-rs/canvas');
    console.log('✅ @napi-rs/canvas загружен');
} catch (e) {
    console.log('⚠️ Canvas не найден — текстовый режим');
    canvas = null;
}

// ============================================
// КОНФИГ
// ============================================
const config = {
    mc: {
        host: process.env.SERVER_IP || 'play.mineblaze.com',
        username: process.env.BOT_NAME || 'TabBot',
        version: process.env.BOT_VERSION || '1.18.2',
        auth: 'offline',
    },
    discord: {
        token: process.env.DISCORD_TOKEN,
        channelId: process.env.CHANNEL_ID,
    },
    tabWaitMs: 15000,
    cmdDelayMs: 10000,
    reconnectMinMs: 5000,
    reconnectMaxMs: 60000,
    autoConnect: false, // ⚠️ Бот НЕ подключается к MC при старте
};

// ============================================
// РЕЕСТР ДРУЗЕЙ / ВРАГОВ
// ============================================
class Registry {
    constructor() {
        this.friends = new Map();
        this.enemies = new Map();
        this.load();
    }
    norm(n) { return String(n).trim().toUpperCase(); }

    addFriend(n) { this.friends.set(this.norm(n), n); this.save(); }
    removeFriend(n) { const r = this.friends.delete(this.norm(n)); this.save(); return r; }
    isFriend(n) { return this.friends.has(this.norm(n)); }
    getFriends() { return [...this.friends.values()]; }

    addEnemy(n) { this.enemies.set(this.norm(n), n); this.save(); }
    removeEnemy(n) { const r = this.enemies.delete(this.norm(n)); this.save(); return r; }
    isEnemy(n) { return this.enemies.has(this.norm(n)); }
    getEnemies() { return [...this.enemies.values()]; }

    save() {
        try {
            fs.writeFileSync('registry.json', JSON.stringify({
                friends: [...this.friends.entries()],
                enemies: [...this.enemies.entries()],
            }, null, 2));
        } catch (e) { /* ignore */ }
    }
    load() {
        try {
            if (fs.existsSync('registry.json')) {
                const d = JSON.parse(fs.readFileSync('registry.json', 'utf8'));
                this.friends = new Map(d.friends || []);
                this.enemies = new Map(d.enemies || []);
                console.log('✅ Реестр загружен');
            }
        } catch (e) { /* ignore */ }
    }
}
const registry = new Registry();

// ============================================
// ГЛОБАЛЬНЫЕ
// ============================================
let mcBot = null;
let dcBot = null;
let isConnecting = false;
let isRestarting = false;
let reconnectTimer = null;
let reconnectDelay = config.reconnectMinMs;
let cmdQueue = [];
let cmdProcessing = false;
let tabReadyAt = 0;
let manualDisconnect = false; // ⚠️ флаг ручного отключения

// ============================================
// ОЧИСТКА ТЕКСТА
// ============================================
function clean(text) {
    if (!text) return '';
    return String(text)
        .replace(/§[0-9a-fklmnor]/gi, '')
        .replace(/\\u00a7[0-9a-fklmnor]/gi, '')
        .trim();
}

function displayNameToText(displayName, fallback) {
    if (!displayName) return fallback;
    if (typeof displayName === 'string') return clean(displayName);
    if (displayName.toString) {
        const str = displayName.toString();
        if (str.startsWith('{')) {
            try {
                const json = JSON.parse(str);
                let out = json.text || '';
                if (Array.isArray(json.extra)) {
                    for (const e of json.extra) out += (e.text || '');
                }
                return clean(out) || fallback;
            } catch { return fallback; }
        }
        return clean(str) || fallback;
    }
    return fallback;
}

// ============================================
// СПИСОК ИГРОКОВ
// ============================================
function getPlayers() {
    if (!mcBot || !mcBot.players) return [];
    const list = [];
    for (const name in mcBot.players) {
        const p = mcBot.players[name];
        if (!p || !p.username) continue;
        if (p.username === mcBot.username) continue;
        list.push({
            name: p.username,
            display: displayNameToText(p.displayName, p.username),
            ping: typeof p.ping === 'number' ? p.ping : null,
        });
    }
    list.sort((a, b) => (a.ping ?? 9999) - (b.ping ?? 9999));
    return list;
}

function getPlayersWithStatus() {
    return getPlayers().map(p => ({
        ...p,
        status: registry.isFriend(p.name) ? 'friend'
              : registry.isEnemy(p.name)  ? 'enemy'
              : 'neutral',
    }));
}

// ============================================
// ГЕНЕРАЦИЯ ИЗОБРАЖЕНИЯ
// ============================================
function generateImage() {
    if (!canvas) return null;
    try {
        const { createCanvas } = canvas;
        const players = getPlayersWithStatus();
        if (players.length === 0) return null;

        const friends = players.filter(p => p.status === 'friend');
        const enemies = players.filter(p => p.status === 'enemy');
        const neutral = players.filter(p => p.status === 'neutral');

        const rows = Math.max(
            Math.ceil(friends.length / 4),
            Math.ceil(enemies.length / 4),
            Math.ceil(neutral.length / 4),
        );
        const height = Math.max(420, Math.min(1200, 300 + rows * 33));
        const width = 800;

        const c = createCanvas(width, height);
        const ctx = c.getContext('2d');

        const g = ctx.createLinearGradient(0, 0, width, height);
        g.addColorStop(0, '#1a1a2e');
        g.addColorStop(0.5, '#16213e');
        g.addColorStop(1, '#1a1a2e');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, width, height);

        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillStyle = '#ffd700';
        ctx.font = 'bold 30px Arial';
        ctx.shadowColor = 'rgba(255,215,0,0.4)';
        ctx.shadowBlur = 12;
        ctx.fillText('⚔️ KitPvP 2 — Online', width / 2, 15);
        ctx.shadowBlur = 0;

        ctx.fillStyle = '#8888aa';
        ctx.font = '14px Arial';
        ctx.fillText(`MineBlaze • ${players.length} игроков`, width / 2, 58);

        let y = 95;

        const drawSection = (title, emoji, items, color, bg, yStart) => {
            if (!items.length) return yStart;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            ctx.fillStyle = '#fff';
            ctx.font = 'bold 18px Arial';
            ctx.fillText(`${emoji} ${title} (${items.length})`, 25, yStart);
            yStart += 28;

            const cols = 4, iw = 180, ih = 26, pad = 5;
            items.forEach((p, i) => {
                const col = i % cols, row = Math.floor(i / cols);
                const x = 25 + col * (iw + pad);
                const yy = yStart + row * (ih + pad);

                ctx.fillStyle = bg;
                ctx.shadowColor = color;
                ctx.shadowBlur = 4;
                ctx.beginPath();
                if (ctx.roundRect) ctx.roundRect(x, yy, iw, ih, 5);
                else ctx.rect(x, yy, iw, ih);
                ctx.fill();
                ctx.shadowBlur = 0;

                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillStyle = color;
                ctx.font = '13px Arial';
                const pingText = p.ping !== null ? `  ${p.ping}ms` : '';
                ctx.fillText(p.name + pingText, x + iw / 2, yy + ih / 2);
            });

            return yStart + Math.ceil(items.length / cols) * (ih + pad) + 15;
        };

        y = drawSection('Друзья', '🤝', friends, '#00ff88', 'rgba(0,255,136,0.12)', y);
        y = drawSection('Враги', '👿', enemies, '#ff4444', 'rgba(255,68,68,0.12)', y);
        y = drawSection('Нейтральные', '👤', neutral, '#aaaacc', 'rgba(255,255,255,0.06)', y);

        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#4a4a6a';
        ctx.font = '11px Arial';
        ctx.fillText(`🟢 Обновлено: ${new Date().toLocaleString()}`, width / 2, height - 18);

        const file = 'tab.png';
        fs.writeFileSync(file, c.toBuffer('image/png'));
        return file;
    } catch (e) {
        console.error('❌ Ошибка генерации изображения:', e.message);
        return null;
    }
}

function getTextList() {
    const players = getPlayersWithStatus();
    if (players.length === 0) return '❌ Нет игроков в табе';

    const F = players.filter(p => p.status === 'friend');
    const E = players.filter(p => p.status === 'enemy');
    const N = players.filter(p => p.status === 'neutral');

    let text = `📋 **Список игроков KitPvP 2**\n👥 Всего: ${players.length}\n\n`;
    if (F.length) text += `🤝 **Друзья (${F.length})**\n${F.map(p => `• ${p.name}`).join('\n')}\n\n`;
    if (E.length) text += `👿 **Враги (${E.length})**\n${E.map(p => `• ${p.name}`).join('\n')}\n\n`;
    if (N.length) text += `👤 **Нейтральные (${N.length})**\n${N.map(p => `• ${p.name}`).join('\n')}\n\n`;
    text += `🕐 ${new Date().toLocaleString()}`;
    return text;
}

// ============================================
// MINECRAFT БОТ
// ============================================
function createMcBot() {
    if (isConnecting) return;
    if (mcBot?._client?.connected) return;

    isConnecting = true;
    manualDisconnect = false;
    console.log(`🔄 Подключение к MC (${config.mc.host})...`);

    const botOptions = {
        host: config.mc.host,
        username: config.mc.username,
        version: config.mc.version,
        auth: 'offline',
        keepAlive: true,
        checkTimeoutInterval: 300000,
        hideErrors: true,
    };

    mcBot = mineflayer.createBot(botOptions);
    mcBot.loadPlugin(pathfinder);

    mcBot.on('login', () => {
        console.log('✅ Бот зашёл на сервер');
        isConnecting = false;
        isRestarting = false;
        reconnectDelay = config.reconnectMinMs;
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

        tabReadyAt = Date.now() + config.tabWaitMs;

        setTimeout(() => {
            if (mcBot?._client?.connected) sendCommand('/kp2');
        }, 3000);
    });

    mcBot.on('spawn', () => console.log('✅ Спавн'));

    mcBot.on('message', (msg) => {
        const text = msg.toString();
        console.log('📨', text);

        if (text.includes('Сервер перезагружается')) {
            console.log('⚠️ Сервер перезагружается');
            isRestarting = true;
            if (reconnectTimer) clearTimeout(reconnectTimer);
            reconnectTimer = setTimeout(() => {
                if (mcBot) mcBot.end('restart');
                setTimeout(() => { isRestarting = false; createMcBot(); }, 5000);
            }, 15000);
        }

        if (text.includes('Не удается подключиться')) {
            console.log('⚠️ Ошибка подключения — повтор');
            if (reconnectTimer) clearTimeout(reconnectTimer);
            reconnectTimer = setTimeout(() => { isRestarting = false; createMcBot(); }, 15000);
        }
    });

    mcBot.on('playerJoined', (p) => {
        if (p.username !== mcBot.username) console.log(`➕ ${p.username} зашёл`);
    });
    mcBot.on('playerLeft', (p) => console.log(`➖ ${p.username} вышел`));
    mcBot.on('kicked', (reason) => console.log('👢 Кикнут:', reason));

    mcBot.on('error', (err) => {
        const m = err.message || '';
        if (m.includes('keepAlive')) console.log('⚠️ keepAlive');
        else if (m.includes('ECONNRESET')) console.log('⚠️ ECONNRESET');
        else if (m.includes('ETIMEDOUT')) console.log('⚠️ ETIMEDOUT');
        else if (m.includes('socketClosed')) console.log('⚠️ socketClosed');
        else console.error('❌', m);
    });

    mcBot.on('end', (reason) => {
        console.log(`🔌 Отключен: ${reason || '?'}`);
        isConnecting = false;

        // ⚠️ Если отключили вручную — НЕ переподключаемся
        if (manualDisconnect) {
            console.log('🛑 Ручное отключение — автопереподключение отключено');
            mcBot = null;
            return;
        }

        if (isRestarting) return;

        if (reconnectTimer) clearTimeout(reconnectTimer);
        const delay = reconnectDelay;
        reconnectDelay = Math.min(reconnectDelay * 2, config.reconnectMaxMs);

        console.log(`⏳ Переподключение через ${delay / 1000} сек...`);
        reconnectTimer = setTimeout(() => createMcBot(), delay);
    });

    mcBot.on('chat', (username, message) => {
        if (username === mcBot.username) return;
        if (!message.startsWith('!bot')) return;

        const [, cmd, arg] = message.split(' ');
        switch (cmd) {
            case 'friend':
                if (arg) { registry.addFriend(arg); sendCommand(`/friend add ${arg}`); }
                break;
            case 'enemy':
                if (arg) registry.addEnemy(arg);
                break;
            case 'removefriend':
                if (arg) registry.removeFriend(arg);
                break;
            case 'removeenemy':
                if (arg) registry.removeEnemy(arg);
                break;
            case 'list':
                mcBot.chat(`🤝 ${registry.getFriends().join(', ') || 'нет'}`);
                mcBot.chat(`👿 ${registry.getEnemies().join(', ') || 'нет'}`);
                break;
            case 'help':
                mcBot.chat('📖 !bot friend/enemy/removefriend/removeenemy/list/help');
                break;
        }
    });
}

// ============================================
// ОЧЕРЕДЬ КОМАНД
// ============================================
function sendCommand(cmd) {
    if (!mcBot?._client?.connected) {
        cmdQueue.push(cmd);
        return;
    }
    cmdQueue.push(cmd);
    processQueue();
}

function processQueue() {
    if (cmdProcessing || cmdQueue.length === 0) return;
    if (!mcBot?._client?.connected) return;

    cmdProcessing = true;
    const next = () => {
        if (cmdQueue.length === 0) { cmdProcessing = false; return; }
        if (!mcBot?._client?.connected) { cmdProcessing = false; return; }

        const c = cmdQueue.shift();
        console.log(`📝 → ${c}`);
        mcBot.chat(c);
        setTimeout(next, config.cmdDelayMs);
    };
    next();
}

// ============================================
// DISCORD
// ============================================
async function startDiscord() {
    if (!config.discord.token || !config.discord.channelId) {
        console.log('⚠️ Discord не настроен');
        return;
    }

    dcBot = new Discord.Client({
        intents: [
            Discord.GatewayIntentBits.Guilds,
            Discord.GatewayIntentBits.GuildMessages,
            Discord.GatewayIntentBits.MessageContent,
        ],
    });

    dcBot.once('ready', () => {
        console.log(`✅ Discord: ${dcBot.user.tag}`);
        console.log(`💡 Бот НЕ подключён к MC. Напиши #connect в Discord`);
    });

    dcBot.on('messageCreate', async (msg) => {
        if (msg.author.bot) return;
        if (msg.channelId !== config.discord.channelId) return;

        const content = msg.content.trim();
        if (!content.startsWith('#')) return;

        const [cmd, ...rest] = content.slice(1).split(' ');
        const arg = rest.join(' ').trim();

        try {
            switch (cmd.toLowerCase()) {

                case 'connect': {
                    if (mcBot?._client?.connected) {
                        await msg.reply('✅ Уже подключён');
                    } else {
                        await msg.reply('🔄 Подключаюсь к MC... Подожди ~20 секунд и напиши `#tab`');
                        isRestarting = false;
                        manualDisconnect = false;
                        reconnectDelay = config.reconnectMinMs;
                        if (reconnectTimer) clearTimeout(reconnectTimer);
                        createMcBot();
                    }
                    break;
                }

                case 'disconnect': {
                    if (mcBot) {
                        await msg.reply('🔌 Отключаюсь от MC...');
                        manualDisconnect = true;
                        if (reconnectTimer) clearTimeout(reconnectTimer);
                        isRestarting = false;
                        try { mcBot.end('manual'); } catch {}
                        mcBot = null;
                        cmdQueue = []; cmdProcessing = false;
                    } else {
                        await msg.reply('❌ Уже отключён');
                    }
                    break;
                }

                case 'tab': {
                    if (!mcBot?._client?.connected) {
                        await msg.reply('❌ Бот не подключён. Напиши `#connect` сначала');
                        break;
                    }

                    await msg.reply('🔄 Собираю таб...');
                    const wait = Math.max(0, tabReadyAt - Date.now());
                    if (wait > 0) await new Promise(r => setTimeout(r, wait));

                    const players = getPlayers();
                    if (players.length === 0) {
                        await msg.channel.send('❌ Таб пуст. Возможно бот ещё не в KitPvP 2 или данные не загружены.');
                        break;
                    }

                    const img = generateImage();
                    if (img && fs.existsSync(img)) {
                        await msg.channel.send({
                            content: `📋 **Игроков в табе: ${players.length}**`,
                            files: [img],
                        });
                        fs.unlinkSync(img);
                    } else {
                        const text = getTextList();
                        const chunks = text.match(/[\s\S]{1,1900}/g) || [text];
                        for (const ch of chunks) await msg.channel.send(ch);
                    }
                    break;
                }

                case 'botenemy': {
                    if (!arg) { await msg.reply('❌ Использование: `#botenemy ник`'); break; }
                    registry.addEnemy(arg);
                    await msg.reply(`👿 **${arg}** добавлен во враги`);
                    break;
                }

                case 'botfriend': {
                    if (!arg) { await msg.reply('❌ Использование: `#botfriend ник`'); break; }
                    registry.addFriend(arg);
                    if (mcBot?._client?.connected) sendCommand(`/friend add ${arg}`);
                    await msg.reply(`🤝 **${arg}** добавлен в друзья`);
                    break;
                }

                case 'removeenemy': {
                    if (!arg) { await msg.reply('❌ Использование: `#removeenemy ник`'); break; }
                    registry.removeEnemy(arg);
                    await msg.reply(`❌ **${arg}** удалён из врагов`);
                    break;
                }

                case 'removefriend': {
                    if (!arg) { await msg.reply('❌ Использование: `#removefriend ник`'); break; }
                    registry.removeFriend(arg);
                    await msg.reply(`❌ **${arg}** удалён из друзей`);
                    break;
                }

                case 'status': {
                    const connected = mcBot?._client?.connected;
                    await msg.reply(
                        `📊 **Статус:**\n` +
                        `🔌 MC-бот: ${connected ? '✅ подключён' : '❌ отключён'}\n` +
                        `👥 Игроков в табе: ${getPlayers().length}\n` +
                        `🕐 ${new Date().toLocaleString()}`
                    );
                    break;
                }

                case 'help': {
                    await msg.reply(
                        '**Команды:**\n' +
                        '`#connect` — подключить MC-бота\n' +
                        '`#disconnect` — отключить MC-бота\n' +
                        '`#tab` — показать таб (картинка)\n' +
                        '`#status` — статус бота\n' +
                        '`#botfriend ник` — добавить в друзья\n' +
                        '`#botenemy ник` — добавить во враги\n' +
                        '`#removefriend ник` — убрать из друзей\n' +
                        '`#removeenemy ник` — убрать из врагов\n\n' +
                        '⚠️ **Сначала #connect, потом #tab**'
                    );
                    break;
                }
            }
        } catch (e) {
            console.error('❌ Discord handler:', e);
            msg.reply('❌ Ошибка: ' + e.message).catch(() => {});
        }
    });

    await dcBot.login(config.discord.token);
}

// ============================================
// HTTP-СЕРВЕР (для UptimeRobot)
// ============================================
function startHttpServer() {
    const port = process.env.PORT || 3000;
    http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`OK\nMC: ${mcBot?._client?.connected ? 'connected' : 'disconnected'}\nUptime: ${Math.floor(process.uptime())}s`);
    }).listen(port, () => {
        console.log(`🌐 HTTP-сервер на порту ${port}`);
    });
}

// ============================================
// ЗАПУСК
// ============================================
async function main() {
    console.log('🚀 Старт');
    console.log('==========================================');
    startHttpServer();
    await startDiscord();
    console.log('==========================================');

    // ⚠️ НЕ подключаемся к MC автоматически
    if (config.autoConnect) {
        console.log('🔌 Автоподключение к MC...');
        createMcBot();
    } else {
        console.log('💤 Ожидание команды #connect в Discord');
        console.log('   Напиши #connect чтобы подключить MC-бота');
    }

    console.log('==========================================');
    console.log(`📦 Canvas: ${canvas ? '✅' : '❌'}`);
    console.log(`🌐 MC сервер: ${config.mc.host} (SRV)`);
    console.log(`🎮 Версия: ${config.mc.version}`);
    console.log('==========================================');
}

process.on('unhandledRejection', e => console.error('❌ Unhandled:', e?.message || e));
process.on('SIGINT', () => {
    console.log('\n🛑 Остановка...');
    if (mcBot) try { mcBot.end('shutdown'); } catch {}
    if (dcBot) try { dcBot.destroy(); } catch {}
    process.exit(0);
});

main();
