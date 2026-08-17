# Usa la imagen base de Node.js
FROM node:20-alpine

# Silenciamos los avisos molestos de NPM (Actualizaciones, auditorías y fondos)
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
ENV NPM_CONFIG_FUND=false
ENV NPM_CONFIG_AUDIT=false
ENV NPM_CONFIG_LOGLEVEL=error

# Instala las herramientas de construcción necesarias y el unzip nativo
RUN apk add --no-cache python3 make g++ unzip

# Define el directorio de trabajo
WORKDIR /usr/src/app

# Copia solo los archivos de dependencias para aprovechar el caché
COPY package*.json ./

# Instalamos todo en una sola capa de forma silenciosa
RUN npm install --legacy-peer-deps && \
    npm install firebase-admin@13 archiver adm-zip multer --legacy-peer-deps

# Copia el resto de los archivos del proyecto
COPY . .

# Expone el puerto que usa el backend
EXPOSE 3000

# Comando para iniciar el servidor
CMD [ "npm", "start" ]