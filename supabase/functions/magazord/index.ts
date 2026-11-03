// Consulta de Preço Serena · integração com a Magazord
//  Admin (JWT):   {action:"config", url, token, senha}  -> guarda as credenciais só no servidor
//                 {action:"status"}                      -> configurado? (nunca devolve a senha) + endereço do webhook
//                 {action:"test"}                        -> testa as rotas de produto, preço, estoque e imagem
//                 {action:"sync"}                        -> importa agora
//  Agendado:      header x-cron-secret                  -> importa se já passou o intervalo configurado
//  Webhook:       ?hook=<chave>                          -> a Magazord avisa que algo mudou; importa em seguida
//  Imagem:        GET ?img=<url>                         -> repassa a foto com CORS (para o PDF)
import { createClient } from "npm:@supabase/supabase-js@2.117.3";

const URL_ = Deno.env.get("SUPABASE_URL")!;
let KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
if (!KEY) { try { KEY = Object.values(JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}"))[0] as string; } catch { /* */ } }
const sb = createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-cron-secret", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

async function getSecret(name: string) { const { data } = await sb.from("app_secrets").select("value").eq("name", name).maybeSingle(); return data?.value as string | undefined; }
async function setSecret(name: string, value: string) { const { error } = await sb.from("app_secrets").upsert({ name, value }, { onConflict: "name" }); if (error) throw error; }
async function getCfg(id: string) { const { data } = await sb.from("config").select("data").eq("id", id).maybeSingle(); return (data?.data || {}) as Record<string, any>; }
async function setCfg(id: string, data: unknown) { await sb.from("config").upsert({ id, data, updated_at: new Date().toISOString() }, { onConflict: "id" }); }

function baseUrl(u: string) {
  let s = String(u || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  return s.replace(/\/api(\/.*)?$/i, "");
}
async function creds() {
  const url = await getSecret("magazord_url"), token = await getSecret("magazord_token"), senha = await getSecret("magazord_senha");
  if (!url || !token || !senha) throw new Error("Integração Magazord não configurada. Preencha as credenciais no painel.");
  return { url: baseUrl(url), auth: "Basic " + btoa(`${token}:${senha}`) };
}
async function mz(path: string) {
  const c = await creds();
  const r = await fetch(c.url + "/api" + path, { headers: { Authorization: c.auth, Accept: "application/json" } });
  const text = await r.text(); let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* texto */ }
  return { status: r.status, body };
}
function listOf(body: any): any[] {
  const d = body?.data ?? body;
  if (Array.isArray(d)) return d;
  for (const k of ["items", "itens", "produtos", "derivacoes", "data", "results", "registros"]) if (Array.isArray(d?.[k])) return d[k];
  return [];
}

/* ---------- leitura flexível dos campos da Magazord ---------- */
type Obj = Record<string, any>;
function walk(o: any, fn: (k: string, v: any, path: string) => void, path = "", depth = 0) {
  if (o == null || depth > 6) return;
  if (Array.isArray(o)) { o.forEach((x, i) => walk(x, fn, path + "[" + i + "]", depth + 1)); return; }
  if (typeof o === "object") { for (const [k, v] of Object.entries(o)) { fn(k, v, path ? path + "." + k : k); walk(v, fn, path ? path + "." + k : k, depth + 1); } }
}
function pick(o: any, re: RegExp, tipo: "string" | "number" | "any" = "any") {
  let achou: any = undefined;
  walk(o, (k, v) => {
    if (achou !== undefined || v == null || typeof v === "object") return;
    if (!re.test(k)) return;
    if (tipo === "number") { const n = Number(String(v).replace(",", ".")); if (isFinite(n)) achou = n; }
    else if (tipo === "string") { if (String(v).trim()) achou = String(v).trim(); }
    else achou = v;
  });
  return achou;
}
const eanNorm = (e: unknown) => { let s = String(e ?? "").replace(/\D/g, ""); while (s.length > 13 && s.startsWith("0")) s = s.slice(1); return s.length >= 8 ? s : ""; };
function imagensDe(o: any, base: string): string[] {
  const out: string[] = [];
  walk(o, (k, v) => {
    if (typeof v !== "string") return;
    if (/^https?:\/\/.+\.(jpe?g|png|webp|gif)(\?.*)?$/i.test(v)) out.push(v);
    else if (/(url|path|caminho|arquivo|imagem|midia)/i.test(k) && /\.(jpe?g|png|webp)(\?.*)?$/i.test(v)) out.push(v.startsWith("//") ? "https:" + v : v.startsWith("/") ? base + v : v);
  });
  return [...new Set(out)];
}
function atributo(o: any, re: RegExp) {
  // derivações costumam vir como lista de {nome/tipo: "Cor", valor: "Preto"}
  let val = "";
  walk(o, (_k, v) => {
    if (val || !v || typeof v !== "object" || Array.isArray(v)) return;
    const nome = String(v.nome ?? v.tipo ?? v.atributo ?? v.descricaoTipo ?? v.caracteristica ?? "");
    const valor = v.valor ?? v.descricao ?? v.nomeValor ?? v.value;
    if (re.test(nome) && valor != null && typeof valor !== "object") val = String(valor);
  });
  return val || String(pick(o, re, "string") ?? "");
}
const TAM = /^\s*\d+([.,]\d+)?\s*(mm|cm|m|pol)?\s*$|\d+\s*(mm|cm)\b|^(pp|p|m|g|gg|mini|ponto)$/i;
function mapDeriv(d: Obj, prod: Obj | null, base: string) {
  const codigo = String(d.codigo ?? d.id ?? "");
  const nomeCompleto = String(d.nomeCompleto ?? "").trim();
  const partes = nomeCompleto.split(" - ").map((x) => x.trim()).filter(Boolean);
  const valores = (Array.isArray(d.derivacoes) ? d.derivacoes : []).map((x: Obj) => String(x?.valor ?? "").trim()).filter((v: string) => v && !/^(único|unico|padrão|padrao|u)$/i.test(v));
  const tamanho = valores.find((v: string) => TAM.test(v)) || "";
  const cor = valores.find((v: string) => v !== tamanho) || "";
  const prodNome = String(prod?.nome ?? partes.slice(0, 2).join(" - ") ?? "");
  return {
    id: codigo,
    produto_id: String(prod?.codigo ?? d.agrupador ?? codigo),
    produto_nome: prodNome || nomeCompleto,
    titulo: nomeCompleto || prodNome || String(d.nome ?? codigo),
    cor: cor.slice(0, 60),
    tamanho: tamanho.slice(0, 60),
    linha: String(partes.length > 1 ? partes[1] : (prod?.modelo ?? "")).slice(0, 60),
    sku: codigo,
    ean: eanNorm(d.ean),
    preco: pick(d, /^(precoVenda|valorVenda|precoPor|preco|precoAtual)$/i, "number") ?? null,
    preco_promo: pick(d, /(precoPromocional|valorPromocional|precoPromocao)/i, "number") ?? null,
    estoque: Math.max(0, Math.round(pick(d, /^(estoqueDisponivel|quantidadeDisponivel|saldoDisponivel|disponivel|estoque|saldo|quantidadeEstoque)$/i, "number") ?? 0)),
    imagens: imagensDe(d, base).slice(0, 12),
    ativo: true,
    raw: d,
    updated_at: new Date().toISOString(),
  };
}

/* ---------- teste das rotas (mostra o formato dos dados, sem valores sensíveis) ---------- */
function shape(v: unknown, depth = 0): unknown {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.length ? [shape(v[0], depth + 1), `(${v.length})`] : [];
  if (typeof v === "object") { if (depth > 5) return "{…}"; const o: Obj = {}; for (const [k, x] of Object.entries(v as Obj)) o[k] = shape(x, depth + 1); return o; }
  if (typeof v === "string") return v.length > 90 ? v.slice(0, 90) + "…" : v;
  return v;
}
async function testar() {
  const out: Obj = { at: Date.now(), rotas: [] as Obj[] };
  const tenta = async (nome: string, path: string) => {
    try { const r = await mz(path); const l = listOf(r.body); const d = (r.body as any)?.data;
      const meta = d && typeof d === "object" && !Array.isArray(d) ? Object.fromEntries(Object.entries(d).filter(([, v]) => !Array.isArray(v) && typeof v !== "object")) : null;
      const reg = { nome, path, status: r.status, ok: r.status < 400, total: l.length, meta, exemplo: shape(l[0] ?? d ?? r.body) };
      out.rotas.push(reg); return { r, l };
    } catch (e) { out.rotas.push({ nome, path, status: 0, ok: false, erro: (e as Error).message }); return { r: null, l: [] }; }
  };
  const p = await tenta("Produtos", "/v2/site/produto?limit=2&page=1");
  const dv = await tenta("Variações", "/v2/site/produtoDerivacoes?limit=2&page=1");
  const prod = p.l[0], der = dv.l[0];
  const pc = String(prod?.codigo ?? der?.produtoCodigo ?? der?.produto?.codigo ?? "");
  const dc = String(der?.codigo ?? "");
  if (pc) {
    await tenta("Produto (detalhe)", `/v2/site/produto/${encodeURIComponent(pc)}`);
    await tenta("Variações do produto", `/v2/site/produto/${encodeURIComponent(pc)}/derivacoes`);
  }
  if (pc && dc) {
    await tenta("Variação (detalhe)", `/v2/site/produto/${encodeURIComponent(pc)}/derivacao/${encodeURIComponent(dc)}`);
    await tenta("Imagens da variação", `/v2/site/produto/${encodeURIComponent(pc)}/derivacao/${encodeURIComponent(dc)}/midia`);
  }
  if (dc) {
    await tenta("Estoque por localização", `/v2/estoqueLocalizacao/produto/${encodeURIComponent(dc)}`);
    await tenta("Estoque (lista)", `/v2/site/estoque?produto=${encodeURIComponent(dc)}&limit=2`);
    await tenta("Estoque v1", `/v1/listEstoque?produto=${encodeURIComponent(dc)}&limit=2`);
  }
  await tenta("Tabelas de preço", "/v2/site/tabelaPreco?limit=2&page=1");
  const at = await sb.from("variacoes").select("id,produto_id").limit(1).maybeSingle();
  const dA = String(at.data?.id || dc), pA = String(at.data?.produto_id || pc);
  if (dA) {
    await tenta("Vitrine do site (preço/estoque/fotos)", `/v2/site/frontend/produto/1/${encodeURIComponent(dA)}`);
    await tenta("Projeção de estoque", `/v2/site/estoque/projecaoEstoque/produtoDerivacao?produto=${encodeURIComponent(dA)}`);
    await tenta("Estoque por localização (ativa)", `/v2/estoqueLocalizacao/produto/${encodeURIComponent(dA)}`);
    await tenta("Imagens (ativa)", `/v2/site/produto/${encodeURIComponent(pA)}/derivacao/${encodeURIComponent(dA)}/midia`);
    await tenta("Produto ativo (detalhe)", `/v2/site/produto/${encodeURIComponent(pA)}`);
  }
  await setCfg("magazord_probe", out);
  return out;
}

/* ---------- importação: só produtos ativos e variações ativas ---------- */
async function paginas(path: string, max: number, cada: (l: Obj[]) => void) {
  for (let pagina = 1; pagina <= max; pagina++) {
    const r = await mz(`${path}${path.includes("?") ? "&" : "?"}limit=100&page=${pagina}`);
    if (r.status === 401 || r.status === 403) throw new Error(`A Magazord não liberou ${path} para este token (erro ${r.status}).`);
    if (r.status >= 400) throw new Error(`A Magazord respondeu erro ${r.status} em ${path} (página ${pagina}).`);
    const l = listOf(r.body); if (!l.length) return pagina;
    cada(l);
    if ((r.body as any)?.data?.has_more === false || l.length < 100) return pagina;
  }
  return max;
}
async function sync(origem: string) {
  const t0 = Date.now(), c = await creds();
  // 1) produtos: quem está ativo e de qual produto é cada variação
  const paiDe = new Map<string, Obj>(); let prodAtivos = 0, prodInativos = 0;
  const pgP = await paginas("/v2/site/produto", 80, (l) => l.forEach((p) => {
    const ativo = p.ativo === true || p.ativo === 1;
    if (ativo) prodAtivos++; else prodInativos++;
    for (const d of (Array.isArray(p.derivacoes) ? p.derivacoes : [])) if (d && typeof d === "object" && d.codigo != null) paiDe.set(String(d.codigo), { codigo: p.codigo, nome: p.nome, modelo: p.modelo, ativo });
  }));
  // 2) variações: guarda só as ativas de produtos ativos
  const vistos = new Set<string>(); let total = 0, semEan = 0, ignoradas = 0; const erros: string[] = [];
  let lote: Obj[] = [];
  // variações que já existem: só atualiza cadastro (preço, estoque, fotos e nomes vêm da vitrine)
  const existentes = new Set<string>();
  for (let from = 0; ; from += 1000) { const { data } = await sb.from("variacoes").select("id").range(from, from + 999); (data || []).forEach((x) => existentes.add(x.id)); if (!data || data.length < 1000) break; }
  const grava = async () => {
    if (!lote.length) return;
    const novas = lote.filter((r) => !existentes.has(r.id)).map(({ preco, preco_promo, estoque, imagens, ...r }) => r);
    const velhas = lote.filter((r) => existentes.has(r.id)).map((r) => ({ id: r.id, produto_id: r.produto_id, produto_nome: r.produto_nome, sku: r.sku, ean: r.ean, ativo: true, raw: r.raw, updated_at: r.updated_at }));
    for (const parte of [novas, velhas]) if (parte.length) { const { error } = await sb.from("variacoes").upsert(parte, { onConflict: "id" }); if (error) erros.push(error.message); }
    total += lote.length; lote = [];
  };
  const pend: Obj[][] = [];
  const pgD = await paginas("/v2/site/produtoDerivacoes", 120, (l) => pend.push(l));
  for (const l of pend) {
    for (const d of l) {
      const pai = paiDe.get(String(d.codigo));
      const ativa = (d.ativo === true || d.ativo === 1) && (!pai || pai.ativo) && !/-inativo$/i.test(String(d.codigo)) && String(d.tipoRegistro || "").toLowerCase() !== "pai";
      if (!ativa) { ignoradas++; continue; }
      const row = mapDeriv(d, pai || null, c.url);
      if (!row.id) continue;
      vistos.add(row.id); if (!row.ean) semEan++;
      lote.push(row);
      if (lote.length >= 500) await grava();
    }
  }
  await grava();
  // 3) o que não está mais ativo na Magazord sai da base
  let removidas = 0;
  if (total && !erros.length) {
    const ids: string[] = [];
    for (let from = 0; ; from += 1000) { const { data } = await sb.from("variacoes").select("id").range(from, from + 999); (data || []).forEach((x) => ids.push(x.id)); if (!data || data.length < 1000) break; }
    const sair = ids.filter((id) => !vistos.has(id));
    for (let i = 0; i < sair.length; i += 200) { await sb.from("variacoes").delete().in("id", sair.slice(i, i + 200)); }
    removidas = sair.length;
  }
  const res = erros.length ? "Erro: " + erros[0].slice(0, 80) : semEan ? `${semEan} sem EAN` : "Ok";
  const info = { ms: Date.now() - t0, paginasProdutos: pgP, paginasVariacoes: pgD, prodAtivos, prodInativos, ignoradas, removidas, erros };
  await sb.from("sync_log").insert({ origem, itens: total, res, info });
  await setCfg("magazord_sync", { last: Date.now(), itens: total, res, ...info });
  return { ok: !erros.length, itens: total, semEan, res, ...info };
}

/* ---------- preço, estoque e fotos (rota da vitrine do site, uma variação por vez) ---------- */
async function baseImagem(c: { url: string }, midia: Obj): Promise<string | null> {
  const salvo = (await getCfg("img_base")).base as string | undefined;
  if (salvo) return salvo;
  const rel = String(midia.path || "") + String(midia.arquivo_nome || "");
  const host = new URL(c.url).hostname, loja = host.split(".")[0];
  const cands = [`https://${host.replace(".painel.", ".cdn.")}/`, `https://${loja}.cdn.magazord.com.br/`, "https://www.serenapuxadores.com.br/", "https://serenapuxadores.com.br/", `https://cdn.magazord.com.br/${loja}/`];
  for (const b of cands) {
    try { const r = await fetch(b + rel); const ok = r.ok && /^image\//.test(r.headers.get("content-type") || ""); await r.body?.cancel(); if (ok) { await setCfg("img_base", { base: b, at: Date.now() }); return b; } } catch { /* tenta a próxima */ }
  }
  await setCfg("img_base", { base: null, tentou: cands, rel, at: Date.now() });
  return null;
}
// a Magazord limita as requisições por minuto (429): poucas por vez, para no primeiro 429 e continua na próxima rodada
async function detalhar(limiteMs = 40e3, conc = 2, max = 120) {
  const t0 = Date.now(), c = await creds();
  const { data: fila } = await sb.from("variacoes").select("id").order("detalhe_at", { ascending: true, nullsFirst: true }).limit(max);
  let feitos = 0, falhas = 0, limitado = false, base: string | null | undefined = undefined; const erros: string[] = [];
  const um = async (v: Obj) => {
    const r = await mz(`/v2/site/frontend/produto/1/${encodeURIComponent(v.id)}`);
    if (r.status === 429) { limitado = true; return; }
    const d = (r.body as any)?.data;
    // a vitrine precisa devolver a mesma variação pedida; se vier outra, não grava nada dela
    if (d && typeof d === "object" && d.codigo != null && String(d.codigo) !== String(v.id)) { falhas++; if (erros.length < 3) erros.push(`${v.id}: veio ${d.codigo}`); await sb.from("variacoes").update({ detalhe_at: new Date().toISOString() }).eq("id", v.id); return; }
    if (r.status >= 400 || !d || typeof d !== "object") { falhas++; if (erros.length < 3) erros.push(`${v.id}: ${r.status}`); await sb.from("variacoes").update({ detalhe_at: new Date().toISOString() }).eq("id", v.id); return; }
    const midias = (Array.isArray(d.midias) ? d.midias : []).filter((m: Obj) => m && m.arquivo_nome && (m.tipo_file ?? 1) === 1).sort((a: Obj, b: Obj) => (a.ordem ?? 0) - (b.ordem ?? 0));
    if (base === undefined && midias[0]) base = await baseImagem(c, midias[0]);
    const atrib = (Array.isArray(d.derivacoes_produto) ? d.derivacoes_produto : []).filter((x: Obj) => x && x.derivacao);
    const cor = atrib.find((x: Obj) => /cor|acabamento/i.test(String(x.deri_nome)))?.derivacao;
    const tam = atrib.find((x: Obj) => !/cor|acabamento/i.test(String(x.deri_nome)))?.derivacao;
    const valor = Number(d.valor) || 0, de = Number(d.valor_de) || 0;
    const patch: Obj = {
      preco: de > valor ? de : valor, preco_promo: de > valor ? valor : null,
      estoque: Math.max(0, Math.round(Number(d.qtde_estoque) || 0)),
      imagens: base ? midias.map((m: Obj) => base + String(m.path || "") + String(m.arquivo_nome)).slice(0, 12) : [],
      detalhe_at: new Date().toISOString(),
    };
    // "nome" é o nome cadastrado do produto; "titulo" é o título de SEO do site (às vezes com erro de digitação)
    if (d.nome || d.titulo) patch.titulo = String(d.nome || d.titulo);
    if (d.marca) patch.linha = String(d.marca).slice(0, 60);
    if (cor && !/^(único|unico)$/i.test(cor)) patch.cor = String(cor).slice(0, 60);
    if (tam && !/^(único|unico)$/i.test(tam)) patch.tamanho = String(tam).slice(0, 60);
    if (d.ativo === false) patch.ativo = false;
    await sb.from("variacoes").update(patch).eq("id", v.id);
    feitos++;
  };
  let i = 0;
  const lista = fila || [];
  const trabalhador = async () => { while (!limitado && i < lista.length && Date.now() - t0 < limiteMs) { const v = lista[i++]; try { await um(v); } catch (e) { falhas++; if (erros.length < 3) erros.push((e as Error).message); } } };
  await Promise.all(Array.from({ length: conc }, trabalhador));
  const info = { feitos, falhas, limitado, ms: Date.now() - t0, erros };
  await setCfg("magazord_detalhe", { last: Date.now(), ...info });
  return info;
}

async function quem(req: Request) {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const { data: u } = await sb.auth.getUser(token);
  if (!u?.user) return null;
  const { data: p } = await sb.from("profiles").select("role,active").eq("id", u.user.id).maybeSingle();
  return p?.active ? p : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const u = new URL(req.url);
  try {
    // foto com CORS liberado (o PDF precisa desenhar a imagem)
    if (req.method === "GET" && u.searchParams.get("img")) {
      const alvo = new URL(u.searchParams.get("img")!);
      const loja = new URL(baseUrl((await getSecret("magazord_url")) || "https://x.magazord.com.br"));
      if (alvo.protocol !== "https:" || !(/(^|\.)magazord\.com\.br$/i.test(alvo.hostname) || alvo.hostname === loja.hostname || /(^|\.)serenapuxadores\.com\.br$/i.test(alvo.hostname)))
        return json({ error: "Endereço de imagem não permitido." }, 400);
      const r = await fetch(alvo.toString());
      if (!r.ok || !/^image\//.test(r.headers.get("content-type") || "")) return json({ error: "Imagem não encontrada." }, 404);
      return new Response(r.body, { headers: { ...CORS, "Content-Type": r.headers.get("content-type")!, "Cache-Control": "public, max-age=86400" } });
    }
    // webhook da Magazord
    const hook = u.searchParams.get("hook");
    if (hook) {
      if (hook !== await getSecret("webhook_key")) return json({ error: "Chave inválida." }, 403);
      const info = await sync("Webhook");
      return json(info);
    }
    const b = await req.json().catch(() => ({}));
    // agendamento (pg_cron)
    const cron = req.headers.get("x-cron-secret");
    if (cron) {
      if (cron !== await getSecret("cron_secret")) return json({ error: "Proibido." }, 403);
      if (!(await getSecret("magazord_token"))) return json({ ok: true, skip: "sem credenciais" });
      if (b.action === "probe") return json(await testar());
      if (b.action === "sync") return json(await sync("Manual"));
      if (b.action === "detalhe") return json(await detalhar());
      const regras = await getCfg("regras"), ult = await getCfg("magazord_sync");
      const freq = Math.max(5, Number(regras.freq) || 15) * 60e3;
      if (!ult.last || Date.now() - ult.last >= freq - 30e3) return json(await sync("Automática"));
      return json(await detalhar());
    }
    const me = await quem(req);
    if (!me) return json({ error: "Entre de novo para continuar." }, 401);
    if (me.role !== "admin") return json({ error: "Só o administrador pode acessar a integração." }, 403);

    if (b.action === "status") {
      const url = await getSecret("magazord_url"), token = await getSecret("magazord_token"), senha = await getSecret("magazord_senha");
      const k = await getSecret("webhook_key");
      return json({ configured: !!(url && token && senha), url: url || "", token: token ? token.slice(0, 4) + "…" : "", senha: !!senha,
        webhook: `${URL_}/functions/v1/magazord?hook=${k}`, probe: await getCfg("magazord_probe"), sync: await getCfg("magazord_sync") });
    }
    if (b.action === "config") {
      if (!b.url) return json({ error: "Informe o endereço do painel Magazord." }, 400);
      await setSecret("magazord_url", baseUrl(b.url));
      if (b.token) await setSecret("magazord_token", String(b.token).trim());
      if (b.senha) await setSecret("magazord_senha", String(b.senha).trim());
      return json({ ok: true });
    }
    if (b.action === "test") {
      const out = await testar();
      const ok = out.rotas.filter((r: Obj) => r.ok).map((r: Obj) => r.nome), nao = out.rotas.filter((r: Obj) => !r.ok).map((r: Obj) => `${r.nome} (${r.status || "sem resposta"})`);
      return json({ ok: ok.length > 0, liberadas: ok, bloqueadas: nao });
    }
    if (b.action === "sync") { const r = await sync("Manual"); const d = await detalhar(30e3); return json({ ...r, detalhados: d.feitos }); }
    return json({ error: "Ação inválida." }, 400);
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
