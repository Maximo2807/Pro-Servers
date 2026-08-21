# Usa la imagen base de Node.js
FROM node:20-alpine

# Silenciamos los avisos molestos de NPM
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
ENV NPM_CONFIG_FUND=false
ENV NPM_CONFIG_AUDIT=false
ENV NPM_CONFIG_LOGLEVEL=error

# Instala las herramientas de construcción necesarias y el unzip nativo
# Mantenemos las dependencias de compilación para que node-gyp pueda compilar mssql
RUN apk add --no-cache python3 make g++ unzip

# Define el directorio de trabajo
WORKDIR /usr/src/app

# Copia solo los archivos de dependencias
COPY package*.json ./

# Instalamos todo en una sola capa de forma silenciosa.
# Agregamos mssql a la lista de instalación forzada.
RUN npm install --legacy-peer-deps && \
    npm install firebase-admin@13 archiver adm-zip multer mssql --legacy-peer-deps

# Copia el resto de los archivos del proyecto
COPY . .

# Expone el puerto que usa el backend
EXPOSE 3000

# Comando para iniciar el servidor
CMD [ "npm", "start" ]