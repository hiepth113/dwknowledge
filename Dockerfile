# Playwright + browsers + system deps
FROM mcr.microsoft.com/playwright:v1.54.0-noble

# Thư mục app
WORKDIR /app

# Cài Node deps (nếu cần thêm thư viện, thêm package.json vào đây)
# Ở đây script chỉ dùng Playwright có sẵn trong image
COPY export-docuware.mjs /app/export-docuware.mjs

# Thư mục output PDF
RUN mkdir -p /app/pdf-out

# Healthcheck đơn giản (tùy chọn)
HEALTHCHECK NONE

# Mặc định, docker-compose sẽ override bằng command trong compose
CMD ["node", "export-docuware.mjs"]
