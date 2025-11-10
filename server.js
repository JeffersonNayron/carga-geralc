// server.js - Sistema de Revezamento (Better SQLite3 + Luxon + Snapshot diário)
// Incrementado: snapshot/historico diário; endpoints /historico e melhorias no /relatorio/:data

const TOKEN_FIXO = "vale@75d05"; // Token fixo para redefinir senha
const express = require("express");
const session = require("express-session");
const path = require("path");
const bcrypt = require("bcrypt");
const Database = require("better-sqlite3");
const { DateTime } = require("luxon");

const app = express();
const PORT = process.env.PORT || 3000;

// --- Middlewares ---
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: "revezamento_secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      sameSite: "lax",
      maxAge: 1000 * 60 * 60 * 24 * 365, // 1 ano
      secure: false, // true se usar HTTPS
    },
  })
);

// --- Banco de Dados ---
const db = new Database("./database.db");

// --- Função: agora em America/Sao_Paulo (Brasília) ---
function agoraBrasilia() {
  return DateTime.now().setZone("America/Sao_Paulo");
}

// --- Criação de tabelas básicas (mantendo compatibilidade) ---
db.prepare(
  `CREATE TABLE IF NOT EXISTS pessoas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT,
    local TEXT,
    status TEXT DEFAULT '🔴',
    liberado TEXT DEFAULT NULL,
    hora_inicial TEXT,
    hora_final TEXT,
    retorno TEXT,
    mensagem TEXT,
    justificativa TEXT,
    hora_inicial_dt TEXT,
    hora_final_dt TEXT,
    created_at TEXT
  )`
).run();

db.prepare(
  `CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    perfil TEXT UNIQUE,
    senha TEXT
  )`
).run();

// --- NOVO: tabela de histórico (snapshot diário) ---
db.prepare(
  `CREATE TABLE IF NOT EXISTS historico_dias (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pessoa_id INTEGER,
    data_dia TEXT,               -- YYYY-MM-DD (no fuso America/Sao_Paulo)
    nome TEXT,
    local TEXT,
    status TEXT,
    hora_inicial TEXT,
    hora_final TEXT,
    mensagem TEXT,
    justificativa TEXT,
    gravado_em TEXT              -- ISO datetime quando o snapshot foi gravado
  )`
).run();

// index para busca rápida por data
db.prepare(`CREATE INDEX IF NOT EXISTS idx_historico_data ON historico_dias(data_dia)`).run();

// --- Migração / Adição de colunas de datas completas se necessário (compatibilidade extra) ---
(function migrarAdicionarColunas() {
  try {
    const cols = db
      .prepare("PRAGMA table_info(pessoas)")
      .all()
      .map((c) => c.name);

    const ensureColumn = (name) => {
      if (!cols.includes(name)) {
        db.prepare(`ALTER TABLE pessoas ADD COLUMN ${name} TEXT`).run();
        console.log(`Coluna adicionada: ${name}`);
      }
    };

    ensureColumn("hora_inicial_dt");
    ensureColumn("hora_final_dt");
    ensureColumn("created_at");
  } catch (err) {
    console.error("Erro ao migrar/alterar tabela pessoas:", err);
  }
})();

// --- Usuários iniciais ---
const perfisIniciais = [
  { perfil: "inspetoria", senha: "0000" },
  { perfil: "ccp", senha: "0000" },
];

(async () => {
  try {
    for (const p of perfisIniciais) {
      const row = db.prepare("SELECT * FROM usuarios WHERE perfil=?").get(p.perfil);
      if (!row) {
        const hash = await bcrypt.hash(p.senha, 10);
        db.prepare("INSERT INTO usuarios (perfil, senha) VALUES (?,?)").run(
          p.perfil,
          hash
        );
        console.log(`Usuario inserido: ${p.perfil}`);
      }
    }
  } catch (err) {
    console.error("Erro ao criar usuarios iniciais:", err);
  }
})();

// --- Middleware de autorização ---
function authPerfil(perfis) {
  return (req, res, next) => {
    if (req.session && req.session.perfil && perfis.includes(req.session.perfil))
      next();
    else res.status(401).json({ success: false, error: "Não autorizado" });
  };
}

