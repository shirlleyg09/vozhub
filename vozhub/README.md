# 🎙️ VozHub — Guia de Instalação e Deploy

Plataforma de comunicação por voz online com bot de música, WebRTC e Socket.IO.

---

## 📁 Estrutura do Projeto

```
vozhub/
├── server/
│   ├── index.js        ← Servidor principal (Express + Socket.IO)
│   └── musicBot.js     ← Bot de música (YouTube + fila)
├── public/
│   ├── index.html      ← Interface principal
│   ├── css/
│   │   └── style.css   ← Estilos
│   └── js/
│       ├── webrtc.js   ← Gerenciador WebRTC (voz real)
│       └── app.js      ← Lógica do frontend
├── package.json
└── README.md
```

---

## 🚀 Instalação Local

### 1. Instalar dependências
```bash
cd vozhub
npm install
```

### 2. Iniciar em desenvolvimento
```bash
npm run dev
# ou
node server/index.js
```

### 3. Acessar
Abra: **http://localhost:3000**

---

## ☁️ Deploy no Render (gratuito)

1. Crie conta em **render.com**
2. Clique em **New → Web Service**
3. Conecte seu repositório GitHub com este projeto
4. Configure:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Environment:** Node
5. Clique em **Deploy**
6. Seu app estará em: `https://vozhub.onrender.com`

---

## 🖥️ Deploy no VPS (DigitalOcean / Vultr)

### 1. Instalar Node.js no servidor
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### 2. Clonar e instalar
```bash
git clone https://github.com/seu-user/vozhub.git
cd vozhub
npm install --production
```

### 3. Usar PM2 para manter o processo vivo
```bash
sudo npm install -g pm2
pm2 start server/index.js --name vozhub
pm2 save
pm2 startup
```

### 4. Nginx como proxy reverso (porta 80/443)
```nginx
server {
    listen 80;
    server_name seudominio.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

### 5. HTTPS com Certbot
```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d seudominio.com
```

---

## 🔊 WebRTC em Produção (TURN Server)

Para voz funcionar entre usuários em redes diferentes, você precisa de um **TURN server**.

### Opção 1: Coturn (gratuito, no seu VPS)
```bash
sudo apt install coturn
```

Edite `/etc/turnserver.conf`:
```
listening-port=3478
fingerprint
lt-cred-mech
realm=seudominio.com
user=vozhub:senha123
```

Adicione em `public/js/webrtc.js`:
```js
this.iceConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    {
      urls: 'turn:seudominio.com:3478',
      username: 'vozhub',
      credential: 'senha123'
    }
  ]
};
```

### Opção 2: Metered.ca (gratuito até 50GB/mês)
Cadastre em metered.ca e use as credenciais deles.

---

## 🎵 Bot de Música

O bot usa `yt-search` para busca e `ytdl-core` para stream de áudio.

### Dependências do bot:
```bash
npm install ytdl-core yt-search
```

### Como funciona:
1. Usuário clica "Buscar música" → busca no YouTube via `yt-search`
2. Seleciona uma música → servidor adiciona à fila do canal
3. `ytdl-core` faz stream do áudio diretamente para os clientes
4. Fila é sincronizada via Socket.IO em tempo real para todos no canal

### Comandos do bot (via UI):
| Ação | Evento Socket |
|------|--------------|
| Buscar | `music:search` |
| Adicionar | `music:play` |
| Pausar | `music:pause` |
| Continuar | `music:resume` |
| Pular | `music:skip` |
| Parar | `music:stop` |
| Aleatório | `music:shuffle` |
| Ver fila | `music:queue` |

---

## 🔒 Segurança

- Rate limiting: máx. 20 eventos por socket a cada 5 segundos
- Limite de usuários por canal: 20
- Kickar usuários: qualquer usuário pode (adicione roles para produção)
- Para produção: adicione autenticação JWT e validação de entrada

---

## ⚙️ Variáveis de Ambiente

Crie um arquivo `.env`:
```env
PORT=3000
NODE_ENV=production
```

---

## 📈 Roadmap / Futuro

- [ ] Sistema de login com senha
- [ ] Roles (Admin, Moderador, Membro)
- [ ] Chat de texto por canal
- [ ] Gravação de áudio
- [ ] Aplicativo mobile (React Native)
- [ ] Notificações push
- [ ] Bot de música com playlist do Spotify
- [ ] Limitar acesso por senha de servidor

---

## 🆘 Problemas Comuns

**"Permissão de microfone negada"**
→ Clique no cadeado na barra de endereços → Permita microfone

**"Sem áudio de outros usuários"**
→ Em redes corporativas/NAT, configure um TURN server

**"ytdl-core não funciona"**
→ YouTube muda APIs frequentemente. Execute: `npm update ytdl-core`
→ Ou use a fork: `npm install @distube/ytdl-core`

**Deploy no Render fica dormindo**
→ Use o plano pago ou configure um ping automático a cada 14 min
