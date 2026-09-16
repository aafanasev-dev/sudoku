# The web container: plain ES modules and CSS, nothing to compile, served by
# nginx, which also proxies /api and /auth to the backend container.
FROM nginx:1.27-alpine

LABEL org.opencontainers.image.title="Sudoku — Five Levels" \
      org.opencontainers.image.description="A five-level Sudoku game with Fibonacci-gated unlocks."

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html /usr/share/nginx/html/index.html
COPY css/       /usr/share/nginx/html/css/
COPY js/        /usr/share/nginx/html/js/

EXPOSE 80

# /healthz is proxied, so this checks the whole chain: nginx, backend, database.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1/healthz || exit 1
