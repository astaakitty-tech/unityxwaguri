const mineflayer = require('mineflayer');
const { pathfinder } = require('mineflayer-pathfinder');
const fs = require('fs');
const path = require('path');
const { createCanvas } = require('canvas');
const Discord = require('discord.js');

// ============================================
// КОНФИГУРАЦИЯ
// ============================================
const config = {
    minecraft: {
        host: 'play.mineblaze.com',
        port: 25565,
        version: '1.20.4',
        username: 'YourBotName',
        auth: 'offline',
        keepAlive: true,
        checkTimeoutInterval: 30000,
        reconnectDelay: 10000
    },
    discord: {
        enabled: true,
        token: 'YOUR_DISCORD_BOT_TOKEN',
        channelId: 'YOUR_DISCORD_CHANNEL_ID'
    }
};

// ============================================
// РЕЕСТР ИГРОКОВ
// ============================================
class PlayerRegistry {
    constructor() {
        this.friends = new Map();
        this.enemies = new Map();
        this.players = new Map();
        this.lastUpdate = null;
    }

    normalize(name) {
        return name.trim().toUpperCase();
    }

    addFriend(name) {
        const normalized = this.normalize(name);
        this.friends.set(normalized, name);
        this.saveToFile();
        return normalized;
    }

    removeFriend(name) {
        const normalized = this.normalize(name);
        const result = this.friends.delete(normalized);
        this.saveToFile();
        return result;
    }

    isFriend(name) {
        return this.friends.has(this.normalize(name));
    }

    addEnemy(name) {
        const normalized = this.normalize(name);
        this.enemies.set(normalized, name);
        this.saveToFile();
        return normalized;
    }

    removeEnemy(name) {
        const normalized = this.normalize(name);
        const result = this.enemies.delete(normalized);
        this.saveToFile();
        return result;
    }

    isEnemy(name) {
        return this.enemies.has(this.normalize(name));
    }

    getFriends() {
        return Array.from(this.friends.values());
    }

    getEnemies() {
        return Array.from(this.enemies.values());
    }

    getPlayerStatus(name) {
        const normalized = this.normalize(name);
        if (this.friends.has(normalized)) return 'friend';
        if (this.enemies.has(normalized)) return 'enemy';
        return 'neutral';
    }

    addPlayer(name, ping = 0) {
        const normalized = this.normalize(name);
        this.players.set(normalized, { name, ping });
        return normalized;
    }

    clearPlayers() {
        this.players.clear();
    }

    getPlayers() {
        return Array.from(this.players.values());
    }

    getPlayersWithStatus() {
        const result = [];
        for (const [_, player] of this.players) {
            result.push({
                ...player,
                status: this.getPlayerStatus(player.name)
            });
        }
        return result;
    }

    saveToFile() {
        const filePath = path.join(__dirname, 'registry.json');
        const data = {
            friends: Array.from(this.friends.entries()),
            enemies: Array.from(this.enemies.entries())
        };
        try {
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        } catch (error) {
            console.error('❌ Ошибка сохранения реестра:', error);
        }
    }

    loadFromFile() {
        const filePath = path.join(__dirname, 'registry.json');
        try {
            if (fs.existsSync(filePath)) {
                const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                this.friends = new Map(data.friends);
                this.enemies = new Map(data.enemies);
                console.log('✅ Реестр загружен из файла');
                return true;
            }
        } catch (error) {
            console.error('❌ Ошибка загрузки реестра:', error);
        }
        return false;
    }
}

