const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const Docker = require('dockerode');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const admin = require('firebase-admin');
const multer = require('multer');
const AdmZip = require('adm-zip');
const { execSync } = require('child_process');
const { pipeline } = require('stream/promises');
const mongoose = require('mongoose');
require('dotenv').config(); // Mongoose URI

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const docker = new Docker();

app.use(cors());

// ==========================================
// CONEXIÓN A MONGODB (AZURE)
// ==========================================
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('\x1b[34m[MongoDB] Conectado a Azure Cosmos DB exitosamente.\x1b[0m'))
    .catch(err => console.error('\x1b[31m[MongoDB ERROR]\x1b[0m', err));

const serverSchema = new mongoose.Schema({
    id: String,
    edition: String,
    projectName: String,
    motd: String,
    software: String,
    version: String,
    publicIp: String,
    sharedWith: [String]
});

const userSchema = new mongoose.Schema({
    uid: { type: String, required: true, unique: true },
    role: { type: String, default: 'admin' },
    plan: { type: String, default: 'redstone' },
    servers: [serverSchema]
});

const ipSchema = new mongoose.Schema({
    ip: { type: String, required: true, unique: true },
    uids: [String]
});

const User = mongoose.model('User', userSchema);
const IpInfo = mongoose.model('IpInfo', ipSchema);

// ==========================================
// DICCIONARIO DE PLANES Y PERMISOS (PAYWALL)
// ==========================================
const PLAN_LIMITS = {
    'redstone': { name: 'Plan Redstone', ram: '8G', ramBytes: 8589934592, slots: 10, maxServers: 1, fileManager: false },
    'hierro': { name: 'Plan Hierro', ram: '12G', ramBytes: 12884901888, slots: 20, maxServers: 2, fileManager: false },
    'oro': { name: 'Plan Oro', ram: '16G', ramBytes: 17179869184, slots: 40, maxServers: 3, fileManager: false },
    'diamante': { name: 'Plan Diamante', ram: '32G', ramBytes: 34359738368, slots: 100, maxServers: 6, fileManager: true },
    'netherite': { name: 'Plan Netherite', ram: '64G', ramBytes: 68719476736, slots: 250, maxServers: 12, fileManager: true },
    'ghost-warrior': { name: 'Ghost Warrior', ram: '128G', ramBytes: 137438953472, slots: -1, maxServers: -1, fileManager: true }, // -1 = ilimitado
    'enterprise': { name: 'Professional Enterprise', ram: '256G', ramBytes: 274877906944, slots: -1, maxServers: -1, fileManager: true }
};

// ==========================================
// CHIVATO DE CURSEFORGE
// ==========================================
console.log("=========================================");
if (process.env.CURSEFORGE_API_KEY) {
    console.log("\x1b[32m[INIT] CurseForge API Key: DETECTADA OK\x1b[0m");
} else {
    console.log("\x1b[31m[INIT] CurseForge API Key: NO ENCONTRADA (Verificá el docker-compose.yml)\x1b[0m");
}
console.log("=========================================");

app.use(express.json({ limit: '10000mb' }));
app.use(express.urlencoded({ extended: true, limit: '10000mb' }));

// ==========================================
// CONFIGURACIÓN DE FIREBASE ADMIN
// ==========================================
let serviceAccount;
try {
    serviceAccount = require('./firebase-adminsdk.json');
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    console.log("[SEGURIDAD] Firebase Admin inicializado correctamente.");
} catch (e) {
    console.warn("\x1b[31m[ALERTA CRÍTICA] No se encontró firebase-adminsdk.json.\x1b[0m");
}

const verifyToken = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Acceso denegado.' });
    }
    try {
        req.user = await admin.auth().verifyIdToken(authHeader.split(' ')[1]);
        next();
    } catch (error) {
        return res.status(403).json({ error: 'Token inválido o expirado.' });
    }
};

// ==========================================
// MIDDLEWARES DE ACCESO (MIGRADOS A MONGO)
// ==========================================
const requireAccess = async (req, res, next) => {
    const uid = req.user.uid;
    const email = req.user.email; 
    const serverId = req.body.serverId || req.query.serverId;
    
    if (!serverId) return res.status(400).json({ error: "Falta serverId." });
    
    try {
        const userWithServer = await User.findOne({ "servers.id": serverId });
        if (!userWithServer) return res.status(404).json({ error: "Servidor no encontrado." });
        
        const srv = userWithServer.servers.find(s => s.id === serverId);
        const isOwner = userWithServer.uid === uid;
        const isShared = srv.sharedWith && srv.sharedWith.includes(email);
        
        if (!isOwner && !isShared) {
            return res.status(403).json({ error: "Seguridad: No tienes acceso a este servidor (No eres el dueño ni estás invitado)." });
        }
        
        req.serverOwnerUid = userWithServer.uid; 
        next();
    } catch (e) {
        res.status(500).json({ error: "Error interno de validación." });
    }
};

