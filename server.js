// server.js - Sistema de Revezamento (Better SQLite3 + Polling 1s)
const TOKEN_FIXO = "vale@3007"; // Token fixo para redefinir senha
const express = require("express");
const session = require("express-session");
const path = require("path");
const bcrypt = require("bcrypt");
const Database = require("better-sqlite3");

const app = express();
const PORT = 3000;

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

// --- Hora Brasília ---
const { DateTime } = require('luxon');

function agoraBrasilia() {
    return DateTime.now().setZone('America/Sao_Paulo').toJSDate();
}

// --- Tabelas ---
db.prepare(`CREATE TABLE IF NOT EXISTS pessoas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT,
  local TEXT,
  status TEXT DEFAULT '🔴',
  liberado TEXT DEFAULT NULL,
  hora_inicial TEXT,
  hora_final TEXT,
  retorno TEXT,
  mensagem TEXT,
  justificativa TEXT
)`).run();

db.prepare(`CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  perfil TEXT UNIQUE,
  senha TEXT
)`).run();

// --- Usuários iniciais ---
const perfisIniciais = [
  { perfil: "inspetoria", senha: "cg@25xd" },
  { perfil: "ccp", senha: "cg@25vl" },
];

perfisIniciais.forEach(async (p) => {
  const row = db.prepare("SELECT * FROM usuarios WHERE perfil=?").get(p.perfil);
  if (!row) {
    const hash = await bcrypt.hash(p.senha, 10);
    db.prepare("INSERT INTO usuarios (perfil, senha) VALUES (?,?)").run(
      p.perfil,
      hash
    );
    console.log(`Usuario inserido: ${p.perfil}`);
  }
});