// ============================================
// СОЗДАНИЕ ИЗОБРАЖЕНИЯ
// ============================================
async function generatePlayerImage() {
    const players = registry.getPlayersWithStatus();
    
    if (players.length === 0) {
        return null;
    }

    const sortedPlayers = players.sort((a, b) => a.name.localeCompare(b.name));
    const friends = sortedPlayers.filter(p => p.status === 'friend');
    const enemies = sortedPlayers.filter(p => p.status === 'enemy');
    const neutral = sortedPlayers.filter(p => p.status === 'neutral');

    const width = 800;
    const height = 500 + Math.max(0, Math.floor((players.length - 20) / 4) * 35);
    const canvas = createCanvas(width, Math.min(height, 800));
    const ctx = canvas.getContext('2d');

    // Фон
    const gradient = ctx.createLinearGradient(0, 0, width, 0);
    gradient.addColorStop(0, '#1a1a2e');
    gradient.addColorStop(0.5, '#16213e');
    gradient.addColorStop(1, '#1a1a2e');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, canvas.height);

    // Заголовок
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#ffd700';
    ctx.font = 'bold 32px Arial';
    ctx.shadowColor = 'rgba(255,215,0,0.3)';
    ctx.shadowBlur = 10;
    ctx.fillText('⚔️ KitPvP 2 Online', width / 2, 15);
    ctx.shadowBlur = 0;

    ctx.fillStyle = '#8888aa';
    ctx.font = '14px Arial';
    ctx.fillText(`MineBlaze • ${players.length} игроков онлайн`, width / 2, 60);

    let yPos = 95;

    function drawSection(title, emoji, items, color, bgColor, yStart) {
        if (items.length === 0) return yStart;

        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillStyle = '#ffffff';
        ctx.font = '18px Arial';
        ctx.fillText(`${emoji} ${title} (${items.length})`, 25, yStart);

        yStart += 30;

        const cols = 4;
        const itemWidth = 175;
        const itemHeight = 28;
        const padding = 5;

        items.forEach((player, index) => {
            const col = index % cols;
            const row = Math.floor(index / cols);
            const x = 25 + col * (itemWidth + padding);
            const y = yStart + row * (itemHeight + padding);

            ctx.fillStyle = bgColor;
            ctx.shadowColor = color;
            ctx.shadowBlur = 3;
            ctx.beginPath();
            ctx.roundRect(x, y, itemWidth, itemHeight, 5);
            ctx.fill();
            ctx.shadowBlur = 0;

            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillStyle = color;
            ctx.font = '13px Arial';
            ctx.fillText(player.name, x + itemWidth / 2, y + itemHeight / 2);
        });

        return yStart + Math.ceil(items.length / cols) * (itemHeight + padding) + 15;
    }

    yPos = drawSection('Друзья', '🤝', friends, '#00ff88', 'rgba(0,255,136,0.1)', yPos);
    yPos = drawSection('Враги', '👿', enemies, '#ff4444', 'rgba(255,68,68,0.1)', yPos);
    yPos = drawSection('Игроки', '👤', neutral, '#aaaacc', 'rgba(255,255,255,0.05)', yPos);

    // Статистика
    const statsY = Math.min(canvas.height - 55, yPos + 20);
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    ctx.beginPath();
    ctx.roundRect(25, statsY, width - 50, 35, 8);
    ctx.fill();

    const stats = [
        { label: '🤝 Друзья', value: friends.length },
        { label: '👿 Враги', value: enemies.length },
        { label: '👤 Всего', value: players.length }
    ];

    stats.forEach((stat, index) => {
        const x = width / 6 + (index * width / 3);
        ctx.fillStyle = '#aaaacc';
        ctx.font = '12px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${stat.label}:`, x - 25, statsY + 17);
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 13px Arial';
        ctx.fillText(stat.value, x + 25, statsY + 17);
    });

    // Футер
    const footerY = canvas.height - 20;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#4a4a6a';
    ctx.font = '11px Arial';
    ctx.fillText(`🟢 Обновлено: ${new Date().toLocaleString()}`, width / 2, footerY);

    const imagePath = path.join(__dirname, 'player_list.png');
    const buffer = canvas.toBuffer('image/png');
    fs.writeFileSync(imagePath, buffer);

    return imagePath;
}

