# Usa la imagen base de Nginx
FROM nginx:alpine

# Borra el contenido por defecto de Nginx
RUN rm -rf /usr/share/nginx/html/*

# Copia la configuración de Nginx
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copia TODOS los archivos HTML de la carpeta frontend
COPY *.html /usr/share/nginx/html/

# Copia la carpeta assets entera (imágenes y videos)
COPY assets /usr/share/nginx/html/assets

# Expone el puerto 80
EXPOSE 80