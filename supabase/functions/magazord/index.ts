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
function mapDeriv(d: Obj, prod: Obj | null, base: string) {
  const codigo = String(d.codigo ?? d.produtoDerivacaoCodigo ?? d.sku ?? d.id ?? "");
  const prodCod = String(prod?.codigo ?? d.produtoCodigo ?? d.codigoProduto ?? d.produto?.codigo ?? d.produto ?? "");
  const prodNome = String(prod?.nome ?? d.produtoNome ?? d.produto?.nome ?? "");
  const derNome = String(d.nome ?? d.produtoDerivacaoNome ?? d.descricao ?? "");
  const titulo = derNome && prodNome && !derNome.toLowerCase().includes(prodNome.toLowerCase()) ? `${prodNome} ${derNome}` : (derNome || prodNome);
  const ativoV = d.ativo ?? d.situacao ?? prod?.ativo;
  return {
    id: codigo,
    produto_id: prodCod || codigo.split("-")[0],
    produto_nome: prodNome || titulo,
    titulo: titulo || codigo,
    cor: atributo(d, /^cor$|cor\b|acabamento/i).slice(0, 60),
    tamanho: atributo(d, /tamanho|medida|furac|dimens/i).slice(0, 60),
    linha: String(prod?.marca?.nome ?? prod?.marcaNome ?? d.marcaNome ?? pick(prod || d, /^marca(Nome)?$/i, "string") ?? "").slice(0, 60),
    sku: codigo,
    ean: eanNorm(pick(d, /^(ean|gtin|ean13|codigoBarras|codigoDeBarras|codigoEan)$/i)),
    preco: pick(d, /^(precoVenda|valorVenda|precoPor|preco|valor|precoAtual)$/i, "number") ?? pick(prod, /^(precoVenda|valorVenda|preco|valor)$/i, "number") ?? null,
    preco_promo: pick(d, /(precoPromocional|valorPromocional|precoPromocao)/i, "number") ?? null,
    estoque: Math.max(0, Math.round(pick(d, /^(estoqueDisponivel|quantidadeDisponivel|saldoDisponivel|disponivel|estoque|saldo|quantidadeEstoque)$/i, "number") ?? 0)),
    imagens: imagensDe(d, base).concat(prod ? imagensDe({ m: prod.midias ?? prod.imagens ?? prod.midia }, base) : []).filter((x, i, a) => a.indexOf(x) === i).slice(0, 12),
    ativo: ativoV === undefined ? true : !(ativoV === false || ativoV === 0 || /inativ|desativ/i.test(String(ativoV))),
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
  await setCfg("magazord_probe", out);
  return out;
}

/* ---------- importação ---------- */
async function sync(origem: string) {
  const t0 = Date.now(), c = await creds();
  const prodCache = new Map<string, Obj>();
  let pagina = 1, total = 0, semEan = 0; const erros: string[] = [];
  const vistos = new Set<string>();
  for (; pagina <= 80; pagina++) {
    const r = await mz(`/v2/site/produtoDerivacoes?limit=100&page=${pagina}`);
    if (r.status === 401 || r.status === 403) throw new Error(`A Magazord não liberou a rota de variações para este token (erro ${r.status}).`);
    if (r.status >= 400) throw new Error(`A Magazord respondeu erro ${r.status} na página ${pagina}.`);
    const l = listOf(r.body);
    if (!l.length) break;
    const rows = l.map((d: Obj) => mapDeriv(d, prodCache.get(String(d.produtoCodigo ?? d.produto?.codigo ?? "")) || null, c.url)).filter((x) => x.id);
    rows.forEach((x) => { vistos.add(x.id); if (!x.ean) semEan++; });
    const { error } = await sb.from("variacoes").upsert(rows, { onConflict: "id" });
    if (error) { erros.push(error.message); break; }
    total += rows.length;
    if ((r.body as any)?.data?.has_more === false || l.length < 100) break;
  }
  // o que sumiu da Magazord fica inativo (não aparece mais para o vendedor)
  if (total && !erros.length) {
    const { data: todos } = await sb.from("variacoes").select("id").eq("ativo", true);
    const sumiram = (todos || []).map((x) => x.id).filter((id) => !vistos.has(id));
    for (let i = 0; i < sumiram.length; i += 200) await sb.from("variacoes").update({ ativo: false }).in("id", sumiram.slice(i, i + 200));
  }
  const res = erros.length ? "Erro: " + erros[0].slice(0, 80) : semEan ? `${semEan} sem EAN` : "Ok";
  await sb.from("sync_log").insert({ origem, itens: total, res, info: { ms: Date.now() - t0, paginas: pagina, erros } });
  await setCfg("magazord_sync", { last: Date.now(), itens: total, res });
  return { ok: !erros.length, itens: total, semEan, res };
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
      const regras = await getCfg("regras"), ult = await getCfg("magazord_sync");
      const freq = Math.max(5, Number(regras.freq) || 15) * 60e3;
      if (ult.last && Date.now() - ult.last < freq - 30e3) return json({ ok: true, skip: "ainda não" });
      return json(await sync("Automática"));
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
    if (b.action === "sync") return json(await sync("Manual"));
    return json({ error: "Ação inválida." }, 400);
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
