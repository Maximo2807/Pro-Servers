const mongoose = require('mongoose');
const mssql = require('mssql');
require('dotenv').config();

// ==========================================
// ESQUEMAS DE MONGODB
// ==========================================
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
// GESTOR DE CONEXIONES HÍBRIDAS
// ==========================================
let sqlPool = null;

const connectDatabases = async () => {
    try {
        // 1. Conectar a MongoDB (Juegos)
        await mongoose.connect(process.env.MONGO_URI);
        console.log('\x1b[34m[MongoDB] Conectado a Azure Cosmos DB exitosamente.\x1b[0m');

        // 2. Conectar a SQL Server (Facturación)
        sqlPool = await mssql.connect(process.env.SQL_URI);
        console.log('\x1b[36m[SQL Server] Conectado a Azure SQL (Facturación) exitosamente.\x1b[0m');

        // 3. Crear tablas SQL automáticamente si no existen
        await sqlPool.request().query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='Suscripciones' AND xtype='U')
            CREATE TABLE Suscripciones (
                id INT IDENTITY(1,1) PRIMARY KEY,
                firebase_uid VARCHAR(100) NOT NULL,
                plan_nombre VARCHAR(50) NOT NULL,
                estado VARCHAR(20) NOT NULL,
                fecha_inicio DATETIME DEFAULT GETDATE()
            );

            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='Pagos' AND xtype='U')
            CREATE TABLE Pagos (
                id INT IDENTITY(1,1) PRIMARY KEY,
                firebase_uid VARCHAR(100) NOT NULL,
                monto DECIMAL(10,2) NOT NULL,
                metodo VARCHAR(50),
                fecha DATETIME DEFAULT GETDATE(),
                transaccion_id VARCHAR(100)
            );
        `);
        console.log('\x1b[36m[SQL Server] Tablas de facturación sincronizadas y listas.\x1b[0m');

    } catch (error) {
        console.error('\x1b[31m[ERROR CRÍTICO DB]\x1b[0m Fallo al conectar con las bases de datos:', error);
        process.exit(1); // Detiene la app si fallan las DBs
    }
};

// Exportamos lo necesario para que el server.js lo use
module.exports = {
    connectDatabases,
    User,
    IpInfo,
    getSqlPool: () => sqlPool
};