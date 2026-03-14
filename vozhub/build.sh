#!/bin/bash
# Build script — instala dependências Node e yt-dlp
set -e

echo "==> Instalando dependências Node..."
npm install

echo "==> Instalando yt-dlp..."
# Tenta pip primeiro (Python disponível no Render)
if command -v pip3 &> /dev/null; then
  pip3 install yt-dlp --quiet && echo "==> yt-dlp instalado via pip3" && exit 0
fi
if command -v pip &> /dev/null; then
  pip install yt-dlp --quiet && echo "==> yt-dlp instalado via pip" && exit 0
fi

# Fallback: baixa o binário direto
echo "==> Baixando yt-dlp binário..."
curl -sL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
chmod +x /usr/local/bin/yt-dlp
echo "==> yt-dlp binário instalado em /usr/local/bin/yt-dlp"