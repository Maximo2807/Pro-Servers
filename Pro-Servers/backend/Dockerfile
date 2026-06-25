# Usa la imagen base de Node.js más reciente y ligera.
FROM node:18-alpine

# Instala las herramientas de construcción necesarias para algunas dependencias.
RUN apk add --no-cache python3 make g++

# Define el directorio de trabajo dentro del contenedor.
WORKDIR /usr/src/app

# Copia solo el archivo package.json para aprovechar el caché de Docker.
COPY package*.json ./

# Instala las dependencias ignorando quejas de versiones
RUN npm install --legacy-peer-deps

# Instalamos explícitamente las librerías de la nube para evitar cualquier falta
RUN npm install archiver googleapis --legacy-peer-deps

# Copia el resto de los archivos del proyecto.
COPY . .

# Expone el puerto que usa el backend.
EXPOSE 3000

# Comando para iniciar el servidor.
CMD [ "npm", "start" ]