const requireFeature = (feature) => {
    return async (req, res, next) => {
        try {
            const targetUid = req.serverOwnerUid || req.user.uid; 
            const user = await User.findOne({ uid: targetUid });
            const planKey = user ? user.plan : 'redstone';
            const pDetails = PLAN_LIMITS[planKey] || PLAN_LIMITS['redstone'];
            
            if (!pDetails[feature]) {
                return res.status(403).json({ error: `ACCESO BLOQUEADO: El plan del servidor (${pDetails.name}) no incluye la función avanzada: ${feature}.` });
            }
            next();
        } catch(e) {
            res.status(500).json({ error: "Error validando características." });
        }
    };
};

// ==========================================
// UTILIDADES
// ==========================================
function pullImageAsync(imageName) {
    return new Promise((resolve) => {
        docker.pull(imageName, (err, stream) => {
            if (err) return resolve(false);
            docker.modem.followProgress(stream, () => resolve(true));
        });
    });
}

function getSafePath(serverId, reqPath) {
    const baseDir = path.join(__dirname, 'servers', serverId);
    if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
    const cleanReqPath = (reqPath || '/').replace(/\.\./g, '').replace(/^\/+/, '');
    const targetPath = path.join(baseDir, cleanReqPath);
    if (!targetPath.startsWith(baseDir)) return null; 
    return targetPath;
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const serverId = req.body.serverId || req.query.serverId;
        cb(null, getSafePath(serverId, '/'));
    },
    filename: (req, file, cb) => cb(null, file.originalname)
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 * 1024 } });

function extractZipSafely(zipFilePath, targetFolder) {
    try {
        console.log("[SISTEMA] Extrayendo con unzip nativo de Linux...");
        execSync(`unzip -o "${zipFilePath}" -d "${targetFolder}"`, { stdio: 'ignore' });
        return true;
    } catch (e) {
        console.error("[ERROR EXTRAER NATIVO]:", e.message);
        try {
            console.log("[SISTEMA] Usando AdmZip como respaldo...");
            const zip = new AdmZip(zipFilePath);
            zip.extractAllTo(targetFolder, true);
            return true;
        } catch (fallbackError) {
            console.error("[ERROR ADM-ZIP]:", fallbackError.message);
            return false;
        }
    }
}

// ==========================================
// FIX MEDIAFIRE, GOOGLE DRIVE Y STREAMING 
// ==========================================
function extraerIdDeDrive(url) {
    const match = url.match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?id=)([a-zA-Z0-9_-]+)/);
    return match ? match[1] : null;
}

async function descargarDeGoogleDrive(fileId) {
    const baseUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
    const options = {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36' }
    };

    const c1 = new AbortController();
    const t1 = setTimeout(() => c1.abort(), 60000); 
    let response = await fetch(baseUrl, { ...options, signal: c1.signal });
    clearTimeout(t1);

    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('text/html')) {
        const html = await response.text();
        const cookies = response.headers.get('set-cookie') || '';
        
        let confirmToken = 't'; 
        const confirmMatch = html.match(/confirm=([0-9A-Za-z_-]+)/);
        const cookieMatch = cookies.match(/download_warning_([0-9A-Za-z_-]+)/);
        
        if (confirmMatch) confirmToken = confirmMatch[1];
        else if (cookieMatch) confirmToken = cookieMatch[1];

        const c2 = new AbortController();
        const t2 = setTimeout(() => c2.abort(), 180000);
        response = await fetch(`${baseUrl}&confirm=${confirmToken}`, {
            headers: { ...options.headers, 'Cookie': cookies },
            signal: c2.signal
        });
        clearTimeout(t2);
    }
    return response;
}

async function descargarDeMediafire(url) {
    const c1 = new AbortController();
    const t1 = setTimeout(() => c1.abort(), 30000);
    const response = await fetch(url, { signal: c1.signal });
    clearTimeout(t1);

    const html = await response.text();
    const match = html.match(/href="([^"]+)"\s+id="downloadButton"/i);
    
    if (!match || !match[1]) throw new Error('No se pudo encontrar el link directo de MediaFire. Verificá que el enlace sea correcto y público.');

    const directLink = match[1];
    const c2 = new AbortController();
    const t2 = setTimeout(() => c2.abort(), 180000);
    const finalResponse = await fetch(directLink, { signal: c2.signal });
    clearTimeout(t2);

    return finalResponse;
}

async function fetchDescarga(url) {
    if (url.includes('mediafire.com')) return descargarDeMediafire(url);
    const driveId = extraerIdDeDrive(url);
    if (driveId) return descargarDeGoogleDrive(driveId);

    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 60000);
    const response = await fetch(url, { signal: c.signal });
    clearTimeout(t);
    return response;
}

const deployProgress = {};

