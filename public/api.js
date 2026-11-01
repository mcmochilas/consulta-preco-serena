/* =====================================================================
   Consulta de Preço Serena · camada de dados (produção)
   Supabase: login com usuário + PIN, variações vindas da Magazord,
   pré-pedidos, leituras e regras. A tela usa só window.cpApi.
   ===================================================================== */
(function(){
  const SUPA_URL = "https://djeacwsykycxusyvahgi.supabase.co";
  const SUPA_KEY = "sb_publishable_4Np4Ux2AOX2-8goXdFpGvg_E1kkCAPB";
  const FN = SUPA_URL + "/functions/v1";
  const sb = window.supabase.createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: true, autoRefreshToken: true, storageKey: "cp-serena-auth" } });
  const emailDe = l => `${l}@consulta-serena.app`, senhaDe = (l, p) => `cp-${p}-${l}`;
  const clone = o => JSON.parse(JSON.stringify(o));
  const ms = t => t ? Date.parse(t) : null;

  /* ---------- cores das bolinhas a partir do nome do acabamento ---------- */
  const CORES = [[/preto|black|onix|ônix/i,"#1E1E1E"],[/grafite|chumbo|titanio|titânio/i,"#4A4C50"],[/champagne|champanhe/i,"#C7B083"],[/rose|rosé|cobre/i,"#B87862"],
    [/bronze|ouro velho|envelhecid|cafe|café|marrom/i,"#6B4B2F"],[/dourad|ouro|gold|lat[aã]o/i,"#C9A35A"],[/inox|prata|cromad|niquel|níquel|aço|aluminio|alumínio|escovad|acetinad/i,"#B8BBBE"],
    [/branc|white|off/i,"#ECEBE7"],[/verde/i,"#5E7461"],[/azul/i,"#3E5C7A"],[/cinza/i,"#9A9DA1"]];
  const hexDe = cor => (CORES.find(([re]) => re.test(cor || "")) || [0, "#C9C6BE"])[1];
  const numTam = t => { const m = String(t || "").replace(",", ".").match(/[\d.]+/); return m ? parseFloat(m[0]) * (/\bm\b|metro/i.test(t) && !/mm/i.test(t) ? 1000 : 1) : 1e9; };

  /* ---------- modelo, cor e tamanho a partir do título ----------
     Na Magazord cada acabamento/medida costuma ser um anúncio separado (pai + filho).
     O banco calcula o modelo pelo título (coluna "modelo", ex.: "Puxador Concha Shell 64mm Gold" -> Shell)
     e a tela agrupa por ele. Cor e tamanho saem do título quando a derivação vem como "Único". */
  const COR_PALAVRA = /^(pret[oa]|dourad[oa]|gold|n[ií]quel|cromad[oa]|cromo|ros[eé]|rosa|bronze|branc[oa]|escovad[oa]|[oô]nix|grafite|cobre|[aâ]mbar|menta|antique|fosc[oa]|acetinad[oa]|ouro|inox|champagne|prata|tit[aâ]nio|verde|azul|cinza|nude|vecchio|vechio|bege|marrom|azal[eé]ia|a[cç]o|matte|polido|opaco|lat[aã]o|vermelh[oa]|amarel[oa]|natural|madeira|couro|chumbo|caramelo|off|baby|velho|real|vintage|grafit|mettalo|metalo)$/i;
  const MEDIDA = /^(\d+([.,]\d+)?(mm|cm)|\d+x\d+(mm)?)$/i, LETRA = /^(pp|p|m|g|gg|mini)$/i, CODIGO = /^((il|zp|ba|df)[\d.]+[a-z]?|\d+)$/i;
  // a Magazord manda "Nome do produto - Marca - Tamanho": na tela fica só o nome
  const nomeLimpo = t => String(t || "").split(/\s+-\s*|\s*-\s+/)[0].replace(/\s{2,}/g, " ").trim();
  const toksDe = t => String(t || "").split(" - ")[0].replace(/[()]/g, " ").split(/\s+/).filter(Boolean);
  function tamDoTitulo(r){
    const tk = toksDe(r.titulo || r.produto_nome);
    const med = tk.find(x => MEDIDA.test(x)); if(med) return med.toUpperCase();
    const der = String(r.tamanho || "").trim(); if(der && !/^(único|unico|ponto|u)$/i.test(der)) return der.toUpperCase();
    const l = tk.find(x => LETRA.test(x)); if(l) return l.toUpperCase();
    return /\bponto\b/i.test(r.titulo || "") || /^ponto$/i.test(der) ? "Ponto" : "";
  }
  function corDoTitulo(r){
    if(r.cor && !/^(único|unico)$/i.test(r.cor)) return r.cor;
    const tk = toksDe(r.titulo || r.produto_nome), i = tk.findIndex(x => COR_PALAVRA.test(x));
    if(i < 0) return "";
    return tk.slice(i).filter(x => !CODIGO.test(x) && !MEDIDA.test(x) && !LETRA.test(x)).join(" ").replace(/^\w/, c => c.toUpperCase());
  }

  /* ---------- estado em memória (a tela lê daqui sem esperar) ---------- */
  const C = { me:null, regras:{ baixo:5, semEstoque:true, promo:true, freq:"15" }, mz:{}, pre:new Map(), perfis:new Map(), consultas:[], aliases:{}, hist:[], vars:new Map(), prods:null };

  function view(r, tams){
    const cor = corDoTitulo(r);
    const v = { id:r.id, prod:r.modelo || r.produto_id, modelo:r.modelo || "", nome:nomeLimpo(r.produto_nome || r.titulo), titulo:nomeLimpo(r.titulo || r.produto_nome), tituloMz:r.titulo || r.produto_nome || "", linha:r.linha || "",
      cor, tam:tamDoTitulo(r), sku:r.sku || r.id, ean:r.ean || "", hex:hexDe(cor || r.titulo),
      preco:{ varejo:Number(r.preco) || 0, promo: r.preco_promo != null && Number(r.preco_promo) > 0 && Number(r.preco_promo) < Number(r.preco) ? Number(r.preco_promo) : null },
      estoque:{ cd:Number(r.estoque) || 0 }, total:Number(r.estoque) || 0, fotos:Array.isArray(r.imagens) ? r.imagens : [], ti:0, nTams:1 };
    v.imagens = v.fotos.length;
    if(tams){ v.ti = Math.max(0, tams.indexOf(v.tam)); v.nTams = tams.length; }
    C.vars.set(v.id, v);
    return v;
  }
  const tamsDe = rows => [...new Set(rows.map(tamDoTitulo))].sort((a, b) => numTam(a) - numTam(b) || a.localeCompare(b));
  function preRow(r){
    const p = { id:r.id, num:r.num, user:r.user_id, cliente:r.cliente, telefone:r.telefone || "", obs:r.obs || "", status:r.status, ambientes:r.ambientes || [],
      itens:Array.isArray(r.itens) ? r.itens : [], erpNum:r.erp_num || "", createdAt:ms(r.created_at), updatedAt:ms(r.updated_at) };
    C.pre.set(p.id, p); return p;
  }
  const nomeDe = id => (C.perfis.get(id) || (C.me && C.me.id === id ? C.me : null) || {}).name || "—";
  const comVend = p => ({ ...clone(p), vendedor:nomeDe(p.user) });
  async function fn(nome, body){
    const { data:s } = await sb.auth.getSession();
    const r = await fetch(`${FN}/${nome}`, { method:"POST", headers:{ "Content-Type":"application/json", apikey:SUPA_KEY, ...(s.session ? { Authorization:"Bearer " + s.session.access_token } : {}) }, body:JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if(!r.ok || j.error) throw new Error(j.error || "Falha de comunicação (" + r.status + ").");
    return j;
  }
  const ok = ({ data, error }) => { if(error) throw new Error(error.message); return data; };

  async function irmaosDe(r){
    const q = sb.from("variacoes").select("titulo,produto_nome,tamanho").eq("ativo", true).limit(500);
    return ok(await (r.modelo ? q.eq("modelo", r.modelo) : q.eq("produto_id", r.produto_id)));
  }
  async function carregar(){
    const adm = C.me.role === "admin";
    const jobs = [
      sb.from("config").select("id,data").then(ok).then(rows => { rows.forEach(x => { if(x.id === "regras") C.regras = { ...C.regras, ...x.data }; if(x.id === "magazord_sync") C.mz.sync = x.data; }); }),
      sb.from("prepedidos").select("*").order("created_at", { ascending:false }).limit(1000).then(ok).then(rows => { C.pre.clear(); rows.forEach(preRow); }),
      sb.from("aliases").select("ean,var_id").then(ok).then(rows => { C.aliases = Object.fromEntries(rows.map(x => [x.ean, x.var_id])); })
    ];
    if(adm) jobs.push(
      sb.from("profiles").select("*").order("name").then(ok).then(rows => { C.perfis.clear(); rows.forEach(x => C.perfis.set(x.id, x)); }),
      sb.from("consultas").select("at,user_id,ean,var_id,preco,estoque").order("at", { ascending:false }).limit(1000).then(ok).then(rows => { C.consultas = rows.map(x => ({ at:ms(x.at), user:x.user_id, ean:x.ean, varId:x.var_id, preco:x.preco == null ? null : Number(x.preco), estoque:x.estoque == null ? null : Number(x.estoque) })); }),
      sb.from("sync_log").select("*").order("at", { ascending:false }).limit(60).then(ok).then(rows => { C.hist = rows.map(x => ({ at:ms(x.at), origem:x.origem, itens:x.itens, res:x.res })); }),
      fn("magazord", { action:"status" }).then(s => { C.mz = { ...C.mz, ...s }; }).catch(() => {})
    );
    await Promise.all(jobs);
  }
  let canal = null;
  function tempoReal(){
    if(canal) return;
    canal = sb.channel("prepedidos").on("postgres_changes", { event:"*", schema:"public", table:"prepedidos" }, ev => {
      if(ev.eventType === "DELETE") C.pre.delete(ev.old.id); else preRow(ev.new);
      window.dispatchEvent(new CustomEvent("cp-pre-mudou", { detail:ev.new && ev.new.id }));
    }).subscribe();
  }
  async function entrou(user){
    const p = ok(await sb.from("profiles").select("*").eq("id", user.id).maybeSingle());
    if(!p || !p.active){ await sb.auth.signOut(); throw new Error(p ? "Acesso desativado. Fale com o administrador." : "Usuário sem cadastro no app."); }
    C.me = { id:p.id, name:p.name, login:p.login, role:p.role, active:p.active };
    await carregar(); tempoReal();
    fn("usuarios", { action:"touch", device:aparelho() }).catch(() => {});
  }
  function aparelho(){
    const u = navigator.userAgent;
    return /iPhone/.test(u) ? "iPhone" : /iPad/.test(u) ? "iPad" : /Android/.test(u) ? (u.match(/Android[^;]*;\s*([^;)]+)/) || [0, "Android"])[1].replace(/Build.*/, "").trim().slice(0, 40) : /Windows/.test(u) ? "Computador (Windows)" : /Mac/.test(u) ? "Computador (Mac)" : "Navegador";
  }

  /* ---------- mexer num pré-pedido (estado local + gravação) ---------- */
  const getPre = id => { const p = C.pre.get(id); if(!p) throw new Error("Pré-pedido não encontrado."); return p; };
  const editavel = p => { if(p.status === "lancado" || p.status === "cancelado") throw new Error("Este pré-pedido já foi encerrado."); };
  async function gravaPre(p, campos){
    const patch = {}; campos.forEach(k => patch[{ erpNum:"erp_num" }[k] || k] = p[k]);
    const r = ok(await sb.from("prepedidos").update(patch).eq("id", p.id).select().single());
    return clone(preRow(r));
  }
  function juntaItens(p, de, para){
    p.itens.filter(i => i.amb === de).forEach(it => {
      const nk = it.varId + "|" + para, dest = p.itens.find(i => i.key === nk);
      if(dest && dest !== it){ dest.qtd += it.qtd; it.qtd = 0; } else { it.amb = para; it.key = nk; }
    });
    p.itens = p.itens.filter(i => i.qtd > 0);
  }

  window.cpApi = {
    test:false, fnUrl:FN,
    async init(){
      const { data } = await sb.auth.getSession();
      if(data.session){ try{ await entrou(data.session.user); }catch(e){ C.me = null; } }
      return C.me;
    },
    me(){ return C.me ? clone(C.me) : null; },
    async temAdmin(){ return (await fn("usuarios", { action:"status" })).hasAdmin; },
    async criarAdmin({ name, login, pin }){ await fn("usuarios", { action:"bootstrap", name, login, pin }); return this.login(login, pin); },
    async login(login, pin){
      login = String(login || "").trim().toLowerCase(); pin = String(pin || "").trim();
      const { data, error } = await sb.auth.signInWithPassword({ email:emailDe(login), password:senhaDe(login, pin) });
      if(error) throw new Error(/invalid/i.test(error.message) ? "Usuário ou PIN incorretos." : /rate|many/i.test(error.message) ? "Muitas tentativas. Aguarde alguns minutos." : error.message);
      await entrou(data.user);
      return clone(C.me);
    },
    logout(){ sb.auth.signOut(); C.me = null; if(canal){ sb.removeChannel(canal); canal = null; } },
    async recarregar(){ if(C.me) await carregar(); },
    config(){
      return { ...C.regras, tabela:"varejo", dep:{ loja:false, cd:true }, separar:false,
        api:{ url:C.mz.url || "", user:C.mz.token || "", pass:C.mz.senha ? "••••••••" : "", ok:!!C.mz.configured }, webhook:C.mz.webhook || "" };
    },
    async salvarConfig(patch){
      const novo = { ...C.regras };
      ["baixo","semEstoque","promo","freq"].forEach(k => { if(k in patch) novo[k] = patch[k]; });
      ok(await sb.from("config").update({ data:novo, updated_at:new Date().toISOString() }).eq("id", "regras"));
      C.regras = novo; return this.config();
    },

    /* ---------- leitura no showroom ---------- */
    async buscarEAN(ean){
      ean = String(ean).replace(/\D/g, "");
      const cands = [...new Set([ean, ean.replace(/^0+/, ""), ean.length < 13 ? ean.padStart(13, "0") : ean])].filter(Boolean);
      let r = (ok(await sb.from("variacoes").select("*").in("ean", cands).eq("ativo", true).limit(1)) || [])[0];
      if(!r && C.aliases[ean]) r = ok(await sb.from("variacoes").select("*").eq("id", C.aliases[ean]).maybeSingle());
      if(!r){ const a = ok(await sb.from("aliases").select("var_id").eq("ean", ean).maybeSingle()); if(a) r = ok(await sb.from("variacoes").select("*").eq("id", a.var_id).maybeSingle()); }
      sb.from("consultas").insert({ user_id:C.me.id, ean, var_id:r ? r.id : null, preco:r ? r.preco : null, estoque:r ? Math.max(0, Number(r.estoque) || 0) : null }).then(() => {});
      if(!r) return null;
      return view(r, tamsDe(await irmaosDe(r)));
    },
    async variacao(id){ const r = ok(await sb.from("variacoes").select("*").eq("id", id).maybeSingle()); if(!r) return null; return view(r, tamsDe(await irmaosDe(r))); },
    // todas as variações do mesmo modelo (agrupadas pelo nome do modelo no título)
    async variacoesDe(chave){
      let rows = ok(await sb.from("variacoes").select("*").eq("modelo", chave).eq("ativo", true).limit(500));
      if(!rows.length) rows = ok(await sb.from("variacoes").select("*").eq("produto_id", chave).eq("ativo", true));
      const t = tamsDe(rows); return rows.map(r => view(r, t));
    },
    // admin: corrige o modelo de algumas variações (vazio = volta ao automático pelo título)
    async definirModelo(ids, modelo){ const n = ok(await sb.rpc("definir_modelo", { p_ids:ids, p_modelo:modelo || "" })); C.prods = null; return n; },
    variacaoInfo(id){ return C.vars.get(id) || null; },

    /* ---------- admin: produtos e EANs ---------- */
    async produtos(force){
      if(C.prods && !force) return C.prods;
      const all = []; for(let from = 0; ; from += 1000){ const rows = ok(await sb.from("variacoes").select("*").eq("ativo", true).order("titulo").range(from, from + 999)); all.push(...rows); if(rows.length < 1000) break; }
      const porProd = {}; all.forEach(r => (porProd[r.modelo || r.produto_id] ||= []).push(r));
      C.prods = all.map(r => { const v = view(r, tamsDe(porProd[r.modelo || r.produto_id])); const al = Object.entries(C.aliases).filter(([, id]) => id === v.id).map(([e]) => e); if(!v.ean && al[0]){ v.ean = al[0]; v.eanLocal = true; } return v; });
      return C.prods;
    },
    async definirEAN(varId, ean){
      ean = String(ean || "").replace(/\D/g, "");
      if(!/^\d{8,14}$/.test(ean)) throw new Error("EAN inválido.");
      const dono = (C.prods || []).find(v => v.ean === ean && v.id !== varId); if(dono) throw new Error("Esse EAN já está em " + dono.sku + ".");
      ok(await sb.from("aliases").upsert({ ean, var_id:varId }, { onConflict:"ean" }));
      C.aliases[ean] = varId; C.prods = null; return true;
    },
    async vincular(ean, varId){ ok(await sb.from("aliases").upsert({ ean, var_id:varId }, { onConflict:"ean" })); C.aliases[ean] = varId; return true; },
    produtosCache(){ return C.prods; },
    nomeLimpo,
    resolvidos(){ return clone(C.aliases); },
    consultas(){ return clone(C.consultas); },
    sync(){ return { last:(C.mz.sync && C.mz.sync.last) || null, hist:clone(C.hist) }; },
    async testarConexao(cred){
      if(cred && cred.url && cred.user && cred.pass && !/^•+$/.test(cred.pass)) await fn("magazord", { action:"config", url:cred.url, token:cred.user, senha:cred.pass });
      else if(cred && cred.url && !C.mz.configured) return { ok:false, msg:"Preencha URL, usuário (token) e senha." };
      const r = await fn("magazord", { action:"test" });
      Object.assign(C.mz, await fn("magazord", { action:"status" }));
      return { ok:r.ok, msg:r.ok ? `Conexão ok. Liberadas: ${r.liberadas.join(", ")}.${r.bloqueadas.length ? " Bloqueadas: " + r.bloqueadas.join(", ") + "." : ""}` : "A Magazord recusou: " + r.bloqueadas.join(", ") };
    },
    async sincronizar(){ const r = await fn("magazord", { action:"sync" }); C.prods = null; await carregar(); return { mudancas:r.itens, ...r }; },

    /* ---------- admin: vendedores ---------- */
    usuarios(){ return [...C.perfis.values()].map(u => ({ id:u.id, name:u.name, login:u.login, role:u.role, active:u.active, device:u.device || "—", lastAt:ms(u.last_at), prof:false })); },
    async criarVendedor({ name, login, pin }){ const r = await fn("usuarios", { action:"create", name, login, pin, role:"vendedor" }); await carregar(); return r.id; },
    async salvarUsuario(id, patch){ await fn("usuarios", { action:"update", id, ...patch }); const u = C.perfis.get(id); if(u) Object.assign(u, patch); return true; },
    async trocarPin(id, pin){ await fn("usuarios", { action:"update", id, pin }); return true; },

    /* ---------- pré-pedidos ---------- */
    prepedidos(){ return [...C.pre.values()].sort((a, b) => b.updatedAt - a.updatedAt).map(comVend); },
    prepedido(id){ const p = C.pre.get(id); return p ? comVend(p) : null; },
    async criarPre({ cliente, telefone, obs }){
      if(!String(cliente || "").trim()) throw new Error("Informe o nome do cliente.");
      const r = ok(await sb.from("prepedidos").insert({ user_id:C.me.id, cliente:String(cliente).trim(), telefone:String(telefone || "").trim(), obs:String(obs || "").trim() }).select().single());
      return comVend(preRow(r));
    },
    async addItem(id, varId, qtd, preco, amb){
      const p = getPre(id); editavel(p);
      amb = String(amb || "").trim();
      if(amb && !p.ambientes.includes(amb)) p.ambientes = [...p.ambientes, amb];
      const v = C.vars.get(varId) || {}, key = varId + "|" + amb, ex = p.itens.find(i => i.key === key);
      if(ex) ex.qtd += qtd;
      else p.itens = [...p.itens, { key, varId, amb, sku:v.sku, ean:v.ean, nome:v.nome, titulo:v.titulo, cor:v.cor, tam:v.tam, hex:v.hex, foto:(v.fotos || [])[0] || "", qtd, preco }];
      if(p.status === "finalizado") p.status = "aberto";
      return gravaPre(p, ["itens","ambientes","status"]);
    },
    async setQtd(id, key, qtd){
      const p = getPre(id); editavel(p);
      if(qtd <= 0) p.itens = p.itens.filter(i => i.key !== key); else p.itens.find(i => i.key === key).qtd = qtd;
      return gravaPre(p, ["itens"]);
    },
    async addAmbiente(id, nome){
      const p = getPre(id); editavel(p); nome = String(nome || "").trim(); if(!nome) throw new Error("Dê um nome ao ambiente.");
      if(!p.ambientes.includes(nome)) p.ambientes = [...p.ambientes, nome];
      return gravaPre(p, ["ambientes"]);
    },
    async renomearAmbiente(id, antigo, nome){
      const p = getPre(id); editavel(p); nome = String(nome || "").trim(); if(!nome) throw new Error("Dê um nome ao ambiente.");
      if(nome === antigo) return clone(p);
      const junta = p.ambientes.includes(nome);
      p.ambientes = junta ? p.ambientes.filter(a => a !== antigo) : p.ambientes.map(a => a === antigo ? nome : a);
      juntaItens(p, antigo, nome);
      return gravaPre(p, ["itens","ambientes"]);
    },
    async moverTodos(id, antigo, destino){
      const p = getPre(id); editavel(p); destino = String(destino || "").trim();
      if(destino === antigo) return clone(p);
      juntaItens(p, antigo, destino);
      p.ambientes = p.ambientes.filter(a => a !== antigo);
      if(destino && !p.ambientes.includes(destino)) p.ambientes = [...p.ambientes, destino];
      return gravaPre(p, ["itens","ambientes"]);
    },
    async moverItem(id, key, amb){
      const p = getPre(id); editavel(p); amb = String(amb || "").trim();
      const it = p.itens.find(i => i.key === key); if(!it) return clone(p);
      const nk = it.varId + "|" + amb, dest = p.itens.find(i => i.key === nk);
      if(dest && dest !== it){ dest.qtd += it.qtd; p.itens = p.itens.filter(i => i !== it); } else { it.amb = amb; it.key = nk; }
      return gravaPre(p, ["itens"]);
    },
    async setPre(id, patch){
      const p = getPre(id);
      if(patch.status === "finalizado" && !p.itens.length) throw new Error("Adicione pelo menos um item antes de finalizar.");
      if(patch.status === "lancado" && !String(patch.erpNum || "").trim()) throw new Error("Informe o número do pedido no ERP.");
      const campos = Object.keys(patch).filter(k => ["cliente","telefone","obs","status","erpNum"].includes(k));
      campos.forEach(k => p[k] = patch[k]);
      return gravaPre(p, campos);
    }
  };
})();
