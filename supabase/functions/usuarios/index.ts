// Consulta de Preço Serena · usuários (login com usuário + PIN)
//  Público:  {action:"status"}                         -> se já existe administrador
//            {action:"bootstrap", name, login, pin}     -> cria o primeiro administrador (só quando não há nenhum)
//  Logado:   {action:"touch", device}                   -> registra o último acesso
//  Admin:    {action:"create", name, login, pin, role}  -> cria vendedor (ou admin)
//            {action:"update", id, name?, pin?, active?}
import { createClient } from "npm:@supabase/supabase-js@2.117.3";

const URL_ = Deno.env.get("SUPABASE_URL")!;
let KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
if (!KEY) { try { KEY = Object.values(JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}"))[0] as string; } catch { /* */ } }
const sb = createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

// o mesmo formato é usado no app para entrar
export const emailDe = (login: string) => `${login}@consulta-serena.app`;
export const senhaDe = (login: string, pin: string) => `cp-${pin}-${login}`;
const LOGIN = /^[a-z0-9._-]{2,30}$/;

async function quem(req: Request) {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const { data: u } = await sb.auth.getUser(token);
  if (!u?.user) return null;
  const { data: p } = await sb.from("profiles").select("*").eq("id", u.user.id).maybeSingle();
  return p && p.active ? p : null;
}
async function temAdmin() {
  const { count } = await sb.from("profiles").select("id", { count: "exact", head: true }).eq("role", "admin");
  return (count || 0) > 0;
}
async function criar(name: string, login: string, pin: string, role: "admin" | "vendedor") {
  login = String(login || "").trim().toLowerCase();
  name = String(name || "").trim();
  pin = String(pin || "").trim();
  if (!name) throw new Error("Informe o nome.");
  if (!LOGIN.test(login)) throw new Error("Usuário inválido: use letras minúsculas, números, ponto ou traço (2 a 30).");
  if (!/^\d{4}$/.test(pin)) throw new Error("O PIN precisa ter 4 números.");
  const { data: ja } = await sb.from("profiles").select("id").eq("login", login).maybeSingle();
  if (ja) throw new Error("Esse usuário já existe.");
  const { data, error } = await sb.auth.admin.createUser({ email: emailDe(login), password: senhaDe(login, pin), email_confirm: true, user_metadata: { name } });
  if (error) throw new Error(error.message);
  const { error: e2 } = await sb.from("profiles").insert({ id: data.user.id, name, login, role, active: true });
  if (e2) { await sb.auth.admin.deleteUser(data.user.id); throw new Error(e2.message); }
  return data.user.id;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const b = await req.json().catch(() => ({}));
    if (b.action === "status") return json({ hasAdmin: await temAdmin() });
    if (b.action === "bootstrap") {
      if (await temAdmin()) return json({ error: "O administrador já foi criado." }, 403);
      const id = await criar(b.name, b.login, b.pin, "admin");
      return json({ ok: true, id });
    }
    const me = await quem(req);
    if (!me) return json({ error: "Entre de novo para continuar." }, 401);
    if (b.action === "touch") {
      await sb.from("profiles").update({ last_at: new Date().toISOString(), device: String(b.device || "").slice(0, 60) }).eq("id", me.id);
      return json({ ok: true });
    }
    if (me.role !== "admin") return json({ error: "Só o administrador pode fazer isso." }, 403);
    if (b.action === "create") {
      const id = await criar(b.name, b.login, b.pin, b.role === "admin" ? "admin" : "vendedor");
      return json({ ok: true, id });
    }
    if (b.action === "update") {
      const { data: alvo } = await sb.from("profiles").select("*").eq("id", b.id).maybeSingle();
      if (!alvo) return json({ error: "Usuário não encontrado." }, 404);
      const patch: Record<string, unknown> = {};
      if (typeof b.name === "string" && b.name.trim()) patch.name = b.name.trim();
      if (typeof b.active === "boolean") {
        if (alvo.id === me.id && !b.active) return json({ error: "Você não pode desativar o seu próprio acesso." }, 400);
        patch.active = b.active;
      }
      if (b.pin !== undefined) {
        if (!/^\d{4}$/.test(String(b.pin))) return json({ error: "O PIN precisa ter 4 números." }, 400);
        const { error } = await sb.auth.admin.updateUserById(alvo.id, { password: senhaDe(alvo.login, String(b.pin)) });
        if (error) throw new Error(error.message);
      }
      if (Object.keys(patch).length) { const { error } = await sb.from("profiles").update(patch).eq("id", alvo.id); if (error) throw error; }
      return json({ ok: true });
    }
    return json({ error: "Ação inválida." }, 400);
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 400);
  }
});
