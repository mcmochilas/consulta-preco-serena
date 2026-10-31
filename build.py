"""Gera o app de produção (public/index.html) a partir do protótipo testado,
trocando a API simulada pela Supabase e tirando tudo o que era de demonstração."""
import re, sys
src = open(sys.argv[1]).read()
s = src
def rep(old, new, n=1):
    global s
    c = s.count(old)
    assert c == n, ("ESPERADO %d, ACHEI %d" % (n, c), old[:110])
    s = s.replace(old, new)

# 1) API simulada + barra de teste -> Supabase + camada de dados real
i = s.index('<script>\n/* =====================================================================\n   Consulta de Preço Serena · AMBIENTE DE TESTE')
j = s.index('</script>', i) + len('</script>')
s = s[:i] + '<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js"></script>\n<script src="/api.js"></script>' + s[j:]
rep('<title>Consulta de Preço Serena Teste</title>', '<title>Consulta de Preço · Serena Puxadores</title>')

# 2) imagens reais da Magazord no lugar dos desenhos
i = s.index('/* ---------- desenho das imagens (no lugar das fotos da Magazord) ---------- */')
j = s.index('/* ---------- EAN-13 em SVG')
s = s[:i] + '''/* ---------- fotos da Magazord ---------- */
function img(v, i, mini){
  const u = (v.fotos || [])[i];
  return u ? `<img src="${esc(u)}" alt="${esc((v.titulo || v.nome) + (mini ? "" : ", foto " + (i + 1)))}" loading="${i ? "lazy" : "eager"}" decoding="async" draggable="false">` : "";
}

''' + s[j:]
rep('.car-track svg{width:100%;height:100%;display:block}', '.car-track svg,.car-track img{width:100%;height:100%;display:block}\n.car-track img{object-fit:contain;background:#fff}\n.thumb img{width:100%;height:100%;object-fit:cover;display:block;background:#fff}')
rep('''function miniatura(i){
  const v = api.variacaoInfo(i.varId);
  return `<span class="thumb" aria-hidden="true">${v && v.imagens ? img(v, 0, true) :''', '''function miniatura(i){
  const v = api.variacaoInfo(i.varId), u = i.foto || (v && v.fotos && v.fotos[0]);
  return `<span class="thumb" aria-hidden="true">${u ? `<img src="${esc(u)}" alt="" loading="lazy">` :''')
# PDF: miniatura a partir da foto (passando pelo servidor, que libera a imagem para o PDF)
rep('''function svgPng(svg, px){''', '''async function fotoPng(url, px){
  if(!url) return null;
  try{
    const r = await fetch(api.fnUrl + "/magazord?img=" + encodeURIComponent(url)); if(!r.ok) return null;
    const bmp = await createImageBitmap(await r.blob());
    const c = document.createElement("canvas"); c.width = c.height = px; const x = c.getContext("2d");
    x.fillStyle = "#FFFFFF"; x.fillRect(0, 0, px, px);
    const k = Math.min(px / bmp.width, px / bmp.height), w = bmp.width * k, h = bmp.height * k;
    x.drawImage(bmp, (px - w) / 2, (px - h) / 2, w, h);
    return c.toDataURL("image/jpeg", 0.85);
  }catch(e){ return null; }
}
function svgPng(svg, px){''')
rep('''thumbs[i.varId] = v && v.imagens ? await svgPng(img(v, 0, true), 160) : null; }''', '''thumbs[i.varId] = await fotoPng(i.foto || (v && v.fotos && v.fotos[0]), 200); }''')
rep('''if(th) doc.addImage(th, "PNG",''', '''if(th) doc.addImage(th, "JPEG",''')

# 3) títulos que vêm prontos da Magazord
rep('''const tituloItem = i => `${i.nome.replace(" (exemplo)", "")} ${i.cor} ${i.tam}`;''', '''const tituloItem = i => i.titulo || [i.nome, i.cor, i.tam].filter(Boolean).join(" ");''')
rep('''          <h1>${esc(v.nome)}</h1>
          <span style="font-size:15px;color:var(--ink2);font-weight:500">${esc(v.cor)} · ${esc(v.tam)}</span>''', '''          <h1>${esc(v.titulo)}</h1>
          ${v.cor || v.tam ? `<span style="font-size:15px;color:var(--ink2);font-weight:500">${esc([v.cor, v.tam].filter(Boolean).join(" · "))}</span>` : ""}''')