// ==========================================
// RUTAS CON MONGODB ASÍNCRONAS
// ==========================================
app.get('/api/user/status', verifyToken, async (req, res) => { 
    try {
        let user = await User.findOne({ uid: req.user.uid });
        if (!user) user = await User.create({ uid: req.user.uid }); // Crea si no existe en BD
        
        const pDetails = PLAN_LIMITS[user.plan] || PLAN_LIMITS['redstone'];
        res.json({ 
            status: 'active', 
            plan: {
                id: user.plan,
                name: pDetails.name,
                ram: pDetails.ram,
                ramNum: parseInt(pDetails.ram.replace('G','')),
                maxServers: pDetails.maxServers === -1 ? 'ilimitado' : pDetails.maxServers,
                slots: pDetails.slots === -1 ? 'ilimitado' : pDetails.slots,
                fileManager: pDetails.fileManager
            }
        }); 
    } catch(e) { res.status(500).json({ error: "Error DB" }); }
});

app.get('/api/user/role', verifyToken, async (req, res) => {
    try {
        const user = await User.findOne({ uid: req.user.uid });
        res.json({ role: user ? user.role : 'user' });
    } catch(e) { res.status(500).json({ error: "Error DB" }); }
});

app.get('/api/project/check', verifyToken, async (req, res) => {
    try {
        const uid = req.user.uid;
        const email = req.user.email;
        
        const user = await User.findOne({ uid });
        const ownServers = user ? user.servers : [];
        
        // Busca servidores compartidos
        const usersWithShared = await User.find({ "servers.sharedWith": email });
        let sharedServers = [];
        
        usersWithShared.forEach(owner => {
            owner.servers.forEach(s => {
                if (s.sharedWith && s.sharedWith.includes(email)) {
                    sharedServers.push({...s.toObject(), isShared: true, ownerId: owner.uid});
                }
            });
        });
        
        const allAccessibleServers = [...ownServers, ...sharedServers];
        res.json({ exists: allAccessibleServers.length > 0, servers: allAccessibleServers });
    } catch(e) { res.status(500).json({ error: "Error DB" }); }
});

app.post('/api/project/share', verifyToken, requireAccess, async (req, res) => {
    if (req.user.uid !== req.serverOwnerUid) return res.status(403).json({error: "Solo el creador original puede invitar a otros."});
    const { emailToShare } = req.body;
    if (!emailToShare) return res.status(400).json({error: "Debes ingresar un email."});
    
    try {
        const user = await User.findOne({ uid: req.serverOwnerUid });
        const srv = user.servers.find(s => s.id === req.body.serverId);
        
        if (!srv.sharedWith.includes(emailToShare)) {
            srv.sharedWith.push(emailToShare);
            await user.save();
        }
        res.json({ success: true, sharedWith: srv.sharedWith, message: `Servidor compartido con ${emailToShare}` });
    } catch(e) { res.status(500).json({ error: "Error DB" }); }
});

app.post('/api/project/unshare', verifyToken, requireAccess, async (req, res) => {
    if (req.user.uid !== req.serverOwnerUid) return res.status(403).json({error: "Solo el dueño puede revocar accesos."});
    const { emailToUnshare } = req.body;
    
    try {
        const user = await User.findOne({ uid: req.serverOwnerUid });
        const srv = user.servers.find(s => s.id === req.body.serverId);
        
        srv.sharedWith = srv.sharedWith.filter(e => e !== emailToUnshare);
        await user.save();
        res.json({ success: true, sharedWith: srv.sharedWith });
    } catch(e) { res.status(500).json({ error: "Error DB" }); }
});

app.get('/api/project/deploy-status', verifyToken, (req, res) => {
    const status = deployProgress[req.query.serverId];
    if (!status) return res.json({ step: "Preparando base de datos...", pct: 0, done: false, error: null });
    res.json(status);
});