// --- Helper: tenta ler datetime ISO do registro; se não existir, tenta construir usando hora_inicial/hora_final (legado)
function obterIntervaloPessoa(p) {
  try {
    if (p.hora_inicial_dt && p.hora_final_dt) {
      const inicio = DateTime.fromISO(p.hora_inicial_dt, { zone: "America/Sao_Paulo" });
      const fim = DateTime.fromISO(p.hora_final_dt, { zone: "America/Sao_Paulo" });
      return { inicio, fim };
    }

    if (p.hora_inicial) {
      const agora = agoraBrasilia();
      const [hiH, hiM] = (p.hora_inicial || "00:00").split(":").map(Number);
      let inicio = agora.set({ hour: hiH, minute: hiM, second: 0, millisecond: 0 });
      if (p.hora_final) {
        const [hfH, hfM] = (p.hora_final || "00:00").split(":").map(Number);
        let fim = agora.set({ hour: hfH, minute: hfM, second: 0, millisecond: 0 });
        if (fim <= inicio) fim = fim.plus({ days: 1 });
        return { inicio, fim };
      }
      return { inicio, fim: null };
    }

    return { inicio: null, fim: null };
  } catch (err) {
    console.error("Erro obterIntervaloPessoa:", err);
    return { inicio: null, fim: null };
  }
}

