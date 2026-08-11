const mineflayer = require('mineflayer');
const { pathfinder } = require('mineflayer-pathfinder');
const fs = require('fs');
const path = require('path');

// Проверяем наличие canvas
let canvas;
try {
    canvas = require('canvas');
    console.log('✅ Canvas загружен');
} catch (error) {
    console.log('⚠️ Canvas не найден, будет использован текстовый режим');
    canvas = null;
}

// ============================================
// КОНФИГУРАЦИЯ
// ============================================
const config = {
    minecraft: {
        host: 'play.mineblaze.com',
        port: 25565,
        version: '1.20.4',
        username: 'YourBotName',
        auth: 'offline'
    },
    discord: {
        enabled: false, // Отключаем Discord для теста
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
// ИНИЦИАЛИЗАЦИЯ
// ============================================
const registry = new PlayerRegistry();
registry.loadFromFile();

let minecraftBot = null;
let commandQueue = [];
let isProcessingQueue = false;
let reconnectTimeout = null;
let serverRestarting = false;

// ============================================
// ФУНКЦИЯ ДЛЯ СОЗДАНИЯ ИЗОБРАЖЕНИЯ (ЕСЛИ ЕСТЬ CANVAS)
// ============================================
function generatePlayerImage() {
    // Если canvas не загружен, возвращаем null
    if (!canvas) {
        return null;
    }

    try {
        const { createCanvas } = canvas;
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
        const canvasObj = createCanvas(width, Math.min(height, 800));
        const ctx = canvasObj.getContext('2d');

        // Фон
        const gradient = ctx.createLinearGradient(0, 0, width, 0);
        gradient.addColorStop(0, '#1a1a2e');
        gradient.addColorStop(0.5, '#16213e');
        gradient.addColorStop(1, '#1a1a2e');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, width, canvasObj.height);

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

        // Функция для отрисовки секции
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
                // Вместо roundRect используем обычный rect
                ctx.rect(x, y, itemWidth, itemHeight);
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
        const statsY = Math.min(canvasObj.height - 55, yPos + 20);
        ctx.fillStyle = 'rgba(255,255,255,0.05)';
        ctx.beginPath();
        ctx.rect(25, statsY, width - 50, 35);
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
        const footerY = canvasObj.height - 20;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#4a4a6a';
        ctx.font = '11px Arial';
        ctx.fillText(`🟢 Обновлено: ${new Date().toLocaleString()}`, width / 2, footerY);

        const imagePath = path.join(__dirname, 'player_list.png');
        const buffer = canvasObj.toBuffer('image/png');
        fs.writeFileSync(imagePath, buffer);

        return imagePath;
    } catch (error) {
        console.error('❌ Ошибка создания изображения:', error);
        return null;
    }
}

// ============================================
// ФУНКЦИЯ ДЛЯ ТЕКСТОВОГО СПИСКА
// ============================================
function getPlayerListText() {
    const players = registry.getPlayersWithStatus();
    
    if (players.length === 0) {
        return "❌ Нет игроков онлайн";
    }

    const friends = players.filter(p => p.status === 'friend');
    const enemies = players.filter(p => p.status === 'enemy');
    const neutral = players.filter(p => p.status === 'neutral');

    let text = '📋 Список игроков в KitPvP 2:\n';
    text += `👥 Всего: ${players.length} игроков\n\n`;
    
    if (friends.length > 0) {
        text += `🤝 Друзья (${friends.length}):\n`;
        friends.forEach(p => { text += `  • ${p.name}\n`; });
        text += '\n';
    }
    
    if (enemies.length > 0) {
        text += `👿 Враги (${enemies.length}):\n`;
        enemies.forEach(p => { text += `  • ${p.name}\n`; });
        text += '\n';
    }
    
    if (neutral.length > 0) {
        text += `👤 Игроки (${neutral.length}):\n`;
        neutral.forEach(p => { text += `  • ${p.name}\n`; });
        text += '\n';
    }
    
    text += `🕐 Обновлено: ${new Date().toLocaleString()}`;
    
    return text;
}

// ============================================
// MINECRAFT БОТ
// ============================================
function createMinecraftBot() {
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

    bot.loadPlugin(pathfinder);

    bot.on('login', () => {
        console.log(`✅ Бот зашел на сервер!`);
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
            }, 10000);
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
        }, 10000);
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
// ЗАПУСК ТОЛЬКО MINECRAFT БОТА
// ============================================
function startBot() {
    console.log('🚀 Запуск бота...');
    console.log('=================================');
    console.log(`📝 Имя бота: ${config.minecraft.username}`);
    console.log(`🌐 Сервер: ${config.minecraft.host}:${config.minecraft.port}`);
    console.log('=================================');
    
    minecraftBot = createMinecraftBot();
    
    console.log('✅ Бот запущен!');
    console.log('📖 Команды в чате: !bot help');
}