rep('''rec.unshift({ id:v.id, nome:v.nome,''', '''rec.unshift({ id:v.id, nome:v.titulo,''')
rep('''  const nome = v => v.nome.replace(" (exemplo)", "").replace("Puxador ", "") + " · " + v.cor + " " + v.tam;''', '''  const nome = v => v.titulo;''')
rep('''          <td style="font-weight:600">${esc(v.nome)}</td>
          <td><span style="display:inline-flex;align-items:center;gap:8px"><span class="sw" style="width:14px;height:14px;background:${esc(v.hex)}"></span>${esc(v.cor)} · ${esc(v.tam)}</span></td>''', '''          <td style="font-weight:600">${esc(v.titulo)}</td>
          <td>${v.cor || v.tam ? `<span style="display:inline-flex;align-items:center;gap:8px"><span class="sw" style="width:14px;height:14px;background:${esc(v.hex)}"></span>${esc([v.cor, v.tam].filter(Boolean).join(" · "))}</span>` : `<span class="muted">—</span>`}</td>''')
rep('''(v.nome+" "+v.sku+" "+v.ean+" "+v.cor+" "+v.tam)''', '''(v.titulo+" "+v.sku+" "+v.ean+" "+v.cor+" "+v.tam)''')
rep('''<th>Produto</th><th>Variação</th><th>SKU</th><th>EAN</th>''', '''<th>Produto</th><th>Cor · tamanho</th><th>SKU</th><th>EAN</th>''')

# 4) textos de demonstração
rep('''    <p class="hint">Teste: <b>carla</b> / 1234 (vendedor) ou <b>admin</b> / 0000.</p>
''', '')
rep('''O celular do vendedor nunca recebe a chave da Magazord. No teste, qualquer valor preenchido "conecta".''', '''O celular do vendedor nunca recebe a chave da Magazord. Para trocar o token, preencha usuário e senha de novo.''')
rep('''toast("Sincronizado · " + r.mudancas + " estoques atualizados")''', '''toast(r.ok ? "Sincronizado · " + r.itens + " variações" : "Sincronização com erro: " + r.res)''')
rep('''Na produção, o vendedor recebe um link para instalar o app no celular.''', '''Depois de criar, envie ao vendedor o endereço do app, o usuário e o PIN.''')
rep('''<p class="hint">Etiqueta de 30 × 20 mm, só com o código de barras''', '''<p class="hint">Etiqueta de 30 × 20 mm, só com o código de barras''')

# 5) login de produção + primeiro acesso (cria o administrador)
rep('''function renderLogin(err){''', '''function renderLogin(err){
  if(S.semAdmin) return renderPrimeiroAcesso(err);''')
rep('''/* =====================================================================
   VENDEDOR (celular)''', '''function renderPrimeiroAcesso(err){
  $("#app").innerHTML = `<div class="lg"><form class="lg-card" id="paForm">
    <img class="lg-brand" src="${LOGO.claro}" alt="Serena Puxadores">
    <span class="lg-sub">Primeiro acesso</span>
    <p class="hint" style="text-align:center">Crie o administrador do sistema. Depois, pelo painel, você cadastra os vendedores.</p>
    ${err ? `<div class="err" role="alert">${esc(err)}</div>` : ""}
    <div class="fld"><label for="paN">Seu nome</label><input class="inp" id="paN" required autocomplete="name"></div>
    <div class="fld"><label for="paU">Usuário</label><input class="inp" id="paU" required autocapitalize="none" autocomplete="username" placeholder="ex.: admin"></div>
    <div class="row2" style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px">
      <div class="fld"><label for="paP">PIN (4 números)</label><input class="inp" id="paP" type="password" inputmode="numeric" maxlength="4" required autocomplete="new-password"></div>
      <div class="fld"><label for="paP2">Repita o PIN</label><input class="inp" id="paP2" type="password" inputmode="numeric" maxlength="4" required autocomplete="new-password"></div>
    </div>
    <button class="btn btn-dark" type="submit" style="height:50px">Criar e entrar</button>
  </form></div>`;
  $("#paForm").onsubmit = async e => {
    e.preventDefault();
    if($("#paP").value !== $("#paP2").value) return renderPrimeiroAcesso("Os dois PINs estão diferentes.");
    const b = e.target.querySelector("button"); b.disabled = true; b.textContent = "Criando…";
    try{ await api.criarAdmin({ name:$("#paN").value.trim(), login:$("#paU").value, pin:$("#paP").value.trim() }); S.semAdmin = false; tocaSomSerena(); render(); }
    catch(x){ renderPrimeiroAcesso(x.message); }
  };
}

/* =====================================================================
   VENDEDOR (celular)''')