app.post('/api/project/create', verifyToken, async (req, res) => {
    req.setTimeout(300000); 

    const { email, edition, projectName, motd, software, version, modpackUrl, curseforgeModpackId, curseforgeFileId } = req.body;
    const uid = req.user.uid;
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    
    try {
        let user = await User.findOne({ uid });
        if (!user) user = new User({ uid, role: 'admin', plan: 'redstone', servers: [] });
        
        const pDetails = PLAN_LIMITS[user.plan] || PLAN_LIMITS['redstone'];

        // BLINDAJE ANTI-ABUSO EN MONGODB
        if (user.plan === 'redstone' && clientIp !== 'unknown') {
            let ipRecord = await IpInfo.findOne({ ip: clientIp });
            if (!ipRecord) ipRecord = new IpInfo({ ip: clientIp, uids: [] });

            if (ipRecord.uids.length > 0 && !ipRecord.uids.includes(uid)) {
                return res.status(403).json({ success: false, message: "Seguridad Anti-Fraude: Ya se ha reclamado una prueba gratuita desde tu red de Internet (IP). Mejora tu plan para continuar." });
            }
            if (!ipRecord.uids.includes(uid)) {
                ipRecord.uids.push(uid);
                await ipRecord.save();
            }
        }
        
        const isModpack = !!(modpackUrl || curseforgeModpackId);
        const esVersionBloqueada = (version.startsWith('26.') || version === 'LATEST');
        const esMotorDeMods = ['forge', 'fabric', 'quilt', 'neoforge', 'arclight'].includes(software);
        if (!isModpack && esVersionBloqueada && esMotorDeMods) {
            return res.status(403).json({ success: false, message: "Seguridad Backend: Esta versión no soporta mods." });
        }
        
        if (pDetails.maxServers !== -1 && user.servers.length >= pDetails.maxServers) {
            return res.status(403).json({ success: false, message: `Límite de servidores alcanzado. Tu ${pDetails.name} permite un máximo de ${pDetails.maxServers} servidor(es).` });
        }

        const serverId = Date.now().toString();
        const newServer = { id: serverId, edition, projectName, motd, software, version, publicIp: null, sharedWith: [] };

        user.servers.push(newServer);
        await user.save();

        const serverPath = path.join(__dirname, 'servers', serverId);
        if (!fs.existsSync(serverPath)) fs.mkdirSync(serverPath, { recursive: true });

        let mcImage = 'itzg/minecraft-server';
        let envVars = [
            'EULA=TRUE', `MOTD=${motd}`, `MEMORY=${pDetails.ram}`, 
            'ENABLE_RCON=TRUE', 'JAVA_TOOL_OPTIONS=-Dnetty.transport=epoll'
        ];

        if (pDetails.slots !== -1) envVars.push(`MAX_PLAYERS=${pDetails.slots}`);

        if (edition === 'bedrock') {
            if (software === 'pocketmine') mcImage = 'pmmp/pocketmine-mp:latest';
            else { mcImage = 'itzg/minecraft-bedrock-server'; envVars.push(software === 'preview' ? 'VERSION=PREVIEW' : 'VERSION=LATEST'); }
        } else {
            if (!isModpack) {
                envVars.push(`VERSION=${version}`);
                envVars.push(`TYPE=${software === 'snapshot' ? 'VANILLA' : software.toUpperCase()}`);
            }
        }

        deployProgress[serverId] = { step: "Iniciando conexión con el nodo...", pct: 5, done: false, error: null };
        res.json({ success: true, message: "Iniciando despliegue...", server: newServer });

        setImmediate(async () => {
            try {
                let finalModpackUrl = modpackUrl;

                if (curseforgeModpackId && curseforgeFileId) {
                    deployProgress[serverId] = { step: "Contactando CurseForge (Buscando enlace directo)...", pct: 15, done: false, error: null };
                    
                    const cfApiUrl = `https://api.curseforge.com/v1/mods/${curseforgeModpackId}/files/${curseforgeFileId}`;
                    const cfRes = await fetch(cfApiUrl, { headers: { 'Accept': 'application/json', 'x-api-key': process.env.CURSEFORGE_API_KEY } });
                    const responseText = await cfRes.text();
                    let cfData;
                    try { cfData = JSON.parse(responseText); } 
                    catch (parseErr) { throw new Error("CurseForge no devolvió un JSON válido (Posible bloqueo de API o clave inválida)."); }
                    
                    if (!cfRes.ok) throw new Error("Fallo al comunicarse con CurseForge API.");
                    if (cfData.data && cfData.data.downloadUrl) finalModpackUrl = cfData.data.downloadUrl;
                    else throw new Error("El autor bloqueó las descargas automáticas para este Modpack. Instálalo manualmente importando URL.");
                }

                if (finalModpackUrl) {
                    deployProgress[serverId] = { step: "Descargando Server Pack al servidor (Puede tardar varios minutos)...", pct: 30, done: false, error: null };
                    const response = await fetchDescarga(finalModpackUrl);
                    const contentType = response.headers.get('content-type') || '';
                    
                    if (!response.ok || contentType.includes('text/html')) throw new Error(`La plataforma bloqueó la descarga (El enlace no es un archivo válido).`);

                    deployProgress[serverId] = { step: "Guardando archivo ZIP en el disco...", pct: 50, done: false, error: null };
                    const tempZipPath = path.join(serverPath, 'temp_pack.zip');
                    const fileStream = fs.createWriteStream(tempZipPath);
                    await pipeline(response.body, fileStream);

                    deployProgress[serverId] = { step: "Descomprimiendo y analizando archivos del Modpack...", pct: 65, done: false, error: null };
                    const extracted = extractZipSafely(tempZipPath, serverPath);
                    if (!extracted) throw new Error("El archivo ZIP está corrupto o no se pudo extraer.");
                    if (fs.existsSync(tempZipPath)) fs.unlinkSync(tempZipPath);

                    const visibleFiles = fs.readdirSync(serverPath).filter(f => !f.startsWith('.'));
                    if (visibleFiles.length === 1) {
                        const singleItem = path.join(serverPath, visibleFiles[0]);
                        if (fs.statSync(singleItem).isDirectory()) {
                            const subfiles = fs.readdirSync(singleItem);
                            subfiles.forEach(f => fs.renameSync(path.join(singleItem, f), path.join(serverPath, f)));
                            fs.rmdirSync(singleItem);
                        }
                    }

                    deployProgress[serverId] = { step: "Instalando motor y limpiando scripts conflictivos...", pct: 75, done: false, error: null };

                    let engineToUse = software;
                    if (software === 'Server Pack' || software === 'Server Pack Oficial') {
                        const allFilesString = fs.readdirSync(serverPath).join(' ').toLowerCase();
                        engineToUse = 'forge'; 
                        if (allFilesString.includes('fabric')) engineToUse = 'fabric';
                        else if (allFilesString.includes('neoforge')) engineToUse = 'neoforge';
                        else if (allFilesString.includes('quilt')) engineToUse = 'quilt';

                        const userUpdate = await User.findOne({ uid });
                        const srvIndex = userUpdate.servers.findIndex(s => s.id === serverId);
                        if (srvIndex !== -1) {
                            userUpdate.servers[srvIndex].software = engineToUse;
                            await userUpdate.save();
                        }
                    }

                    const scriptsToRemove = ['start.bat', 'start.sh', 'run.bat', 'run.sh', 'start-server.bat', 'start-server.sh', 'user_jvm_args.txt'];
                    scriptsToRemove.forEach(scr => {
                        const p = path.join(serverPath, scr);
                        if (fs.existsSync(p)) fs.unlinkSync(p);
                    });

                    envVars = envVars.filter(e => !e.startsWith('TYPE=') && !e.startsWith('VERSION='));
                    envVars.push(`TYPE=${engineToUse.toUpperCase()}`);
                    if (version && version !== 'Auto' && version !== 'LATEST') envVars.push(`VERSION=${version}`);
                }

                deployProgress[serverId] = { step: "Verificando imágenes de Docker...", pct: 85, done: false, error: null };
                await pullImageAsync(mcImage);
                await pullImageAsync('pepaondrugs/playitgg-docker:latest');

                deployProgress[serverId] = { step: "Levantando contenedor Minecraft...", pct: 95, done: false, error: null };
                
                const mcContainer = await docker.createContainer({
                    Image: mcImage,
                    name: `mc-${serverId}`,
                    Env: envVars,
                    HostConfig: {
                        Memory: pDetails.ramBytes, 
                        MemorySwap: pDetails.ramBytes,
                        Binds: [`/home/maxpro/Proservers/servers/${serverId}:/data`],
                        Dns: ['8.8.8.8', '8.8.4.4'] 
                    }
                });
                await mcContainer.start();

                const playitContainer = await docker.createContainer({
                    Image: 'pepaondrugs/playitgg-docker:latest',
                    name: `playit-${serverId}`,
                    HostConfig: { NetworkMode: `container:mc-${serverId}` }
                });
                await playitContainer.start();

                deployProgress[serverId] = { step: "¡Todo Listo!", pct: 100, done: true, error: null };

            } catch (err) {
                console.error(`[ERROR DESPLIEGUE]`, err);
                deployProgress[serverId] = { step: "Despliegue Abortado", pct: 0, done: true, error: err.message };
                
                const userError = await User.findOne({ uid });
                if (userError) {
                    userError.servers = userError.servers.filter(s => s.id !== serverId);
                    await userError.save();
                }
            }
        });
    } catch(e) { res.status(500).json({ error: "Error interno DB" }); }
});

