FROM mcr.microsoft.com/playwright:v1.54.0-noble

WORKDIR /app

# Copy script và khởi tạo package.json đơn giản
COPY export-docuware.mjs /app/
RUN echo '{ "type": "module", "dependencies": { "playwright": "^1.54.0" } }' > package.json

# Cài thư viện playwright (npm)
RUN npm install playwright@1.54.0

# Tạo thư mục output
RUN mkdir -p /app/pdf-out

CMD ["node", "export-docuware.mjs"]
