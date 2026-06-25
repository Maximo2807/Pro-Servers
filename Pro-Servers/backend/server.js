const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const Docker = require('dockerode');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const docker = new Docker(); 

app.use(cors());
app.use(express.json());

const dbPath = path.join(__dirname, 'database.json');
function loadDB() {
    if (!fs.existsSync(dbPath)) fs.writeFileSync(dbPath, JSON.stringify({ users: {} }));
    return JSON.parse(fs.readFileSync(dbPath));
}
function saveDB(data) {
    fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));
}

function pullImageAsync(imageName) {
    return new Promise((resolve) => {
        docker.pull(imageName, (err, stream) => {
            if (err) {
                console.log(`[AVISO] Omitiendo descarga de ${imageName} (Se usará caché local)`);
                return resolve(false);
            }
            docker.modem.followProgress(stream, () => resolve(true));
        });
    });
}

// ==========================================
// RUTAS DE CREACIÓN Y BORRADO
// ==========================================
app.get('/api/project/check', (req, res) => {
    const db = loadDB();
    const userServers = db.users[req.query.uid] || [];
    res.json({ exists: userServers.length > 0, servers: userServers });
});

app.post('/api/project/create', async (req, res) => {
    const { uid, edition, projectName, motd, software, version } = req.body;
    const db = loadDB();
    if (!db.users[uid]) db.users[uid] = [];

    const serverId = Date.now().toString();
    const newServer = { id: serverId, edition, projectName, motd, software, version, publicIp: null };
    
    db.users[uid].push(newServer);
    saveDB(db);

    const mcContainerName = `mc-${serverId}`;
    const playitContainerName = `playit-${serverId}`;
    
    const serverPath = path.join(__dirname, 'servers', serverId);
    if (!fs.existsSync(serverPath)) fs.mkdirSync(serverPath, { recursive: true });
    const safeServerPath = serverPath.replace(/\\/g, '/'); 

    let mcImage = 'itzg/minecraft-server:java25-jdk'; // Default Java
    const envVars = ['EULA=TRUE', `MOTD=${motd}`, 'MEMORY=8G', 'ENABLE_RCON=TRUE'];

    // LÓGICA INTELIGENTE DE MOTORES
    if (edition === 'bedrock') {
        if (software === 'pocketmine') {
            mcImage = 'pmmp/pocketmine-mp:latest'; // Imagen oficial de PocketMine
        } else {
            mcImage = 'itzg/minecraft-bedrock-server';
            envVars.push(software === 'preview' ? 'VERSION=PREVIEW' : 'VERSION=LATEST');
        }
    } else {
        // Modo Java
        envVars.push(`VERSION=${version}`);
        envVars.push(`TYPE=${software === 'snapshot' ? 'VANILLA' : software.toUpperCase()}`);
    }

    res.json({ success: true, message: "Desplegando infraestructura...", server: newServer });

    setImmediate(async () => {
        try {
            console.log(`[SISTEMA] Verificando imágenes oficiales...`);
            await pullImageAsync(mcImage);
            await pullImageAsync('pepaondrugs/playitgg-docker:latest');

            console.log(`[SISTEMA] Creando servidor de juego (${mcContainerName})...`);
            const mcContainer = await docker.createContainer({
                Image: mcImage,
                name: mcContainerName,
                Env: envVars,
                HostConfig: {
                    Memory: 8589934592, 
                    Binds: [`${safeServerPath}:/data`]
                }
            });
            await mcContainer.start();

            console.log(`[SISTEMA] Creando túnel de red (${playitContainerName})...`);
            const playitContainer = await docker.createContainer({
                Image: 'pepaondrugs/playitgg-docker:latest',
                name: playitContainerName,
                HostConfig: { NetworkMode: `container:${mcContainerName}` }
            });
            await playitContainer.start();
            console.log(`[EXITO] Nodo ${serverId} operativo.`);

        } catch (err) {
            console.error(`[ERROR DESPLIEGUE]`, err);
        }
    });
});

app.post('/api/project/delete', async (req, res) => {
    const { uid, serverId } = req.body;
    const db = loadDB();
    if (db.users[uid]) {
        db.users[uid] = db.users[uid].filter(s => s.id !== serverId);
        saveDB(db);
    }
    try {
        const mc = docker.getContainer(`mc-${serverId}`);
        await mc.stop().catch(() => {});
        await mc.remove({ force: true, v: true }).catch(() => {});
        const playit = docker.getContainer(`playit-${serverId}`);
        await playit.stop().catch(() => {});
        await playit.remove({ force: true, v: true }).catch(() => {});
    } catch (e) {}
    res.json({ success: true });
});