// --- Middleware ---
function authPerfil(perfis) {
  return (req, res, next) => {
    if (req.session && req.session.perfil && perfis.includes(req.session.perfil))
      next();
    else res.status(401).json({ success: false, error: "Não autorizado" });
  };
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

// Listar pessoas
app.get("/pessoas", authPerfil(["inspetoria", "ccp", "turma"]), (req, res) => {
  try {
    const pessoas = db.prepare("SELECT * FROM pessoas ORDER BY id ASC").all();

    // usa Luxon para fazer comparações no mesmo fuso
    const agora = DateTime.now().setZone('America/Sao_Paulo');

    const update = db.prepare("UPDATE pessoas SET status=? WHERE id=?");
    pessoas.forEach((p) => {
      let novoStatus = "🔴";
      if (p.hora_inicial && p.hora_final) {
        const [hiH, hiM] = p.hora_inicial.split(":").map(Number);
        const [hfH, hfM] = p.hora_final.split(":").map(Number);

        let inicio = agora.set({ hour: hiH, minute: hiM, second: 0, millisecond: 0 });
        let fim = agora.set({ hour: hfH, minute: hfM, second: 0, millisecond: 0 });

        // se o fim for igual ou antes do início (passou meia-noite), ajusta o fim para o dia seguinte
        if (fim <= inicio) {
          fim = fim.plus({ days: 1 });
        }

        if (agora < inicio) novoStatus = "🔴";
        else if (agora >= inicio && agora < fim) novoStatus = "🟡";
        else if (agora >= fim) novoStatus = "🟢";
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

// Adicionar pessoa
app.post("/pessoas", authPerfil(["inspetoria", "ccp"]), (req, res) => {
  try {
    const { nome, local } = req.body;
    if (!nome)
      return res.status(400).json({ success: false, error: "Nome obrigatório" });
    const info = db
      .prepare("INSERT INTO pessoas (nome, local) VALUES (?,?)")
      .run(nome, local || "");
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

    // usa Luxon para garantir consistência de fuso e formato
    const inicio = DateTime.now().setZone('America/Sao_Paulo');
    const fim = inicio.plus({ minutes: 75 });
    const formatTime = (dt) => dt.toFormat('HH:mm');

    db.prepare("UPDATE pessoas SET status=?, hora_inicial=?, hora_final=? WHERE id=?")
      .run("🟡", formatTime(inicio), formatTime(fim), id);
    res.json({ success: true });
  } catch (err) {
    console.error("Erro /pessoa/iniciar", err);
    res.status(500).json({ success: false, error: "Erro interno" });
  }
});

// Atualizar campo
app.post("/pessoa/update", authPerfil(["inspetoria", "ccp", "turma"]), (req, res) => {
  try {
    const { id, campo, valor } = req.body;

    const allowed = [
      "nome","local","status","liberado","hora_inicial","hora_final","retorno",
      "mensagem","justificativa","revezamento","tarefa_especial","inss","treinamento","observacoes"
    ];
    if (!allowed.includes(campo))
      return res.status(400).json({ success: false, error: "Campo inválido" });

    db.prepare(`UPDATE pessoas SET ${campo}=? WHERE id=?`).run(valor, id);
    res.json({ success: true });
  } catch (err) {
    console.error("Erro /pessoa/update", err);
    res.status(500).json({ success: false, error: "Erro interno" });
  }
});

// Quantidade
app.get("/quantidade-equipes", authPerfil(["inspetoria", "ccp", "turma"]), (req, res) => {
  try {
    const row = db.prepare("SELECT COUNT(*) as total FROM pessoas").get();
    res.json({ total: row.total });
  } catch (err) {
    console.error("Erro /quantidade-equipes", err);
    res.status(500).json({ success: false, error: "Erro interno" });
  }
});

// Resetar pessoa
app.post("/pessoa/reset", authPerfil(["inspetoria", "ccp"]), (req,res)=>{
  try{
    const {id}=req.body;
    db.prepare("UPDATE pessoas SET status='🔴', hora_inicial=NULL, hora_final=NULL, mensagem=NULL WHERE id=?").run(id);
    res.json({success:true});
  }catch(err){ console.error(err); res.status(500).json({success:false}); }
});

// Resetar senha
app.post("/reset-senha", async (req, res) => {
  try {
    const { perfil, token, novaSenha } = req.body;

    if (!perfil || !token || !novaSenha) {
      return res.status(400).json({ success: false, error: "Preencha todos os campos" });
    }

    if (token !== TOKEN_FIXO) {
      return res.status(401).json({ success: false, error: "Token inválido" });
    }

    const user = db.prepare("SELECT * FROM usuarios WHERE perfil=?").get(perfil);
    if (!user) return res.status(404).json({ success: false, error: "Perfil não encontrado" });

    const hash = await bcrypt.hash(novaSenha, 10);
    db.prepare("UPDATE usuarios SET senha=? WHERE perfil=?").run(hash, perfil);

    res.json({ success: true, message: "Senha alterada com sucesso" });
  } catch (err) {
    console.error("Erro /reset-senha", err);
    res.status(500).json({ success: false, error: "Erro interno" });
  }
});

app.post("/pessoa/editarHorario", (req, res) => {
  try {
    const { id, hora_inicial } = req.body;

    // usa Luxon para calcular fim = inicio + 75min de forma consistente
    const [h, m] = hora_inicial.split(":").map(Number);
    let inicio = DateTime.now().setZone('America/Sao_Paulo').set({ hour: h, minute: m, second: 0, millisecond: 0 });
    let fim = inicio.plus({ minutes: 75 });

    const formatTime = (d) => d.toFormat('HH:mm');

    // Atualiza os dois campos no banco
    db.prepare("UPDATE pessoas SET hora_inicial=?, hora_final=? WHERE id=?")
      .run(formatTime(inicio), formatTime(fim), id);

    res.json({ success: true });
  } catch (err) {
    console.error("Erro /pessoa/editarHorario", err);
    res.status(500).json({ success: false, error: "Erro interno" });
  }
});

app.post('/sistema/reset', (req, res) => {
    try {
        const stmt = db.prepare(`
            UPDATE pessoas
            SET 
                status = '🔴',
                hora_inicial = NULL,
                hora_final = NULL,
                retorno = NULL,
                liberado = NULL,
                mensagem = NULL,
                justificativa = NULL
        `);
        stmt.run(); // Executa a atualização de todos os registros
        res.json({ success: true, message: 'Sistema resetado com sucesso' });
    } catch (err) {
        console.error('Erro ao resetar sistema', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- Start ---
app.listen(PORT, () => console.log(`Servidor rodando em http://localhost:${PORT}`));
