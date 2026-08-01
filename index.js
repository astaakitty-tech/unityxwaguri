require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const mineflayer = require('mineflayer');
const { createCanvas, loadImage } = require('canvas');
const path = require('path');
const fs = require('fs');

// --- KEEP ALIVE ДЛЯ RENDER ---
const http = require('http');

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is alive!');
});

server.listen(process.env.PORT || 3000, () => {
    console.log(`✅ Keep-alive сервер запущен на порту ${process.env.PORT || 3000}`);
});

// --- КОНФИГУРАЦИЯ ---
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const MINECRAFT_HOST = process.env.MINECRAFT_HOST || 'localhost';
const MINECRAFT_PORT = parseInt(process.env.MINECRAFT_PORT) || 25565;
const MINECRAFT_USERNAME = process.env.MINECRAFT_USERNAME || 'DiscordBot';
const MINECRAFT_VERSION = process.env.MINECRAFT_VERSION || '1.8.9';
const SERVER_PASSWORD = process.env.SERVER_PASSWORD || null;
const DATA_FILE = path.join(__dirname, 'data.json');

// --- ЗАГРУЗКА ДАННЫХ ---
function loadData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
            return data;
        }
    } catch (err) {
        console.error('❌ Ошибка загрузки данных:', err);
    }
    return { friends: [], enemies: [] };
}

function saveData() {
    try {
        const data = {
            friends: friendList,
            enemies: enemyList
        };
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
        console.error('❌ Ошибка сохранения данных:', err);
    }
}

// --- ЗАГРУЖАЕМ СОХРАНЁННЫЕ ДАННЫЕ ---
let savedData = loadData();
let friendList = savedData.friends || [];
let enemyList = savedData.enemies || [];
let onlinePlayers = [];

// --- DISCORD КЛИЕНТ ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ]
});

// --- ПЕРЕМЕННЫЕ БОТА ---
let bot = null;
let isConnected = false;
let isAuthorized = false;
let hasJoinedMode = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
let lastCommandTime = 0;
const COMMAND_DELAY = 2000;

// --- ОТПРАВКА В DISCORD ---
function sendDiscordMessage(content) {
    if (!DISCORD_CHANNEL_ID) return;
    const channel = client.channels.cache.get(DISCORD_CHANNEL_ID);
    if (channel) {
        channel.send(content).catch(err => console.error('Ошибка отправки в Discord:', err));
    }
}

// --- ФУНКЦИЯ ДЛЯ ЗАДЕРЖКИ КОМАНД ---
function sendCommandWithDelay(command) {
    const now = Date.now();
    const timeSinceLastCommand = now - lastCommandTime;
    
    if (timeSinceLastCommand < COMMAND_DELAY) {
        const waitTime = COMMAND_DELAY - timeSinceLastCommand;
        console.log(`⏳ Ждём ${waitTime}мс перед командой: ${command}`);
        setTimeout(() => {
            if (bot) {
                bot.chat(command);
                lastCommandTime = Date.now();
                console.log(`✅ Отправлена команда: ${command}`);
            }
        }, waitTime);
    } else {
        if (bot) {
            bot.chat(command);
            lastCommandTime = Date.now();
            console.log(`✅ Отправлена команда: ${command}`);
        }
    }
}

// --- ФУНКЦИИ ДЛЯ СПИСКОВ ---
function normalizeName(name) {
    return name.toLowerCase();
}

function isInList(list, name) {
    return list.some(item => normalizeName(item) === normalizeName(name));
}

function addToList(list, name) {
    if (!isInList(list, name)) {
        list.push(name);
        saveData();
        return true;
    }
    return false;
}

function removeFromList(list, name) {
    const index = list.findIndex(item => normalizeName(item) === normalizeName(name));
    if (index !== -1) {
        list.splice(index, 1);
        saveData();
        return true;
    }
    return false;
}

// --- ПОЛУЧЕНИЕ СПИСКА ИГРОКОВ ---
function getPlayers() {
    const players = [];
    for (const name of onlinePlayers) {
        if (name === bot?.username) continue;
        players.push({
            name: name,
            ping: 0,
            isFriend: isInList(friendList, name),
            isEnemy: isInList(enemyList, name)
        });
    }
    return players;
}