// --- NOVO: Função para salvar snapshot do dia se todas as pessoas iniciaram ---
// Salva um registro por pessoa em historico_dias com data_dia = 'YYYY-MM-DD' (fuso America/Sao_Paulo).
function salvarSnapshotSeTodosIniciaram() {
  try {
    const pendentes = db.prepare("SELECT COUNT(*) as pendentes FROM pessoas WHERE status = '🔴'").get().pendentes;
    if (pendentes > 0) {
      // Ainda há pendentes — nada a fazer
      return { saved: false, reason: "Ainda existem pendentes", pendentes };
    }

    const hoje = agoraBrasilia().toISODate(); // YYYY-MM-DD no fuso de Brasília

    // Verifica se já existe snapshot salvo para hoje
    const jaSalvo = db.prepare("SELECT COUNT(*) as c FROM historico_dias WHERE data_dia = ?").get(hoje).c;
    if (jaSalvo > 0) {
      return { saved: false, reason: "Já salvo hoje", existent: jaSalvo };
    }

    // Recupera todas as pessoas e insere no historico em transação
    const pessoas = db.prepare("SELECT * FROM pessoas ORDER BY id ASC").all();

    const gravado_em = agoraBrasilia().toISO();
    const insert = db.prepare(
      `INSERT INTO historico_dias (pessoa_id, data_dia, nome, local, status, hora_inicial, hora_final, mensagem, justificativa, gravado_em)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const insertMany = db.transaction((rows) => {
      for (const r of rows) {
        insert.run(r.pessoa_id, r.data_dia, r.nome, r.local, r.status, r.hora_inicial, r.hora_final, r.mensagem, r.justificativa, r.gravado_em);
      }
    });

    const rowsToInsert = pessoas.map((p) => ({
      pessoa_id: p.id,
      data_dia: hoje,
      nome: p.nome,
      local: p.local,
      status: p.status,
      hora_inicial: p.hora_inicial,
      hora_final: p.hora_final,
      mensagem: p.mensagem,
      justificativa: p.justificativa,
      gravado_em,
    }));

    insertMany(rowsToInsert);

    console.log(`Snapshot salvo para ${hoje} — ${rowsToInsert.length} registros.`);
    return { saved: true, count: rowsToInsert.length, data: hoje };
  } catch (err) {
    console.error("Erro ao salvar snapshot diário:", err);
    return { saved: false, error: err.message };
  }
}

// --- Rotas ---

// Login
app.post("/login", async (req, res) => {
  try {
    const { perfil, senha } = req.body;
    if (!perfil || !senha)
      return res.json({ success: false, error: "Perfil/ senha faltando" });

    const user = db.prepare("SELECT * FROM usuarios WHERE perfil=?").get(perfil);
    if (!user) return res.json({ success: false, error: "Perfil não encontrado" });

    const match = await bcrypt.compare(senha, user.senha);
    if (!match) return res.json({ success: false, error: "Senha incorreta" });

    req.session.perfil = perfil;
    res.json({ success: true, perfil });
  } catch (err) {
    console.error("Erro /login", err);
    res.status(500).json({ success: false, error: "Erro interno" });
  }
});

// Logout
app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login.html"));
});

// Listar pessoas (status calculado por datetime completo)
app.get("/pessoas", authPerfil(["inspetoria", "ccp", "turma"]), (req, res) => {
  try {
    const pessoas = db.prepare("SELECT * FROM pessoas ORDER BY id ASC").all();
    const agora = agoraBrasilia();
    const update = db.prepare("UPDATE pessoas SET status=? WHERE id=?");

    pessoas.forEach((p) => {
      let novoStatus = "🔴";
      const { inicio, fim } = obterIntervaloPessoa(p);
      if (inicio && fim) {
        if (agora < inicio) novoStatus = "🔴";
        else if (agora >= inicio && agora < fim) novoStatus = "🟡";
        else if (agora >= fim) novoStatus = "🟢";
      } else if (inicio && !fim) {
        novoStatus = agora >= inicio ? "🟡" : "🔴";
      }
      if (p.status !== novoStatus) update.run(novoStatus, p.id);
      p.status = novoStatus;
    });

    res.json({ perfil: req.session.perfil, pessoas });
  } catch (err) {
    console.error("Erro /pessoas", err);
    res.status(500).json({ success: false, error: "Erro interno" });
  }
});

// Endpoint relatório completo (sem filtro) - retorna tabela atual de pessoas
app.get("/pessoas-full", authPerfil(["inspetoria", "ccp", "turma"]), (req, res) => {
  try {
    const pessoas = db.prepare("SELECT * FROM pessoas ORDER BY id ASC").all();
    res.json({ perfil: req.session.perfil, pessoas });
  } catch (err) {
    console.error("Erro /pessoas-full", err);
    res.status(500).json({ success: false, error: "Erro interno" });
  }
});

// --- Relatório por data real de início do turno ---
// Nota: agora prioriza dados em historico_dias (snapshot). Se não houver historico para a data,
// tenta buscar em pessoas por hora_inicial_dt LIKE 'YYYY-MM-DD%'.
app.get("/relatorio/:data", authPerfil(["inspetoria", "ccp", "turma"]), (req, res) => {
  try {
    const { data } = req.params;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) {
      return res.status(400).json({ success: false, error: "Data inválida. Use YYYY-MM-DD" });
    }

    // Tenta histórico primeiro
    const historico = db.prepare("SELECT * FROM historico_dias WHERE data_dia = ? ORDER BY nome ASC").all(data);
    if (historico && historico.length > 0) {
      return res.json({ success: true, data, registros: historico, fonte: "historico_dias" });
    }

    // Fallback: consulta pessoas pela coluna hora_inicial_dt (caso ainda não tenha sido salvo snapshot)
    const rows = db.prepare(
      "SELECT * FROM pessoas WHERE hora_inicial_dt LIKE ? ORDER BY hora_inicial_dt ASC"
    ).all(`${data}%`);

    res.json({ success: true, data, registros: rows, fonte: "pessoas(hora_inicial_dt)" });
  } catch (err) {
    console.error("Erro /relatorio/:data", err);
    res.status(500).json({ success: false, error: "Erro interno" });
  }
});

// --- NOVO: endpoint histórico por query string /historico?data=YYYY-MM-DD
app.get("/historico", authPerfil(["inspetoria", "ccp", "turma"]), (req, res) => {
  try {
    const data = req.query.data;
    if (!data || !/^\d{4}-\d{2}-\d{2}$/.test(data)) {
      return res.status(400).json({ success: false, error: "Use ?data=YYYY-MM-DD" });
    }
    const rows = db.prepare("SELECT * FROM historico_dias WHERE data_dia = ? ORDER BY nome ASC").all(data);
    res.json({ success: true, data, registros: rows });
  } catch (err) {
    console.error("Erro /historico", err);
    res.status(500).json({ success: false, error: "Erro interno" });
  }
});

// --- NOVO: listar ultimos N dias de historico (ex: /historico/ultimos/7) ---
app.get("/historico/ultimos/:dias", authPerfil(["inspetoria", "ccp", "turma"]), (req,res)=>{
  try{
    const dias = parseInt(req.params.dias,10) || 7;
    // Calcula data limite em Brasilia
    const limite = agoraBrasilia().minus({ days: dias-1 }).toISODate();
    const rows = db.prepare("SELECT * FROM historico_dias WHERE data_dia >= ? ORDER BY data_dia DESC, nome ASC").all(limite);
    res.json({ success:true, dias, limite, registros: rows });
  }catch(err){
    console.error("Erro /historico/ultimos",err);
    res.status(500).json({ success:false, error:"Erro interno" });
  }
});

// Adicionar pessoa
app.post("/pessoas", authPerfil(["inspetoria", "ccp"]), (req, res) => {
  try {
    const { nome, local } = req.body;
    if (!nome) return res.status(400).json({ success: false, error: "Nome obrigatório" });
    const created_at = agoraBrasilia().toISO();
    const info = db.prepare(
      "INSERT INTO pessoas (nome, local, created_at) VALUES (?,?,?)"
    ).run(nome, local || "", created_at);
    res.json({ success: true, id: info.lastInsertRowid });
  } catch (err) {
    console.error("Erro /pessoas POST", err);
    res.status(500).json({ success: false, error: "Erro interno" });
  }
});

// Excluir pessoa
app.post("/pessoa/excluir", authPerfil(["inspetoria", "ccp"]), (req, res) => {
  try {
    const { id } = req.body;
    db.prepare("DELETE FROM pessoas WHERE id=?").run(id);
    res.json({ success: true });
  } catch (err) {
    console.error("Erro /pessoa/excluir", err);
    res.status(500).json({ success: false, error: "Erro interno" });
  }
});

// Iniciar pessoa
app.post("/pessoa/iniciar", authPerfil(["inspetoria", "ccp"]), (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ success: false, error: "id obrigatório" });
    const inicio = agoraBrasilia();
    const fim = inicio.plus({ minutes: 75 });
    const formatTime = (dt) => dt.toFormat("HH:mm");
    db.prepare(
      `UPDATE pessoas 
       SET status=?, hora_inicial=?, hora_final=?, hora_inicial_dt=?, hora_final_dt=?
       WHERE id=?`
    ).run("🟡", formatTime(inicio), formatTime(fim), inicio.toISO(), fim.toISO(), id);

    // --- Após iniciar, tenta salvar snapshot se agora todas iniciaram ---
    const snapshotResult = salvarSnapshotSeTodosIniciaram();

    res.json({ success: true, snapshot: snapshotResult });
  } catch (err) {
    console.error("Erro /pessoa/iniciar", err);
    res.status(500).json({ success: false, error: "Erro interno" });
  }
});

// Atualizar campo
app.post("/pessoa/update", authPerfil(["inspetoria", "ccp", "turma"]), (req, res) => {
  try {
    const { id, campo, valor } = req.body;
    if (!id || !campo) return res.status(400).json({ success: false, error: "id e campo obrigatórios" });
    const allowed = ["nome","local","status","liberado","hora_inicial","hora_final","retorno","mensagem","justificativa"];
    if (!allowed.includes(campo)) return res.status(400).json({ success: false, error: "Campo inválido" });

    if (campo === "hora_inicial") {
      const [h,m] = (valor||"00:00").split(":").map(Number);
      if (!Number.isFinite(h) || !Number.isFinite(m)) return res.status(400).json({ success: false, error: "Formato hora inválido" });
      const p = db.prepare("SELECT * FROM pessoas WHERE id=?").get(id);
      let inicio = p && p.hora_inicial_dt ? DateTime.fromISO(p.hora_inicial_dt,{zone:"America/Sao_Paulo"}).set({hour:h,minute:m}) : agoraBrasilia().set({hour:h,minute:m});
      let fim = inicio.plus({ minutes:75 });
      if (fim <= inicio) fim = fim.plus({ days:1 });
      const formatTime = (dt)=>dt.toFormat("HH:mm");
      db.prepare("UPDATE pessoas SET hora_inicial=?, hora_final=?, hora_inicial_dt=?, hora_final_dt=? WHERE id=?")
        .run(formatTime(inicio), formatTime(fim), inicio.toISO(), fim.toISO(), id);

      // Se atualizou hora inicial manualmente, podemos tentar salvar snapshot também
      // (caso já estejam todos iniciados e ainda não salvo)
      salvarSnapshotSeTodosIniciaram();

      return res.json({ success: true });
    }

    if (campo === "hora_final") {
      const [h,m] = (valor||"00:00").split(":").map(Number);
      if (!Number.isFinite(h) || !Number.isFinite(m)) return res.status(400).json({ success: false, error: "Formato hora inválido" });
      const p = db.prepare("SELECT * FROM pessoas WHERE id=?").get(id);
      let base = p && p.hora_inicial_dt ? DateTime.fromISO(p.hora_inicial_dt,{zone:"America/Sao_Paulo"}) : agoraBrasilia();
      let fim = base.set({hour:h,minute:m});
      if (p && p.hora_inicial_dt && fim<=base) fim=fim.plus({days:1});
      db.prepare("UPDATE pessoas SET hora_final=?, hora_final_dt=? WHERE id=?").run(valor,fim.toISO(),id);

      // Tenta snapshot também
      salvarSnapshotSeTodosIniciaram();

      return res.json({ success: true });
    }

    db.prepare(`UPDATE pessoas SET ${campo}=? WHERE id=?`).run(valor,id);
    res.json({ success: true });
  } catch (err) {
    console.error("Erro /pessoa/update", err);
    res.status(500).json({ success: false, error: "Erro interno" });
  }
});

// Editar horário dedicado
app.post("/pessoa/editarHorario", authPerfil(["inspetoria", "ccp"]), (req,res)=>{
  try {
    const {id,hora_inicial} = req.body;
    if(!hora_inicial||!id) return res.status(400).json({success:false,error:"hora_inicial/id requerida"});
    const [h,m]=hora_inicial.split(":").map(Number);
    if(!Number.isFinite(h)||!Number.isFinite(m)) return res.status(400).json({success:false,error:"Formato hora inválido"});
    let inicio=agoraBrasilia().set({hour:h,minute:m});
    let fim=inicio.plus({minutes:75});
    if(fim<=inicio) fim=fim.plus({days:1});
    const formatTime=(d)=>d.toFormat("HH:mm");
    db.prepare("UPDATE pessoas SET hora_inicial=?, hora_final=?, hora_inicial_dt=?, hora_final_dt=? WHERE id=?")
      .run(formatTime(inicio),formatTime(fim),inicio.toISO(),fim.toISO(),id);

    // Tenta salvar snapshot caso todas já iniciadas
    salvarSnapshotSeTodosIniciaram();

    res.json({success:true});
  } catch(err){
    console.error("Erro /pessoa/editarHorario",err);
    res.status(500).json({success:false,error:"Erro interno"});
  }
});

// Quantidade equipes
app.get("/quantidade-equipes", authPerfil(["inspetoria", "ccp", "turma"]),(req,res)=>{
  try{
    const row=db.prepare("SELECT COUNT(*) as total FROM pessoas").get();
    res.json({total:row.total});
  }catch(err){
    console.error("Erro /quantidade-equipes",err);
    res.status(500).json({success:false,error:"Erro interno"});
  }
});

// Reset pessoa
app.post("/pessoa/reset", authPerfil(["inspetoria", "ccp"]),(req,res)=>{
  try{
    const {id}=req.body;
    db.prepare("UPDATE pessoas SET status='🔴',hora_inicial=NULL,hora_final=NULL,hora_inicial_dt=NULL,hora_final_dt=NULL,mensagem=NULL WHERE id=?").run(id);
    res.json({success:true});
  }catch(err){
    console.error(err);
    res.status(500).json({success:false});
  }
});

// Reset senha
app.post("/reset-senha", async(req,res)=>{
  try{
    const {perfil,token,novaSenha}=req.body;
    if(!perfil||!token||!novaSenha) return res.status(400).json({success:false,error:"Preencha todos os campos"});
    if(token!==TOKEN_FIXO) return res.status(401).json({success:false,error:"Token inválido"});
    const user=db.prepare("SELECT * FROM usuarios WHERE perfil=?").get(perfil);
    if(!user) return res.status(404).json({success:false,error:"Perfil não encontrado"});
    const hash=await bcrypt.hash(novaSenha,10);
    db.prepare("UPDATE usuarios SET senha=? WHERE perfil=?").run(hash,perfil);
    res.json({success:true,message:"Senha alterada com sucesso"});
  }catch(err){
    console.error("Erro /reset-senha",err);
    res.status(500).json({success:false,error:"Erro interno"});
  }
});

// Reset sistema
app.post("/sistema/reset", authPerfil(["inspetoria", "ccp"]),(req,res)=>{
  try{
    db.prepare(`UPDATE pessoas SET status='🔴',hora_inicial=NULL,hora_final=NULL,hora_inicial_dt=NULL,hora_final_dt=NULL,retorno=NULL,liberado=NULL,mensagem=NULL,justificativa=NULL`).run();
    res.json({success:true,message:"Sistema resetado com sucesso"});
  }catch(err){
    console.error("Erro ao resetar sistema",err);
    res.status(500).json({success:false,error:err.message});
  }
});

// --- Start ---
app.listen(PORT,()=>console.log(`Servidor rodando em http://localhost:${PORT}`));