// Добавляем roundRect
if (!CanvasRenderingContext2D.prototype.roundRect) {
    CanvasRenderingContext2D.prototype.roundRect = function(x, y, w, h, r) {
        if (r > w / 2) r = w / 2;
        if (r > h / 2) r = h / 2;
        this.moveTo(x + r, y);
        this.lineTo(x + w - r, y);
        this.quadraticCurveTo(x + w, y, x + w, y + r);
        this.lineTo(x + w, y + h - r);
        this.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        this.lineTo(x + r, y + h);
        this.quadraticCurveTo(x, y + h, x, y + h - r);
        this.lineTo(x, y + r);
        this.quadraticCurveTo(x, y, x + r, y);
        this.closePath();
        return this;
    };
}

// ============================================
// ИНИЦИАЛИЗАЦИЯ
// ============================================
const registry = new PlayerRegistry();
registry.loadFromFile();

let minecraftBot = null;
let discordBot = null;
let isConnecting = false;
let commandQueue = [];
let isProcessingQueue = false;
let reconnectTimeout = null;
let serverRestarting = false;

// ============================================
// MINECRAFT БОТ
// ============================================
function createMinecraftBot() {
    if (isConnecting) return;
    isConnecting = true;

    console.log(`🔄 Подключение к серверу...`);

    const bot = mineflayer.createBot({
        host: config.minecraft.host,
        port: config.minecraft.port,
        username: config.minecraft.username,
        version: config.minecraft.version,
        auth: config.minecraft.auth,
        keepAlive: true,
        checkTimeoutInterval: 30000,
        hideErrors: true
    });

    let isLoggedIn = false;

    bot.on('login', () => {
        console.log(`✅ Бот зашел на сервер!`);
        isLoggedIn = true;
        isConnecting = false;
        serverRestarting = false;
        
        if (reconnectTimeout) {
            clearTimeout(reconnectTimeout);
            reconnectTimeout = null;
        }

        // Отправляем команду /kp2 с задержкой
        setTimeout(() => {
            sendCommand('/kp2');
        }, 2000);
    });

    bot.on('spawn', () => {
        console.log(`✅ Бот появился в мире!`);
    });

    bot.on('message', (message) => {
        const text = message.toString();
        console.log(`📨 [Сервер] ${text}`);

        // Проверка на перезагрузку сервера
        if (text.includes('Сервер перезагружается....')) {
            console.log('⚠️ Сервер перезагружается!');
            serverRestarting = true;
            if (reconnectTimeout) {
                clearTimeout(reconnectTimeout);
            }
            reconnectTimeout = setTimeout(() => {
                console.log('🔄 Переподключение после перезагрузки...');
                if (minecraftBot) {
                    minecraftBot.end();
                }
                setTimeout(() => {
                    createMinecraftBot();
                }, 5000);
            }, 15000);
        }

        // Проверка на ошибку подключения
        if (text.includes('Не удается подключиться на сервер')) {
            console.log('⚠️ Не удается подключиться к серверу');
            isConnecting = false;
            if (reconnectTimeout) {
                clearTimeout(reconnectTimeout);
            }
            reconnectTimeout = setTimeout(() => {
                console.log('🔄 Повторная попытка подключения...');
                createMinecraftBot();
            }, 15000);
        }

        // Парсинг списка игроков
        if (text.includes('Список игроков') || text.includes('Online:')) {
            parseTabList(text);
        }
    });

    bot.on('tablist', (tabList) => {
        if (tabList && tabList.players) {
            registry.clearPlayers();
            tabList.players.forEach(player => {
                if (player.name) {
                    registry.addPlayer(player.name, player.ping || 0);
                }
            });
            registry.lastUpdate = new Date();
            console.log(`👥 Обновлен список: ${registry.getPlayers().length} игроков`);
        }
    });

    bot.on('error', (err) => {
        if (err.message && err.message.includes('ECONNRESET')) {
            console.log('⚠️ Соединение сброшено, переподключение...');
        } else if (err.message && err.message.includes('ETIMEDOUT')) {
            console.log('⚠️ Таймаут подключения, переподключение...');
        } else if (err.message && err.message.includes('keepAlive')) {
            console.log('⚠️ Ошибка keepAlive, переподключение...');
        } else {
            console.error(`❌ Ошибка: ${err.message}`);
        }
        
        isConnecting = false;
        if (!serverRestarting) {
            setTimeout(() => {
                if (!minecraftBot || !minecraftBot._client || !minecraftBot._client.connected) {
                    console.log('🔄 Переподключение после ошибки...');
                    createMinecraftBot();
                }
            }, 5000);
        }
    });

    bot.on('end', (reason) => {
        console.log(`🔌 Бот отключен: ${reason || 'неизвестная причина'}`);
        isLoggedIn = false;
        isConnecting = false;

        if (reason && reason.includes('keepAlive')) {
            console.log('⚠️ Ошибка keepAlive, переподключение...');
        }

        if (!serverRestarting) {
            if (reconnectTimeout) {
                clearTimeout(reconnectTimeout);
            }
            reconnectTimeout = setTimeout(() => {
                console.log('🔄 Переподключение...');
                createMinecraftBot();
            }, config.minecraft.reconnectDelay);
        }
    });

    // Отправка команд из очереди
    bot.on('spawn', () => {
        setTimeout(() => {
            processCommandQueue();
        }, 5000);
    });

    return bot;
}