// --- ГЕНЕРАЦИЯ ГРАДИЕНТА ДЛЯ ДРУЗЕЙ ---
function getFriendGradient(index, total) {
    if (total === 0) return '#00FF00';
    const startR = 0, startG = 255, startB = 0;
    const endR = 128, endG = 0, endB = 255;
    const ratio = total > 1 ? index / (total - 1) : 0;
    const r = Math.round(startR + (endR - startR) * ratio);
    const g = Math.round(startG + (endG - startG) * ratio);
    const b = Math.round(startB + (endB - startB) * ratio);
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

// --- ГЕНЕРАЦИЯ ИЗОБРАЖЕНИЯ ---
async function generateTabImage() {
    const players = getPlayers();
    if (players.length === 0) return null;
    
    players.sort((a, b) => {
        if (a.isEnemy && !b.isEnemy) return -1;
        if (!a.isEnemy && b.isEnemy) return 1;
        if (a.isFriend && !b.isFriend) return -1;
        if (!a.isFriend && b.isFriend) return 1;
        return 0;
    });
    
    const width = 1920;
    const height = 1080;
    
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    
    // --- ФОН ---
    let background = null;
    const bgPath = path.join(__dirname, 'images', 'bg.png');
    
    try {
        if (fs.existsSync(bgPath)) {
            background = await loadImage(bgPath);
            console.log('✅ Ваш фон загружен!');
        } else {
            console.log('⚠️ Ваш фон не найден, использую градиент');
        }
    } catch (err) {
        console.log('⚠️ Ошибка загрузки фона:', err.message);
    }
    
    if (background) {
        ctx.drawImage(background, 0, 0, width, height);
    } else {
        const gradient = ctx.createLinearGradient(0, 0, width, height);
        gradient.addColorStop(0, '#0a0a1a');
        gradient.addColorStop(0.5, '#1a1a2e');
        gradient.addColorStop(1, '#0a0a1a');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, width, height);
    }
    
    ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
    ctx.fillRect(0, 0, width, height);
    
    // --- ЗАГОЛОВОК ---
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
    ctx.shadowBlur = 20;
    ctx.font = 'bold 60px "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.fillText('⚔️ UNITY', width / 2, 90);
    ctx.font = '28px "Courier New", monospace';
    ctx.fillStyle = '#88aacc';
    ctx.fillText(`Всего: ${players.length} игроков`, width / 2, 140);
    ctx.shadowBlur = 0;
    
    // --- КОЛОНКИ ---
    const cols = 3;
    const colWidth = (width - 120) / cols;
    const startX = 60;
    const startY = 180;
    const headerHeight = 40;
    const rowHeight = 34;
    const padding = 8;
    
    let fontSize = 20;
    const maxRows = Math.ceil(players.length / cols);
    if (maxRows > 20) fontSize = 18;
    if (maxRows > 25) fontSize = 16;
    if (maxRows > 30) fontSize = 14;
    if (maxRows > 35) fontSize = 13;
    
    for (let col = 0; col < cols; col++) {
        const x = startX + col * colWidth;
        const y = startY;
        
        const startIdx = col * maxRows;
        const endIdx = Math.min(startIdx + maxRows, players.length);
        const colPlayers = players.slice(startIdx, endIdx);
        
        const totalHeight = headerHeight + colPlayers.length * rowHeight + padding * 2;
        
        ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
        ctx.shadowColor = 'rgba(0, 0, 0, 0.3)';
        ctx.shadowBlur = 15;
        ctx.beginPath();
        ctx.roundRect(x, y, colWidth - 6, totalHeight, 8);
        ctx.fill();
        ctx.shadowBlur = 0;
        
        let headerText = '👤 Игроки';
        const hasEnemies = players.some(p => p.isEnemy);
        const hasFriends = players.some(p => p.isFriend);
        
        if (col === 0) {
            if (hasEnemies) headerText = '👿 ВРАГИ';
            else if (hasFriends) headerText = '🤝 ДРУЗЬЯ';
        } else if (col === 1) {
            if (hasEnemies && hasFriends) headerText = '👤 Игроки';
            else if (hasEnemies && !hasFriends) headerText = '👿 ВРАГИ';
            else if (hasFriends && !hasEnemies) headerText = '🤝 ДРУЗЬЯ';
        } else if (col === 2) {
            if (hasEnemies && hasFriends) headerText = '👤 Игроки';
            else if (hasEnemies && !hasFriends) headerText = '👤 Игроки';
            else if (hasFriends && !hasEnemies) headerText = '👤 Игроки';
        }
        
        ctx.fillStyle = '#ffffff';
        ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
        ctx.shadowBlur = 8;
        ctx.font = `bold ${fontSize + 2}px "Courier New", monospace`;
        ctx.textAlign = 'center';
        ctx.fillText(headerText, x + (colWidth - 6) / 2, y + 30);
        ctx.shadowBlur = 0;
        
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x + 10, y + 38);
        ctx.lineTo(x + colWidth - 16, y + 38);
        ctx.stroke();
        
        let yPos = y + headerHeight + padding;
        colPlayers.forEach((player) => {
            let color;
            if (player.isFriend) color = '#66ff88';
            else if (player.isEnemy) color = '#ff6b6b';
            else color = '#c8d6e5';
            
            ctx.fillStyle = color;
            ctx.font = `${fontSize}px "Courier New", monospace`;
            ctx.textAlign = 'left';
            ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
            ctx.shadowBlur = 6;
            
            let nameToDisplay = player.name;
            let testWidth = ctx.measureText(nameToDisplay).width;
            const maxNameWidth = colWidth - 60;
            
            if (testWidth > maxNameWidth) {
                let tempFontSize = fontSize;
                while (testWidth > maxNameWidth && tempFontSize > 8) {
                    tempFontSize--;
                    ctx.font = `${tempFontSize}px "Courier New", monospace`;
                    testWidth = ctx.measureText(nameToDisplay).width;
                }
                ctx.font = `${tempFontSize}px "Courier New", monospace`;
            }
            
            let statusIcon = '';
            if (player.isFriend) statusIcon = '🤝';
            else if (player.isEnemy) statusIcon = '👿';
            
            ctx.fillText(`${statusIcon} ${nameToDisplay}`, x + 10, yPos + 8);
            ctx.shadowBlur = 0;
            
            yPos += rowHeight;
        });
    }
    
    ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.font = '18px "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`Обновлено: ${new Date().toLocaleString()}`, width / 2, height - 25);
    
    return canvas.toBuffer();
}

