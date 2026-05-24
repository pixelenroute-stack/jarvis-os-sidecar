#!/usr/bin/env bash
# Jarvis OS sidecar — installer for Ubuntu 22.04+ VPS (Hostinger).
# Usage:
#   1. Push this repo to GitHub: jarvis-os-sidecar
#   2. SSH to VPS as root, then:
#         curl -fsSL https://raw.githubusercontent.com/<OWNER>/jarvis-os-sidecar/main/deploy.sh | bash
#      Or git clone + bash deploy.sh
#
# What it does:
#   • Installs Node.js 20, Docker, git (if missing)
#   • Clones / updates sidecar to /opt/jarvis-sidecar
#   • Generates random JARVIS_API_TOKEN (printed at end)
#   • Installs systemd service jarvis-sidecar.service
#   • Configures nginx reverse proxy + Let's Encrypt cert (if DOMAIN env set)
#   • Opens firewall ports 80/443

set -euo pipefail

DOMAIN="${DOMAIN:-}"        # ex: jarvis.atelier-r.fr
EMAIL="${EMAIL:-}"          # for Let's Encrypt
REPO="${REPO:-https://github.com/pixelenroute-stack/jarvis-os-sidecar.git}"
INSTALL_DIR="/opt/jarvis-sidecar"
SERVICE_FILE="/etc/systemd/system/jarvis-sidecar.service"
NGINX_CONF="/etc/nginx/sites-available/jarvis-sidecar"

require_root() {
  [ "$EUID" -eq 0 ] || { echo "Run as root (sudo bash deploy.sh)"; exit 1; }
}

log() { echo -e "\n\033[1;36m▶ $*\033[0m"; }

install_prereqs() {
  log "Installing prerequisites…"
  apt-get update -y
  apt-get install -y curl git ufw ca-certificates gnupg lsb-release
  # Node 20
  if ! command -v node >/dev/null || [ "$(node -v | cut -c2 | head -c2)" -lt 18 ]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
  fi
  # Docker
  if ! command -v docker >/dev/null; then
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
      > /etc/apt/sources.list.d/docker.list
    apt-get update -y
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    systemctl enable docker --now
  fi
  if [ -n "$DOMAIN" ]; then
    apt-get install -y nginx certbot python3-certbot-nginx
  fi
}

fetch_code() {
  log "Fetching sidecar code…"
  if [ -d "$INSTALL_DIR/.git" ]; then
    git -C "$INSTALL_DIR" pull
  else
    git clone "$REPO" "$INSTALL_DIR"
  fi
  cd "$INSTALL_DIR"
  npm ci --omit=dev || npm install --omit=dev
}

generate_token() {
  if [ -f /etc/jarvis-sidecar.env ]; then
    log "Token already exists at /etc/jarvis-sidecar.env — reusing."
    return
  fi
  log "Generating JARVIS_API_TOKEN…"
  TOKEN=$(openssl rand -hex 32)
  cat > /etc/jarvis-sidecar.env <<EOF
JARVIS_API_TOKEN=$TOKEN
PORT=8088
EOF
  chmod 600 /etc/jarvis-sidecar.env
}

install_systemd() {
  log "Installing systemd unit…"
  cat > "$SERVICE_FILE" <<'UNIT'
[Unit]
Description=Jarvis OS sidecar API
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
EnvironmentFile=/etc/jarvis-sidecar.env
WorkingDirectory=/opt/jarvis-sidecar
ExecStart=/usr/bin/node /opt/jarvis-sidecar/server.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
User=root

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable jarvis-sidecar --now
  systemctl restart jarvis-sidecar
}

configure_nginx() {
  [ -z "$DOMAIN" ] && { log "DOMAIN env not set — skipping nginx + TLS."; return; }
  log "Configuring nginx for $DOMAIN…"
  cat > "$NGINX_CONF" <<EOF
server {
    listen 80;
    server_name $DOMAIN;

    location / {
        proxy_pass http://127.0.0.1:8088;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 600s;
    }
}
EOF
  ln -sf "$NGINX_CONF" /etc/nginx/sites-enabled/jarvis-sidecar
  nginx -t && systemctl reload nginx

  if [ -n "$EMAIL" ]; then
    log "Issuing Let's Encrypt cert for $DOMAIN…"
    certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect || true
  else
    log "EMAIL env not set — skipping Let's Encrypt. Run later: certbot --nginx -d $DOMAIN"
  fi
}

configure_firewall() {
  log "Opening firewall ports…"
  ufw --force enable || true
  ufw allow OpenSSH || true
  ufw allow 80 || true
  ufw allow 443 || true
  ufw reload || true
}

print_summary() {
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  ✓ Jarvis OS sidecar installed"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  echo "  Token API (copie-le dans Jarvis Desktop → Paramètres → SYNC · JARVIS OS) :"
  echo ""
  grep JARVIS_API_TOKEN /etc/jarvis-sidecar.env
  echo ""
  if [ -n "$DOMAIN" ]; then
    echo "  URL Jarvis OS    : https://$DOMAIN"
    echo "  Test santé       : curl -H \"Authorization: Bearer <TOKEN>\" https://$DOMAIN/api/health"
  else
    IP=$(curl -s4 ifconfig.me || hostname -I | awk '{print $1}')
    echo "  URL Jarvis OS    : http://$IP:8088"
    echo "  Test santé       : curl -H \"Authorization: Bearer <TOKEN>\" http://$IP:8088/api/health"
  fi
  echo ""
  echo "  Logs             : journalctl -u jarvis-sidecar -f"
  echo "  Restart          : systemctl restart jarvis-sidecar"
  echo ""
}

main() {
  require_root
  install_prereqs
  fetch_code
  generate_token
  install_systemd
  configure_nginx
  configure_firewall
  print_summary
}

main "$@"