app.post('/api/project/delete', verifyToken, requireAccess, async (req, res) => {
    if (req.user.uid !== req.serverOwnerUid) return res.status(403).json({error: "Solo el dueño original puede eliminar el servidor por completo."});
    
    try {
        const user = await User.findOne({ uid: req.serverOwnerUid });
        user.servers = user.servers.filter(s => s.id !== req.body.serverId);
        await user.save();
        
        try {
            const mc = docker.getContainer(`mc-${req.body.serverId}`);
            await mc.stop().catch(() => {}); await mc.remove({ force: true, v: true }).catch(() => {});
            const playit = docker.getContainer(`playit-${req.body.serverId}`);
            await playit.stop().catch(() => {}); await playit.remove({ force: true, v: true }).catch(() => {});
            const sPath = path.join(__dirname, 'servers', req.body.serverId);
            if (fs.existsSync(sPath)) fs.rmSync(sPath, { recursive: true, force: true });
        } catch (e) {}
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: "Error DB" }); }
});

app.post('/api/project/ip', verifyToken, requireAccess, async (req, res) => {
    try {
        const user = await User.findOne({ uid: req.serverOwnerUid });
        const server = user.servers.find(s => s.id === req.body.serverId);
        if (server) { 
            server.publicIp = req.body.ip; 
            await user.save(); 
        }
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: "Error DB" }); }
});

app.get('/api/server/status', verifyToken, requireAccess, async (req, res) => {
    try {
        const data = await docker.getContainer(`mc-${req.query.serverId}`).inspect();
        res.json({ status: data.State.Running ? 'on' : 'off' });
    } catch (e) { res.json({ status: 'off' }); }
});

