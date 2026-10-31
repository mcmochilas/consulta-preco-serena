# Consulta de Preço · Serena Puxadores

App do showroom: o vendedor lê o EAN do mostruário no celular e vê preço, estoque, fotos e variações vindos da Magazord; monta pré-pedidos por ambiente. O administrador cuida da integração, dos vendedores, das etiquetas EAN e acompanha as consultas.

- `public/` — o app (página estática publicada na Vercel)
- `src/api.js` — camada de dados (Supabase); copiada para `public/api.js`
- `supabase/functions/` — funções do servidor: `usuarios` (login com usuário + PIN) e `magazord` (integração, sincronização, webhook, imagens)
- `build.py` — gera `public/index.html` a partir do protótipo aprovado

Banco: projeto Supabase "Consulta de Preço Serena" (sa-east-1). As credenciais da Magazord ficam só no servidor (tabela `app_secrets`, sem acesso pelo app).
