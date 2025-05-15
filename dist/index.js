import fs from 'fs';
import { io } from 'socket.io-client'; // WebSocket клиент
import fetch from 'node-fetch';
import { exec, execSync } from 'child_process';
import macaddress from 'node-macaddress';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import path from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Настройка логирования для агента
const logFile = path.join(__dirname, '../../log/agent.log');
const logStream = fs.createWriteStream(logFile, { flags: 'a' });
function log(message) {
    const timestamp = new Date().toISOString();
    logStream.write(`[${timestamp}] ${message}\n`);
}
// Пример использования логирования
log('Агент запущен');
// Абсолютный путь до конфигурационного файла
const configPath = path.resolve(__dirname, '../config/agent.config.json');
// Загрузка и парсинг конфигурации агента
let config;
try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    config = JSON.parse(raw);
    console.log('[Agent] Конфигурация успешно загружена:');
    console.log('Имя ПК:', config.pcName);
    console.log('Путь к играм:', config.gamesDirectory);
}
catch (err) {
    console.error('[Agent] Ошибка загрузки конфигурации:', err);
    process.exit(1);
}
// Обновляем функцию для получения списка игр из папок
function getAvailableGames(directories) {
    const games = [];
    directories.forEach((directory) => {
        try {
            const folders = fs.readdirSync(directory, { withFileTypes: true })
                .filter(dirent => dirent.isDirectory() && dirent.name !== 'SteamVR' && dirent.name !== 'Steamworks Shared')
                .map(dirent => dirent.name);
            console.log(`[Agent] Найдено ${folders.length} игр в директории ${directory}`);
            games.push(...folders);
        }
        catch (err) {
            console.error(`[Agent] Ошибка чтения директории ${directory}:`, err);
        }
    });
    return games;
}
const CURRENT_VERSION = '1.0.0';
async function checkForUpdates() {
    try {
        const response = await fetch(`${config.serverUrl}/api/agent/version`);
        // Проверяем, что ответ является JSON
        const contentType = response.headers.get('content-type');
        if (!contentType || !contentType.includes('application/json')) {
            throw new Error('Ответ сервера не является JSON');
        }
        const { version, updateUrl } = (await response.json());
        if (version !== CURRENT_VERSION) {
            console.log(`[Agent] Доступно обновление: ${version}`);
            await downloadAndUpdate(updateUrl);
        }
        else {
            console.log('[Agent] Клиент актуален.');
        }
    }
    catch (error) {
        console.error('[Agent] Ошибка проверки обновлений:', error);
    }
}
async function downloadAndUpdate(url) {
    const updatePath = './agent_update.zip';
    try {
        const response = await fetch(url);
        if (!response.body) {
            console.error('[Agent] Ошибка: тело ответа отсутствует.');
            return;
        }
        const fileStream = fs.createWriteStream(updatePath);
        response.body.pipe(fileStream);
        fileStream.on('finish', () => {
            console.log('[Agent] Обновление загружено. Распаковка...');
            if (!fs.existsSync(updatePath)) {
                console.error('[Agent] Ошибка: файл обновления не найден.');
                return;
            }
            exec(`unzip -o ${updatePath} -d ./`, (err) => {
                if (err) {
                    console.error('[Agent] Ошибка распаковки обновления:', err);
                    return;
                }
                console.log('[Agent] Обновление завершено. Перезапуск...');
                process.exit(0); // Завершаем процесс для перезапуска
            });
        });
    }
    catch (error) {
        console.error('[Agent] Ошибка загрузки обновления:', error);
    }
}
function backupAndMergeConfig(newConfigPath, currentConfigPath) {
    const backupPath = currentConfigPath.replace('agent.config.json', 'agent.config.backup.json');
    // Создаём резервную копию текущего файла
    fs.copyFileSync(currentConfigPath, backupPath);
    console.log(`[Agent] Резервная копия конфигурации создана: ${backupPath}`);
    // Читаем текущую и новую конфигурации
    const currentConfig = JSON.parse(fs.readFileSync(currentConfigPath, 'utf-8'));
    const newConfig = JSON.parse(fs.readFileSync(newConfigPath, 'utf-8'));
    // Объединяем конфигурации
    const mergedConfig = { ...newConfig, ...currentConfig };
    // Добавляем комментарии для новых полей
    for (const key in newConfig) {
        if (!(key in currentConfig)) {
            console.log(`[Agent] Новое поле в конфигурации: ${key} (добавлено с заглушкой)`);
            mergedConfig[key] = `Значение для ${key} (заглушка)`; // Заглушка с пояснением
        }
    }
    // Сохраняем объединённую конфигурацию
    fs.writeFileSync(currentConfigPath, JSON.stringify(mergedConfig, null, 2), 'utf-8');
    console.log(`[Agent] Конфигурация обновлена: ${currentConfigPath}`);
}
async function updateAgent() {
    const updateUrl = `${config.serverUrl}/updates/agent.zip`;
    const updatePath = './agent_update.zip';
    console.log('[Agent] Загрузка обновления...');
    const response = await fetch(updateUrl);
    if (!response.body) {
        console.error('[Agent] Ошибка: тело ответа отсутствует.');
        return;
    }
    const fileStream = fs.createWriteStream(updatePath);
    response.body.pipe(fileStream);
    fileStream.on('finish', () => {
        console.log('[Agent] Распаковка обновления...');
        execSync(`unzip -o ${updatePath} -d ./`);
        // Обновляем конфигурацию
        backupAndMergeConfig('./agent.config.json', configPath);
        console.log('[Agent] Обновление завершено. Перезапуск...');
        process.exit(0);
    });
}
async function updateConfigFromServer() {
    try {
        const mac = await macaddress.one();
        const response = await fetch(`${config.serverUrl}/api/agents/config-by-mac`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mac })
        });
        if (response.ok) {
            const newConfig = await response.json();
            const configPath = path.resolve(__dirname, '../config/agent.config.json');
            fs.writeFileSync(configPath, JSON.stringify(newConfig, null, 2), 'utf-8');
            log(`[Agent] Конфиг обновлён с сервера для MAC: ${mac}`);
        }
        else {
            log(`[Agent] Конфиг для MAC ${mac} не найден на сервере`);
        }
    }
    catch (err) {
        log(`[Agent] Ошибка при обновлении конфига с сервера: ${err}`);
    }
}
// Вызов обновления конфига при старте агента
updateConfigFromServer();
// Вызов проверки обновлений при старте
checkForUpdates();
// === Подключение к серверу WebSocket ===
const socket = io(config.serverUrl, {
    transports: ['websocket'],
    reconnectionAttempts: 5
});
socket.on('connect', () => {
    console.log('[Agent] Подключён к серверу:', socket.id);
    // Отправка первичного статуса
    socket.emit('status', {
        pcName: config.pcName,
        status: 'idle',
        timestamp: new Date().toISOString()
    });
    setInterval(() => {
        socket.emit('status', {
            pcName: config.pcName,
            status: 'idle', // позже может быть "running"
            timestamp: new Date().toISOString()
        });
    }, config.heartbeatIntervalMs || 5000);
});
socket.on('disconnect', () => {
    console.log('[Agent] Отключён от сервера');
});
// Обработчик для получения списка игр
socket.on('get_games', () => {
    const games = getAvailableGames(config.gamesDirectories);
    socket.emit('games_list', games);
});
// Вызов обновления агента
updateAgent();