app.post('/api/server/start', verifyToken, requireAccess, async (req, res) => {
    try {
        const mc = docker.getContainer(`mc-${req.body.serverId}`);
        if (!(await mc.inspect()).State.Running) await mc.start();
        const playit = docker.getContainer(`playit-${req.body.serverId}`);
        if (!(await playit.inspect()).State.Running) await playit.start();
        res.json({ success: true });
    } catch (e) { res.json({ error: e.message }); }
});

app.post('/api/server/stop', verifyToken, requireAccess, async (req, res) => {
    try {
        const mc = docker.getContainer(`mc-${req.body.serverId}`);
        if ((await mc.inspect()).State.Running) await mc.stop();
        const playit = docker.getContainer(`playit-${req.body.serverId}`);
        if ((await playit.inspect()).State.Running) await playit.stop();
        res.json({ success: true });
    } catch (e) { res.json({ error: e.message }); }
});

app.post('/api/server/restart', verifyToken, requireAccess, async (req, res) => {
    try {
        await docker.getContainer(`mc-${req.body.serverId}`).restart();
        await docker.getContainer(`playit-${req.body.serverId}`).restart().catch(() => {});
        res.json({ success: true });
    } catch (e) { res.json({ error: e.message }); }
});

app.get('/api/server/stats', verifyToken, requireAccess, async (req, res) => {
    try {
        const stats = await docker.getContainer(`mc-${req.query.serverId}`).stats({ stream: false });
        const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
        const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
        let cpu = (systemDelta > 0 && cpuDelta > 0) ? ((cpuDelta / systemDelta) * stats.cpu_stats.online_cpus * 100).toFixed(1) : 0;
        res.json({ cpu: `${cpu}%`, ram: (stats.memory_stats.usage / (1024 * 1024)).toFixed(2) });
    } catch (e) { res.json({ cpu: '0%', ram: '0' }); }
});

app.post('/api/server/command', verifyToken, requireAccess, async (req, res) => {
    try {
        const exec = await docker.getContainer(`mc-${req.body.serverId}`).exec({ Cmd: ['rcon-cli', req.body.command], AttachStdout: true });
        exec.start(() => res.json({ success: true }));
    } catch (e) { res.status(500).json({ error: "Error" }); }
});

app.get('/api/server/players', verifyToken, requireAccess, async (req, res) => {
    try {
        const exec = await docker.getContainer(`mc-${req.query.serverId}`).exec({ Cmd: ['rcon-cli', 'list'], AttachStdout: true });
        exec.start((err, stream) => {
            if (err) return res.json({ players: [] });
            let output = '';
            stream.on('data', chunk => output += chunk.toString());
            stream.on('end', () => {
                const parts = output.replace(/\u001b\[[0-9;]*m/g, '').split(':');
                const players = (parts.length > 1 && parts[1].trim() !== '') ? parts[1].split(',').map(n => ({ name: n.trim(), avatar: `https://minotar.net/helm/${n.trim()}/100.png` })) : [];
                res.json({ players });
            });
        });
    } catch (e) { res.json({ players: [] }); }
});

app.post('/api/server/kick', verifyToken, requireAccess, async (req, res) => {
    try {
        const exec = await docker.getContainer(`mc-${req.body.serverId}`).exec({ Cmd: ['rcon-cli', 'kick', req.body.player], AttachStdout: true });
        exec.start(() => res.json({ success: true }));
    } catch (e) { res.status(500).json({ error: "Error" }); }
});

app.post('/api/server/ban', verifyToken, requireAccess, async (req, res) => {
    try {
        const exec = await docker.getContainer(`mc-${req.body.serverId}`).exec({ Cmd: ['rcon-cli', 'ban', req.body.player], AttachStdout: true });
        exec.start(() => res.json({ success: true }));
    } catch (e) { res.status(500).json({ error: "Error" }); }
});

app.get('/api/server/playitlogs', verifyToken, requireAccess, async (req, res) => {
    try {
        const logs = await docker.getContainer(`playit-${req.query.serverId}`).logs({ stdout: true, stderr: true, tail: 50 });
        res.json({ logs: logs.toString('utf8').replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, '') });
    } catch (e) { res.json({ logs: "Conectando..." }); }
});

app.post('/api/server/reset-network', verifyToken, requireAccess, async (req, res) => {
    if (req.user.uid !== req.serverOwnerUid) return res.status(403).json({error: "Solo el dueño puede resetear la red."});
    
    try {
        const user = await User.findOne({ uid: req.serverOwnerUid });
        const server = user.servers.find(s => s.id === req.body.serverId);
        
        const pName = `playit-${req.body.serverId}`;
        await docker.getContainer(pName).stop().catch(() => {});
        await docker.getContainer(pName).remove({ force: true, v: true }).catch(() => {});
        const newPlayit = await docker.createContainer({ Image: 'pepaondrugs/playitgg-docker:latest', name: pName, HostConfig: { NetworkMode: `container:mc-${req.body.serverId}` } });
        await newPlayit.start();
        
        server.publicIp = null; 
        await user.save();
        res.json({ success: true, message: "Red reseteada." });
    } catch (e) { res.status(500).json({ error: "Fallo al resetear." }); }
});

