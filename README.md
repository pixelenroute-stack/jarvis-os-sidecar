# Jarvis OS sidecar

API REST déployée sur ton VPS Hostinger qui pilote les services Docker (Agent Zero, Qdrant, CompreFace, Ollama) et installe les MCPs pour Claude Desktop. Consommée par Jarvis Desktop (Windows) via HTTPS + Bearer token.

## Installation 1-commande sur ton VPS

```bash
# SSH sur ton VPS Hostinger en root
ssh root@72.60.186.9

# Sans HTTPS (test rapide, IP brute)
curl -fsSL https://raw.githubusercontent.com/<OWNER>/jarvis-os-sidecar/main/deploy.sh | bash

# Avec HTTPS Let's Encrypt
DOMAIN=jarvis.atelier-r.fr EMAIL=ton@email.fr \
  curl -fsSL https://raw.githubusercontent.com/<OWNER>/jarvis-os-sidecar/main/deploy.sh | bash
```

Le script affiche le `JARVIS_API_TOKEN` à la fin → copie-le dans :
**Jarvis Desktop → Paramètres → SYNC · JARVIS OS (VPS) → Bearer token**

## Endpoints

Tous nécessitent `Authorization: Bearer <TOKEN>`.

| Méthode | Endpoint | Description |
|---|---|---|
| GET  | `/api/health` | Statut sidecar (uptime, RAM, charge) |
| GET  | `/api/services` | Liste des services Docker gérés |
| GET  | `/api/services/:id/status` | Statut détaillé + logs |
| POST | `/api/services/:id/start` | Démarrer le container |
| POST | `/api/services/:id/stop` | Arrêter + supprimer |
| POST | `/api/install/:toolId` | Pull + run (async, retourne jobId) |
| GET  | `/api/install/:jobId` | Statut d'un job d'install |
| GET  | `/api/mcps` | MCPs installables + état |
| POST | `/api/mcps/:id/install` | Install MCP + écrit claude_desktop_config.json |
| DELETE | `/api/mcps/:id` | Désinstalle MCP de la config Claude |
| GET  | `/api/agents` | Agents exposés (Agent Zero, CompreFace) |
| GET  | `/api/agents/:id/test` | Health check live d'un agent |
| POST | `/api/exec` | Exécution whitelisted (docker ps, df -h…) |

## Services gérés

| ID | Container | Port | Description |
|---|---|---|---|
| agent-zero | jarvis-agent-zero | 8080 | Framework agent autonome |
| qdrant | jarvis-qdrant | 6333 | Base vectorielle |
| compreface-postgres | jarvis-compreface-db | — | Postgres pour CompreFace |
| compreface | jarvis-compreface | 8000 | Reconnaissance faciale |
| ollama | jarvis-ollama | 11434 | LLM local (CPU sur VPS) |

## MCPs installables

| ID | Type | Note |
|---|---|---|
| github | npx | Token: github.com/settings/tokens |
| supabase | npx | Token: supabase.com/dashboard/account/tokens |
| hostinger | npx | Token: hpanel.hostinger.com/profile/api |
| premiere-pro | git+build | Panel CEP à installer manuellement |
| after-effects | git+build | Bridge à installer dans AE |

## Sécurité

- Bearer token aléatoire 64 chars (généré par `openssl rand`)
- Rate limit : 300 req/min/IP
- Helmet (headers) + CORS large (à restreindre en prod si tu connais l'IP du Desktop)
- `/api/exec` strictement whitelisted (`docker ps`, `df -h`, etc.)
- Token stocké dans `/etc/jarvis-sidecar.env` (mode 600, root only)

## Maintenance

```bash
# Logs en direct
journalctl -u jarvis-sidecar -f

# Restart après update
cd /opt/jarvis-sidecar && git pull && npm install --omit=dev
systemctl restart jarvis-sidecar

# Désinstall complet
systemctl stop jarvis-sidecar && systemctl disable jarvis-sidecar
rm /etc/systemd/system/jarvis-sidecar.service /etc/jarvis-sidecar.env
rm -rf /opt/jarvis-sidecar
```

## Stack

- Node.js 20 + Express
- Docker (containers lifecycle)
- Nginx reverse proxy
- Let's Encrypt (certbot, renouvellement auto)
- systemd (auto-restart, démarrage au boot)