app.post('/api/project/ip', (req, res) => {
    const { uid, serverId, ip } = req.body;
    const db = loadDB();
    const server = db.users[uid]?.find(s => s.id === serverId);
    if (server) { server.publicIp = ip; saveDB(db); }
    res.json({ success: true });
});

// ==========================================
// GESTIÓN DE ENERGÍA Y CONTENEDORES
// ==========================================
app.get('/api/server/status', async (req, res) => {
    try {
        const container = docker.getContainer(`mc-${req.query.serverId}`);
        const data = await container.inspect();
        res.json({ status: data.State.Running ? 'on' : 'off' });
    } catch (e) { res.json({ status: 'off' }); }
});

app.post('/api/server/start', async (req, res) => {
    try { 
        const mc = docker.getContainer(`mc-${req.body.serverId}`);
        const mcData = await mc.inspect();
        if (!mcData.State.Running) await mc.start();

        const playit = docker.getContainer(`playit-${req.body.serverId}`);
        const playitData = await playit.inspect();
        if (!playitData.State.Running) await playit.start();
        res.json({ success: true }); 
    } catch(e) { res.json({ error: e.message }); }
});

app.post('/api/server/stop', async (req, res) => {
    try { 
        const mc = docker.getContainer(`mc-${req.body.serverId}`);
        const mcData = await mc.inspect();
        if (mcData.State.Running) await mc.stop();

        const playit = docker.getContainer(`playit-${req.body.serverId}`);
        const playitData = await playit.inspect();
        if (playitData.State.Running) await playit.stop();
        res.json({ success: true }); 
    } catch(e) { res.json({ error: e.message }); }
});

app.post('/api/server/restart', async (req, res) => {
    try { 
        await docker.getContainer(`mc-${req.body.serverId}`).restart(); 
        await docker.getContainer(`playit-${req.body.serverId}`).restart().catch(() => {});
        res.json({ success: true }); 
    } catch(e) { res.json({ error: e.message }); }
});

// ==========================================
// ESTADÍSTICAS Y JUGADORES
// ==========================================
app.get('/api/server/stats', async (req, res) => {
    try {
        const container = docker.getContainer(`mc-${req.query.serverId}`);
        const stats = await container.stats({ stream: false });
        const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
        const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
        let cpu = 0;
        if (systemDelta > 0 && cpuDelta > 0) cpu = ((cpuDelta / systemDelta) * stats.cpu_stats.online_cpus * 100).toFixed(1);
        const ram = (stats.memory_stats.usage / (1024 * 1024)).toFixed(2);
        res.json({ cpu: `${cpu}%`, ram });
    } catch (e) { res.json({ cpu: '0%', ram: '0' }); }
});

app.post('/api/server/command', async (req, res) => {
    const { serverId, command } = req.body;
    try {
        const container = docker.getContainer(`mc-${serverId}`);
        const exec = await container.exec({ Cmd: ['rcon-cli', command], AttachStdout: true, AttachStderr: true });
        exec.start((err, stream) => res.json({ success: true }));
    } catch (e) { res.status(500).json({ error: "Error de comando" }); }
});

app.get('/api/server/players', async (req, res) => {
    try {
        const container = docker.getContainer(`mc-${req.query.serverId}`);
        const exec = await container.exec({ Cmd: ['rcon-cli', 'list'], AttachStdout: true });
        exec.start((err, stream) => {
            if (err) return res.json({ players: [] });
            let output = '';
            stream.on('data', chunk => output += chunk.toString());
            stream.on('end', () => {
                const cleanOutput = output.replace(/\u001b\[[0-9;]*m/g, '');
                const players = [];
                const parts = cleanOutput.split(':');
                if (parts.length > 1 && parts[1].trim() !== '') {
                    const names = parts[1].split(',').map(n => n.trim());
                    names.forEach(n => { if(n) players.push({ name: n, avatar: `https://minotar.net/helm/${n}/100.png` }); });
                }
                res.json({ players });
            });
        });
    } catch (e) { res.json({ players: [] }); }
});

app.get('/api/server/playitlogs', async (req, res) => {
    try {
        const container = docker.getContainer(`playit-${req.query.serverId}`);
        const logs = await container.logs({ stdout: true, stderr: true, tail: 50 });
        res.json({ logs: logs.toString('utf8').replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, '') });
    } catch (e) { res.json({ logs: "Conectando..." }); }
});

io.on('connection', (socket) => {
    const { serverId } = socket.handshake.query;
    if (!serverId) return socket.disconnect();
    const container = docker.getContainer(`mc-${serverId}`);
    container.logs({ follow: true, stdout: true, stderr: true, tail: 50 }, (err, stream) => {
        if (!err && stream) stream.on('data', chunk => socket.emit('log', chunk.toString('utf8')));
    });
});

server.listen(3000, () => console.log('Backend Listo con Java 25 y Múltiples Motores'));