// ==========================================
// MINE AI
// ==========================================
app.post('/api/server/mine-ai', verifyToken, requireAccess, async (req, res) => {
    const GROQ_API_KEY = process.env.GROQ_API_KEY;
    if (!GROQ_API_KEY) return res.status(500).json({ success: false, error: "Falta API Key." });

    try {
        const container = docker.getContainer(`mc-${req.body.serverId}`);
        const logsBuffer = await container.logs({ stdout: true, stderr: true, tail: 150 });
        const logsText = logsBuffer.toString('utf8').replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, '');

        const prompt = `
        Eres 'Mine', el analista técnico de servidores Minecraft de Professional Servers.
        Tu tarea es leer el siguiente log del servidor y diagnosticar el estado.

        REGLAS ESTRICTAS:
        1. Si el servidor arrancó bien y solo hay "Warnings" o advertencias menores de Java, NO sugieras borrar nada. Explica que todo está bien.
        2. Si detectas un CRASH (Fallo fatal), Exception, Error de incompatibilidad de un Mod o Plugin específico, DEBES sugerir su eliminación.

        RESPONDE ÚNICAMENTE EN ESTE FORMATO JSON:
        {
            "mensaje": "Explicación corta y técnica del problema o estado actual.",
            "hay_que_borrar": true_o_false,
            "archivo_a_borrar": "nombre_exacto_del_archivo_problematico.jar_o_null",
            "paso_a_paso": "Qué debe hacer el usuario",
            "mod_alternativo": "Sugerencia de reemplazo o null"
        }

        LOG A ANALIZAR:
        ${logsText}
        `;

        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST', 
            headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                model: "openai/gpt-oss-120b",
                messages: [{ "role": "user", "content": prompt }], 
                response_format: { "type": "json_object" } 
            })
        });

        const data = await response.json();

        if (!response.ok || !data.choices) {
            console.error('[Mine AI] Groq error:', response.status, JSON.stringify(data));
            return res.status(502).json({ success: false, error: "Groq no pudo procesar el log." });
        }

        res.json({ success: true, analysis: JSON.parse(data.choices[0].message.content) });
    } catch (e) { 
        console.error('[Mine AI Error]:', e); 
        res.status(500).json({ success: false, error: "Error Mine AI." }); 
    }
});

// ==========================================
// CURSEFORGE API FIX - CORREGIDO
// ==========================================
app.get('/api/curseforge/search', verifyToken, async (req, res) => {
    try {
        const url = new URL('https://api.curseforge.com/v1/mods/search');
        url.searchParams.append('gameId', '432'); 
        if (req.query.query && req.query.query.trim() !== '' && req.query.query !== 'undefined') {
            url.searchParams.append('searchFilter', req.query.query.trim());
        }
        
        if (req.query.categoryId) url.searchParams.append('classId', req.query.categoryId); 
        if (req.query.classId) url.searchParams.append('classId', req.query.classId);

        url.searchParams.append('sortField', '2'); // 2 = Popularity
        url.searchParams.append('sortOrder', 'desc');
        
        const response = await fetch(url, { headers: { 'Accept': 'application/json', 'x-api-key': process.env.CURSEFORGE_API_KEY } });
        const responseText = await response.text();
        
        if (!response.ok) {
            console.error('\x1b[31m[CURSEFORGE ERROR AL BUSCAR]:\x1b[0m', response.status, responseText);
            throw new Error('CurseForge API Error');
        }
        
        res.json(JSON.parse(responseText));
    } catch (e) { 
        res.status(500).json({ error: "Error consultando CurseForge." }); 
    }
});

app.get('/api/curseforge/files', verifyToken, async (req, res) => {
    try {
        const url = new URL(`https://api.curseforge.com/v1/mods/${req.query.modId}/files`);
        if (req.query.version && req.query.version !== 'undefined' && req.query.version !== 'Auto') {
            url.searchParams.append('gameVersion', req.query.version);
        }
        const response = await fetch(url, { headers: { 'Accept': 'application/json', 'x-api-key': process.env.CURSEFORGE_API_KEY } });
        const responseText = await response.text();
        
        if (!response.ok) {
            console.error('[CurseForge Files Error]:', responseText);
            throw new Error('CurseForge API Error');
        }
        res.json(JSON.parse(responseText));
    } catch (e) { res.status(500).json({ error: "Error obteniendo archivos." }); }
});

// ==========================================
// FILE MANAGER
// ==========================================
app.post('/api/files/upload', verifyToken, upload.single('file'), requireAccess, requireFeature('fileManager'), (req, res) => {
    try {
        const serverPath = getSafePath(req.body.serverId, '/');
        if (req.file.originalname.endsWith('.zip')) {
            extractZipSafely(req.file.path, serverPath);
            fs.unlinkSync(req.file.path); 
            res.json({ success: true, message: "Modpack descomprimido." });
        } else if (req.file.originalname.endsWith('.jar')) {
            const mPath = getSafePath(req.body.serverId, '/mods');
            if (!fs.existsSync(mPath)) fs.mkdirSync(mPath, { recursive: true });
            fs.renameSync(req.file.path, path.join(mPath, req.file.originalname));
            res.json({ success: true, message: "Mod guardado." });
        } else res.json({ success: true });
    } catch (e) { res.status(500).json({ error: "Error." }); }
});