// ============================================
// ОЧЕРЕДЬ КОМАНД
// ============================================
function sendCommand(command) {
    if (!minecraftBot || !minecraftBot._client || !minecraftBot._client.connected) {
        console.log(`⏳ Команда "${command}" будет отправлена после подключения`);
        commandQueue.push(command);
        return;
    }

    console.log(`📝 Отправка команды: ${command}`);
    commandQueue.push(command);
    processCommandQueue();
}

function processCommandQueue() {
    if (isProcessingQueue || commandQueue.length === 0) return;
    if (!minecraftBot || !minecraftBot._client || !minecraftBot._client.connected) {
        console.log('⏳ Ожидание подключения для отправки команд...');
        return;
    }

    isProcessingQueue = true;

    function sendNext() {
        if (commandQueue.length === 0) {
            isProcessingQueue = false;
            return;
        }

        const command = commandQueue.shift();
        console.log(`📝 Отправка: ${command}`);
        minecraftBot.chat(command);

        setTimeout(() => {
            sendNext();
        }, 10000); // Задержка 10 секунд между командами
    }

    sendNext();
}

// ============================================
// ПАРСИНГ TABLIST
// ============================================
function parseTabList(message) {
    const playerPattern = /[a-zA-Z0-9_]{3,16}/g;
    const players = message.match(playerPattern);
    
    if (players) {
        registry.clearPlayers();
        players.forEach(name => {
            if (name.length >= 3 && name.length <= 16) {
                registry.addPlayer(name);
            }
        });
        registry.lastUpdate = new Date();
        console.log(`👥 Обновлен список: ${registry.getPlayers().length} игроков`);
    }
}

