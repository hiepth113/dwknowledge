# Image chính thức của Playwright (đã có Chromium + deps hệ thống)
FROM mcr.microsoft.com/playwright:v1.54.0-noble

# Làm việc tại /app
WORKDIR /app

# Tạo package.json tối giản và cài playwright (npm package)
# (image có sẵn Node.js, nhưng KHÔNG kèm package playwright → cần cài)
RUN echo '{ "type": "module", "dependencies": { "playwright": "^1.54.0" } }' > package.json \
 && npm install --omit=dev

# Copy script vào image
COPY export-docuware.mjs /app/export-docuware.mjs

# Thư mục xuất PDF
RUN mkdir -p /app/pdf-out

# (Tuỳ chọn) đảm bảo quyền ghi khi image mặc định chạy bằng user pwuser
USER root
RUN chown -R pwuser:pwuser /app
USER pwuser

# Chạy script (docker-compose sẽ override bằng command nếu cần)
CMD ["node", "export-docuware.mjs"]