// --- ПОДКЛЮЧЕНИЕ К MINECRAFT ---
function connectMinecraft() {
    if (isConnected) {
        console.log('⚠️ Бот уже подключен');
        return;
    }

    console.log(`🔄 Подключение к ${MINECRAFT_HOST}:${MINECRAFT_PORT} как ${MINECRAFT_USERNAME}`);

    bot = mineflayer.createBot({
        host: MINECRAFT_HOST,
        port: MINECRAFT_PORT,
        username: MINECRAFT_USERNAME,
        version: MINECRAFT_VERSION,
        auth: 'offline'
    });

    bot.on('playerJoined', (player) => {
        if (player.username === bot.username) return;
        if (!onlinePlayers.includes(player.username)) {
            onlinePlayers.push(player.username);
            console.log(`👤 Игрок зашёл: ${player.username} (${onlinePlayers.length} игроков онлайн)`);
        }
    });

    bot.on('playerLeft', (player) => {
        const index = onlinePlayers.indexOf(player.username);
        if (index !== -1) {
            onlinePlayers.splice(index, 1);
            console.log(`👤 Игрок вышел: ${player.username} (${onlinePlayers.length} игроков онлайн)`);
        }
    });

    setInterval(() => {
        if (!bot || !isConnected) return;
        const currentPlayers = Object.keys(bot.players).filter(name => name !== bot.username);
        for (const name of currentPlayers) {
            if (!onlinePlayers.includes(name)) {
                onlinePlayers.push(name);
                console.log(`🔄 Добавлен игрок: ${name}`);
            }
        }
        for (let i = onlinePlayers.length - 1; i >= 0; i--) {
            if (!currentPlayers.includes(onlinePlayers[i])) {
                console.log(`🔄 Игрок вышел: ${onlinePlayers[i]}`);
                onlinePlayers.splice(i, 1);
            }
        }
    }, 5000);

    if (SERVER_PASSWORD) {
        bot.on('message', (message) => {
            const msg = message.toString().toLowerCase();
            if (msg.includes('/register') || msg.includes('/login') || msg.includes('зарегистрируйтесь')) {
                console.log('🔐 Отправка пароля...');
                sendCommandWithDelay(`/login ${SERVER_PASSWORD}`);
                isAuthorized = true;
            }
        });
    }

    bot.on('spawn', () => {
        console.log(`✅ Бот появился в мире!`);
        sendDiscordMessage(`✅ **${MINECRAFT_USERNAME}** появился на сервере!`);
        
        setTimeout(() => {
            const players = Object.keys(bot.players);
            onlinePlayers = players.filter(name => name !== bot.username);
            console.log(`👥 Начальный список игроков: ${onlinePlayers.length} игроков`);
        }, 3000);
        
        if (!hasJoinedMode) {
            setTimeout(() => {
                console.log(`🚀 Переход на режим kitpvp2...`);
                sendCommandWithDelay(`/kitpvp2`);
                hasJoinedMode = true;
                
                setTimeout(() => {
                    const players = Object.keys(bot.players);
                    console.log(`👥 Бот видит ${players.length} игроков`);
                    if (players.length > 1) {
                        sendDiscordMessage(`✅ Бот на режиме **kitpvp2**!`);
                    } else {
                        sendDiscordMessage(`⚠️ Не удалось зайти на режим. Используйте \`!join kitpvp2\``);
                    }
                }, 5000);
            }, 5000);
        }
    });

    bot.on('message', (message) => {
        const msgText = message.toString();
        console.log(`📩 ${msgText}`);
    });

    bot.on('death', () => {
        sendDiscordMessage(`💀 **${MINECRAFT_USERNAME}** погиб!`);
        setTimeout(() => {
            if (bot) sendCommandWithDelay('/spawn');
        }, 2000);
    });

    bot.on('login', () => {
        isConnected = true;
        console.log(`✅ Бот зашёл на сервер как ${MINECRAFT_USERNAME}`);
        sendDiscordMessage(`✅ **${MINECRAFT_USERNAME}** зашёл на сервер!`);
        reconnectAttempts = 0;
    });

    bot.on('error', (err) => {
        console.error('❌ Ошибка:', err);
    });

    bot.on('end', (reason) => {
        isConnected = false;
        console.log(`❌ Отключён: ${reason}`);
        if (reason !== 'Отключение по команде Discord') {
            sendDiscordMessage(`❌ Бот отключился. Причина: \`${reason}\``);
            if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                reconnectAttempts++;
                setTimeout(() => {
                    if (!isConnected) connectMinecraft();
                }, 5000 * reconnectAttempts);
            }
        }
        bot = null;
    });

    bot.on('kicked', (reason) => {
        isConnected = false;
        console.log(`🚫 Кикнут: ${reason}`);
        sendDiscordMessage(`🚫 Бота кикнули! Причина: \`${reason}\``);
        bot = null;
        setTimeout(() => {
            if (!isConnected) connectMinecraft();
        }, 10000);
    });
}