rep('''    try{ await api.login($("#lgU").value, $("#lgP").value); tocaSomSerena(); render(); }''', '''    try{ await api.login($("#lgU").value, $("#lgP").value); tocaSomSerena(); A.pg = {}; render(); }''')

# 6) admin: recarrega os dados ao trocar de aba; trocar PIN do vendedor
rep('''    case "tab": S.adminTab = el.dataset.t; store.set("cp-admin-tab", S.adminTab); A.testMsg = null; renderAdmin(); break;''', '''    case "tab": S.adminTab = el.dataset.t; store.set("cp-admin-tab", S.adminTab); A.testMsg = null; await api.recarregar().catch(() => {}); renderAdmin(); break;''')
rep('''<th class="r">Consultas (7 dias)</th><th>Acesso</th></tr></thead>''', '''<th class="r">Consultas (7 dias)</th><th>PIN</th><th>Acesso</th></tr></thead>''')
rep('''          <td><button class="switch" role="switch" aria-checked="${!!u.active}" aria-label="Acesso de ${esc(u.name)}"''', '''          <td><button class="btn btn-sm" data-act="u-pin" data-id="${u.id}">Trocar PIN</button></td>
          <td><button class="switch" role="switch" aria-checked="${!!u.active}" aria-label="Acesso de ${esc(u.name)}"''')
rep('''    case "novo-vend": modalNovoVend(); break;''', '''    case "novo-vend": modalNovoVend(); break;
    case "u-pin": modalPin(el.dataset.id); break;''')
rep('''function modalNovoVend(err){''', '''function modalPin(id, err){
  const u = api.usuarios().find(x => x.id === id); if(!u) return;
  modal(`<h2>Novo PIN · ${esc(u.name)}</h2>
    ${err ? `<div class="err" role="alert">${esc(err)}</div>` : ""}
    <form id="fPin" style="display:flex;flex-direction:column;gap:14px">
      <div class="fld"><label for="npP">Novo PIN (4 números)</label><input class="inp" id="npP" inputmode="numeric" maxlength="4" required autocomplete="off"></div>
      <div class="dlg-act"><button class="btn" type="button" data-act="close">Cancelar</button><button class="btn btn-dark" type="submit">Salvar PIN</button></div>
    </form>`);
  $("#fPin").onsubmit = async e => { e.preventDefault();
    try{ await api.trocarPin(id, $("#npP").value.trim()); closeModal(); toast("PIN de " + u.name.split(" ")[0] + " trocado"); }
    catch(x){ modalPin(id, x.message); } };
}
function modalNovoVend(err){''')

# 7) pré-pedido salvo no celular aparece no computador na hora
rep('''
render();
</script>''', '''
window.addEventListener("cp-pre-mudou", ev => {
  if($("#modal").innerHTML || (typeof DR !== "undefined" && DR.on)) return;
  if(S.me && S.me.role === "admin" && !S.asVendedor && S.adminTab === "pre") return renderAdmin();
  if(V.screen === "pre") return renderPreList();
  if(V.screen === "preDet" && ev.detail === V.preId && !document.activeElement?.matches("input")) return renderPreDet();
});

/* ---------- início ---------- */
$("#app").innerHTML = `<div class="lg"><img src="${LOGO.escuro}" alt="Serena Puxadores" style="width:200px;opacity:.9"></div>`;
api.init().then(async () => {
  if(!api.me()){ try{ S.semAdmin = !(await api.temAdmin()); }catch(e){ S.semAdmin = false; } }
  render();
}).catch(() => render());
</script>''')
open(sys.argv[2], "w").write(s)
print("ok", len(s))