// ============================================
// DISCORD БОТ
// ============================================
async function startDiscordBot() {
    if (!config.discord.enabled) {
        console.log('ℹ️ Discord бот отключен');
        return null;
    }

    if (!config.discord.token || config.discord.token === 'YOUR_DISCORD_BOT_TOKEN') {
        console.log('⚠️ Токен Discord не настроен');
        return null;
    }

    try {
        discordBot = new Discord.Client({
            intents: [
                Discord.GatewayIntentBits.Guilds,
                Discord.GatewayIntentBits.GuildMessages,
                Discord.GatewayIntentBits.MessageContent
            ]
        });

        discordBot.on('ready', () => {
            console.log(`✅ Discord бот запущен как ${discordBot.user.tag}`);
        });

        discordBot.on('messageCreate', async (message) => {
            if (message.author.bot) return;
            if (message.channelId !== config.discord.channelId) return;

            const content = message.content.trim();
            
            // #tab - показать список игроков
            if (content === '#tab') {
                await message.reply('🔄 Получение списка игроков...');
                
                try {
                    if (minecraftBot && minecraftBot._client && minecraftBot._client.connected) {
                        // Отправляем команду /tab с задержкой
                        sendCommand('/tab');
                        await new Promise(resolve => setTimeout(resolve, 5000));
                    }
                    
                    // Генерируем изображение
                    const imagePath = await generatePlayerImage();
                    
                    if (imagePath && fs.existsSync(imagePath)) {
                        await message.channel.send({
                            content: '📋 **Список игроков в KitPvP 2:**',
                            files: [imagePath]
                        });
                        fs.unlinkSync(imagePath);
                    } else {
                        // Текстовый вариант
                        const players = registry.getPlayers();
                        if (players.length > 0) {
                            const list = players.map(p => {
                                const status = registry.getPlayerStatus(p.name);
                                const emoji = status === 'friend' ? '🤝' : status === 'enemy' ? '👿' : '👤';
                                return `${emoji} ${p.name}`;
                            }).join('\n');
                            await message.channel.send(`📋 **Список игроков:**\n${list}`);
                        } else {
                            await message.channel.send('❌ Нет игроков онлайн');
                        }
                    }
                } catch (error) {
                    console.error('❌ Ошибка:', error);
                    await message.channel.send('❌ Произошла ошибка');
                }
            }
            
            // #connect - подключиться к серверу
            if (content === '#connect') {
                if (minecraftBot && minecraftBot._client && minecraftBot._client.connected) {
                    await message.reply('✅ Бот уже подключен к серверу');
                } else {
                    await message.reply('🔄 Подключение к серверу...');
                    if (reconnectTimeout) {
                        clearTimeout(reconnectTimeout);
                        reconnectTimeout = null;
                    }
                    createMinecraftBot();
                }
            }
            
            // #disconnect - отключиться от сервера
            if (content === '#disconnect') {
                if (minecraftBot) {
                    await message.reply('🔌 Отключение от сервера...');
                    minecraftBot.end();
                    minecraftBot = null;
                    commandQueue = [];
                    isProcessingQueue = false;
                } else {
                    await message.reply('❌ Бот уже отключен');
                }
            }
            
            // #botenemy [имя] - добавить врага
            if (content.startsWith('#botenemy ')) {
                const name = content.slice(10).trim();
                if (name) {
                    registry.addEnemy(name);
                    await message.reply(`👿 **${name}** добавлен во враги!`);
                }
            }
            
            // #help - помощь
            if (content === '#help') {
                await message.reply(
                    '📖 **Доступные команды:**\n' +
                    '`#tab` - показать список игроков\n' +
                    '`#connect` - подключиться к серверу\n' +
                    '`#disconnect` - отключиться от сервера\n' +
                    '`#botenemy [имя]` - добавить врага\n' +
                    '`#help` - показать это сообщение'
                );
            }
        });

        await discordBot.login(config.discord.token);
        return discordBot;
        
    } catch (error) {
        console.error('❌ Ошибка запуска Discord бота:', error.message);
        return null;
    }
}

// ============================================
// ЗАПУСК
// ============================================
async function startBots() {
    console.log('🚀 Запуск ботов...');
    console.log('=================================');
    
    // Запускаем Discord бота
    await startDiscordBot();
    
    console.log('=================================');
    
    // Запускаем Minecraft бота
    minecraftBot = createMinecraftBot();
    
    console.log('=================================');
    console.log('✅ Бот готов к работе!');
    console.log(`📝 Имя бота: ${config.minecraft.username}`);
    console.log(`🌐 Сервер: ${config.minecraft.host}:${config.minecraft.port}`);
    console.log('=================================');
    console.log('📖 Доступные команды Discord: #help');
}

// Обработка ошибок
process.on('unhandledRejection', (error) => {
    console.error('❌ Необработанная ошибка:', error);
});

process.on('SIGINT', () => {
    console.log('\n🛑 Остановка ботов...');
    if (minecraftBot) {
        minecraftBot.end();
    }
    if (discordBot) {
        discordBot.destroy();
    }
    process.exit(0);
});

// Запуск
startBots();