// ============================================
// КОМАНДЫ ДЛЯ MINECRAFT ЧАТА
// ============================================
// Обработка команд из чата добавлена в bot.on('chat')

// Переопределяем обработку chat для добавления команд
const originalCreateBot = createMinecraftBot;
createMinecraftBot = function() {
    const bot = originalCreateBot.call(this);
    
    // Добавляем обработчик команд
    bot.on('chat', (username, message) => {
        if (username === bot.username) return;
        
        if (message.startsWith('!bot')) {
            const args = message.split(' ');
            const command = args[1];
            
            switch(command) {
                case 'friend':
                    const friendName = args[2];
                    if (friendName) {
                        registry.addFriend(friendName);
                        bot.chat(`/friend add ${friendName}`);
                        console.log(`🤝 Добавлен друг: ${friendName}`);
                        bot.chat(`✅ ${friendName} добавлен в друзья!`);
                    }
                    break;
                    
                case 'enemy':
                    const enemyName = args[2];
                    if (enemyName) {
                        registry.addEnemy(enemyName);
                        console.log(`👿 Добавлен враг: ${enemyName}`);
                        bot.chat(`👿 ${enemyName} добавлен во враги!`);
                    }
                    break;

                case 'removefriend':
                    const removeFriendName = args[2];
                    if (removeFriendName) {
                        registry.removeFriend(removeFriendName);
                        console.log(`❌ Удален друг: ${removeFriendName}`);
                        bot.chat(`❌ ${removeFriendName} удален из друзей!`);
                    }
                    break;

                case 'removeenemy':
                    const removeEnemyName = args[2];
                    if (removeEnemyName) {
                        registry.removeEnemy(removeEnemyName);
                        console.log(`❌ Удален враг: ${removeEnemyName}`);
                        bot.chat(`❌ ${removeEnemyName} удален из врагов!`);
                    }
                    break;
                    
                case 'list':
                    const friends = registry.getFriends();
                    const enemies = registry.getEnemies();
                    bot.chat(`Друзья (${friends.length}): ${friends.join(', ') || 'нет'}`);
                    bot.chat(`Враги (${enemies.length}): ${enemies.join(', ') || 'нет'}`);
                    break;

                case 'online':
                    const players = registry.getPlayers();
                    if (players.length > 0) {
                        bot.chat(`👥 Онлайн (${players.length}): ${players.map(p => p.name).join(', ')}`);
                    } else {
                        bot.chat('❌ Нет игроков онлайн');
                    }
                    break;

                case 'tab':
                    bot.chat('/tab');
                    break;

                case 'help':
                    bot.chat('📖 Доступные команды:');
                    bot.chat('!bot friend [имя] - добавить друга');
                    bot.chat('!bot enemy [имя] - добавить врага');
                    bot.chat('!bot removefriend [имя] - удалить друга');
                    bot.chat('!bot removeenemy [имя] - удалить врага');
                    bot.chat('!bot list - список друзей/врагов');
                    bot.chat('!bot online - список онлайн');
                    bot.chat('!bot tab - обновить список');
                    break;
            }
        }
    });
    
    return bot;
};

// ============================================
// ОБРАБОТКА ОШИБОК
// ============================================
process.on('unhandledRejection', (error) => {
    console.error('❌ Необработанная ошибка:', error);
});

process.on('SIGINT', () => {
    console.log('\n🛑 Остановка бота...');
    if (minecraftBot) {
        minecraftBot.end();
    }
    process.exit(0);
});

// ============================================
// ЗАПУСК
// ============================================
startBot();