function disconnectMinecraft() {
    if (!isConnected || !bot) return;
    bot.end('Отключение по команде Discord');
    isConnected = false;
    bot = null;
    onlinePlayers = [];
    sendDiscordMessage('❌ Бот отключён');
}

// --- ОБРАБОТЧИКИ DISCORD ---
client.on('ready', () => {
    console.log(`✅ Discord бот ${client.user.tag} запущен!`);
    console.log(`📡 Сервер: ${MINECRAFT_HOST}`);
    console.log(`🤖 Имя: ${MINECRAFT_USERNAME}`);
    console.log(`📋 Используйте !help`);
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (!message.content.startsWith('!')) return;

    const args = message.content.slice(1).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    // --- !connect ---
    if (command === 'connect') {
        if (!DISCORD_CHANNEL_ID) {
            await message.reply('⚠️ Не указан ID канала в .env');
            return;
        }
        hasJoinedMode = false;
        connectMinecraft();
        await message.reply('🔄 Подключаюсь...');
    }

    // --- !disconnect ---
    else if (command === 'disconnect') {
        disconnectMinecraft();
        await message.reply('❌ Отключаюсь');
    }

    // --- !join ---
    else if (command === 'join') {
        if (!isConnected || !bot) {
            await message.reply('❌ Бот не подключен!');
            return;
        }
        const mode = args[0] || 'kitpvp2';
        sendCommandWithDelay(`/${mode}`);
        hasJoinedMode = true;
        await message.reply(`🚀 Перехожу на **${mode}**...`);
    }

    // --- !status ---
    else if (command === 'status') {
        const embed = new EmbedBuilder()
            .setColor(isConnected ? 0x00FF00 : 0xFF0000)
            .setTitle('📊 Статус')
            .addFields(
                { name: 'Статус', value: isConnected ? '✅ Подключен' : '❌ Отключен', inline: true },
                { name: 'Имя', value: MINECRAFT_USERNAME, inline: true },
                { name: 'Сервер', value: MINECRAFT_HOST, inline: true },
                { name: '❤️ Здоровье', value: isConnected ? `${bot?.health || 0}/20` : '—', inline: true },
                { name: '👥 Онлайн', value: onlinePlayers.length > 0 ? `${onlinePlayers.length} игроков` : '0 игроков', inline: true },
                { name: '🤝 Друзья', value: friendList.length > 0 ? friendList.join(', ') : 'Никого', inline: false },
                { name: '👿 Враги', value: enemyList.length > 0 ? enemyList.join(', ') : 'Никого', inline: false }
            )
            .setTimestamp();
        await message.reply({ embeds: [embed] });
    }

    // --- !say ---
    else if (command === 'say') {
        if (!isConnected || !bot) {
            await message.reply('❌ Бот не подключен!');
            return;
        }
        const text = args.join(' ');
        if (!text) {
            await message.reply('⚠️ Укажите текст: `!say Привет`');
            return;
        }
        sendCommandWithDelay(text);
        await message.reply(`💬 Отправлено: "${text}"`);
    }

    // --- !friend add ---
    else if (command === 'friend' && args[0] === 'add') {
        if (!isConnected || !bot) {
            await message.reply('❌ Бот не подключен!');
            return;
        }
        const name = args.slice(1).join(' ');
        if (!name) {
            await message.reply('⚠️ Укажите ник: `!friend add Steve`');
            return;
        }
        
        const playerExists = onlinePlayers.some(n => 
            n.toLowerCase() === name.toLowerCase()
        );
        
        if (!playerExists) {
            await message.reply(`⚠️ Игрок **${name}** не найден на сервере.`);
            return;
        }
        
        if (addToList(friendList, name)) {
            removeFromList(enemyList, name);
            await message.reply(`🤝 **${name}** добавлен в друзья!`);
        } else {
            await message.reply(`⚠️ **${name}** уже в друзьях.`);
        }
    }

    // --- !friend remove ---
    else if (command === 'friend' && args[0] === 'remove') {
        const name = args.slice(1).join(' ');
        if (!name) {
            await message.reply('⚠️ Укажите ник: `!friend remove Steve`');
            return;
        }
        if (removeFromList(friendList, name)) {
            await message.reply(`❌ **${name}** удалён из друзей.`);
        } else {
            await message.reply(`⚠️ **${name}** не в списке друзей.`);
        }
    }

    // --- !friend list ---
    else if (command === 'friend' && args[0] === 'list') {
        if (friendList.length === 0) {
            await message.reply('📭 Список друзей пуст.');
            return;
        }
        let list = '🤝 **Друзья:**\n';
        friendList.forEach((n, i) => {
            list += `${i+1}. **${n}**\n`;
        });
        await message.reply(list);
    }

    // --- !friend clear ---
    else if (command === 'friend' && args[0] === 'clear') {
        friendList = [];
        saveData();
        await message.reply('🗑️ Список друзей очищен.');
    }

    // --- !enemy add ---
    else if (command === 'enemy' && args[0] === 'add') {
        if (!isConnected || !bot) {
            await message.reply('❌ Бот не подключен!');
            return;
        }
        const name = args.slice(1).join(' ');
        if (!name) {
            await message.reply('⚠️ Укажите ник: `!enemy add Steve`');
            return;
        }
        
        const playerExists = onlinePlayers.some(n => 
            n.toLowerCase() === name.toLowerCase()
        );
        
        if (!playerExists) {
            await message.reply(`⚠️ Игрок **${name}** не найден на сервере.`);
            return;
        }
        
        if (addToList(enemyList, name)) {
            removeFromList(friendList, name);
            await message.reply(`👿 **${name}** добавлен во враги!`);
        } else {
            await message.reply(`⚠️ **${name}** уже во врагах.`);
        }
    }

    // --- !enemy remove ---
    else if (command === 'enemy' && args[0] === 'remove') {
        const name = args.slice(1).join(' ');
        if (!name) {
            await message.reply('⚠️ Укажите ник: `!enemy remove Steve`');
            return;
        }
        if (removeFromList(enemyList, name)) {
            await message.reply(`❌ **${name}** удалён из врагов.`);
        } else {
            await message.reply(`⚠️ **${name}** не в списке врагов.`);
        }
    }

    // --- !enemy list ---
    else if (command === 'enemy' && args[0] === 'list') {
        if (enemyList.length === 0) {
            await message.reply('📭 Список врагов пуст.');
            return;
        }
        let list = '👿 **Враги:**\n';
        enemyList.forEach((n, i) => {
            list += `${i+1}. **${n}**\n`;
        });
        await message.reply(list);
    }

    // --- !enemy clear ---
    else if (command === 'enemy' && args[0] === 'clear') {
        enemyList = [];
        saveData();
        await message.reply('🗑️ Список врагов очищен.');
    }

    // --- !tab ---
    else if (command === 'tab' && !args[0]) {
        if (!isConnected || !bot) {
            await message.reply('❌ Бот не подключен!');
            return;
        }
        
        try {
            const imageBuffer = await generateTabImage();
            if (!imageBuffer) {
                await message.reply('📋 На сервере никого нет.');
                return;
            }
            
            const channel = client.channels.cache.get(DISCORD_CHANNEL_ID);
            if (channel) {
                await channel.send({
                    files: [{
                        attachment: imageBuffer,
                        name: 'tab.png'
                    }]
                });
            }
        } catch (err) {
            console.error('❌ Ошибка генерации изображения:', err);
            await message.reply('❌ Ошибка при создании таблицы.');
        }
    }

    // --- !help ---
    else if (command === 'help') {
        const embed = new EmbedBuilder()
            .setColor(0x0099FF)
            .setTitle('📋 Команды')
            .addFields(
                { name: '🎮 Управление', value: '`!connect` - Подключиться\n`!disconnect` - Отключиться\n`!join <режим>` - Зайти на режим\n`!status` - Статус\n`!say <текст>` - Отправить сообщение', inline: false },
                { name: '🤝 Друзья', value: '`!friend add <ник>`\n`!friend remove <ник>`\n`!friend list`\n`!friend clear`', inline: true },
                { name: '👿 Враги', value: '`!enemy add <ник>`\n`!enemy remove <ник>`\n`!enemy list`\n`!enemy clear`', inline: true },
                { name: '📋 TAB', value: '`!tab` - Таблица игроков (изображение)', inline: false }
            )
            .setTimestamp();
        await message.reply({ embeds: [embed] });
    }
});

// --- ПИНГ ДЛЯ RENDER ---
setInterval(() => {
    if (bot && isConnected) {
        console.log('💓 Пинг для Render (бот жив)');
    }
}, 30000);

// --- ЗАПУСК ---
client.login(DISCORD_TOKEN).catch(err => {
    console.error('❌ Ошибка входа Discord:', err);
});

process.on('SIGINT', () => {
    console.log('\n🛑 Завершение...');
    saveData();
    if (bot) bot.end('Завершение');
    client.destroy();
    process.exit(0);
});

console.log('🚀 Бот запускается...');
console.log('📋 Напишите !help в Discord');