app.post('/api/files/upload-url', verifyToken, requireAccess, requireFeature('fileManager'), async (req, res) => {
    try {
        const serverPath = getSafePath(req.body.serverId, '/');
        const urlReal = req.body.downloadUrl;
        const response = await fetchDescarga(urlReal);
        
        const tempFilePath = path.join(serverPath, 'cloud_temp.zip');
        const fileStream = fs.createWriteStream(tempFilePath);
        await pipeline(response.body, fileStream);

        if (extractZipSafely(tempFilePath, serverPath)) {
            fs.unlinkSync(tempFilePath);
            res.json({ success: true, message: "Nube extraida." });
        } else res.status(500).json({ error: "Fallo extracción." });
    } catch (e) { res.status(500).json({ error: "Error nube." }); }
});

app.get('/api/files/list', verifyToken, requireAccess, requireFeature('fileManager'), (req, res) => {
    try {
        const sPath = req.query.path === '/' ? '' : req.query.path; 
        const tPath = getSafePath(req.query.serverId, sPath);
        if (!tPath || !fs.existsSync(tPath)) return res.json([]);
        res.json(fs.readdirSync(tPath, { withFileTypes: true }).map(f => ({ name: f.name, isDir: f.isDirectory(), path: path.posix.join(sPath || '/', f.name) })));
    } catch (e) { res.status(500).json({ error: "Error" }); }
});

app.get('/api/files/content', verifyToken, requireAccess, requireFeature('fileManager'), (req, res) => {
    try {
        const tPath = getSafePath(req.query.serverId, req.query.path);
        if (!tPath || !fs.existsSync(tPath)) return res.status(404).json({ error: "No encontrado" });
        res.json({ content: fs.readFileSync(tPath, 'utf8') });
    } catch (e) { res.status(500).json({ error: "Error" }); }
});

app.post('/api/files/save', verifyToken, requireAccess, requireFeature('fileManager'), (req, res) => {
    try {
        const tPath = getSafePath(req.body.serverId, req.body.path);
        if (fs.existsSync(tPath)) fs.copyFileSync(tPath, `${tPath}.bak`);
        fs.writeFileSync(tPath, req.body.content, 'utf8');
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: "Error" }); }
});

app.post('/api/files/delete', verifyToken, requireAccess, requireFeature('fileManager'), (req, res) => {
    try {
        const tPath = getSafePath(req.body.serverId, req.body.path);
        if (fs.statSync(tPath).isDirectory()) fs.rmSync(tPath, { recursive: true, force: true });
        else fs.unlinkSync(tPath);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: "Error" }); }
});

app.post('/api/server/installmod', verifyToken, requireAccess, requireFeature('fileManager'), async (req, res) => {
    try {
        const tDir = getSafePath(req.body.serverId, req.body.folder);
        if (!fs.existsSync(tDir)) fs.mkdirSync(tDir, { recursive: true });
        const fPath = path.join(tDir, path.basename(req.body.filename));
        const resp = await fetch(req.body.downloadUrl);
        fs.writeFileSync(fPath, Buffer.from(await resp.arrayBuffer()));
        await docker.getContainer(`mc-${req.body.serverId}`).restart().catch(() => {});
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: "Error" }); }
});

// ==========================================
// SOCKETS
// ==========================================
io.use(async (socket, next) => {
    if (!socket.handshake.query.token) return next(new Error('Sin token'));
    try { socket.user = await admin.auth().verifyIdToken(socket.handshake.query.token); next(); } 
    catch (err) { next(new Error('Invalido')); }
});

io.on('connection', async (socket) => {
    const serverId = socket.handshake.query.serverId;
    if (!serverId) return socket.disconnect();
    
    try {
        const userWithServer = await User.findOne({ "servers.id": serverId });
        if (!userWithServer) return socket.disconnect();
        
        const srv = userWithServer.servers.find(s => s.id === serverId);
        const isOwner = userWithServer.uid === socket.user.uid;
        const isShared = srv.sharedWith && srv.sharedWith.includes(socket.user.email);
        if (!isOwner && !isShared) return socket.disconnect();
        
        const container = docker.getContainer(`mc-${serverId}`);
        let logStream = null;
        container.inspect(async (err, data) => {
            if (err || !data.State.Running) return;
            try {
                logStream = await container.logs({ follow: true, stdout: true, stderr: true, tail: 100 });
                logStream.on('data', chunk => socket.emit('log', chunk.toString('utf8')));
            } catch (e) {}
        });
        socket.on('disconnect', () => { if (logStream) logStream.destroy(); });
    } catch(e) { socket.disconnect(); }
});

server.listen(3000, () => console.log('\x1b[32mBackend FINAL Listo - Conectado a MongoDB Full\x1b[0m'));