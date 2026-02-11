const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

// Servir arquivos do frontend
app.use(express.static(path.join(__dirname, "../frontend")));

const SECRET = process.env.SECRET;
  
// Banco SQLite
const db = new sqlite3.Database("banco.db");

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario TEXT UNIQUE,
    senha TEXT,
    nivel TEXT
  )`);
});

// =============================
// REGISTRAR USUÁRIO
// =============================
app.post("/register", async (req, res) => {
  const { usuario, senha, nivel } = req.body;

  try {
    const hash = await bcrypt.hash(senha, 10);

    db.run(
      "INSERT INTO usuarios (usuario, senha, nivel) VALUES (?, ?, ?)",
      [usuario, hash, nivel || "comum"],
      function (err) {
        if (err) {
          return res.status(400).json({ erro: "Usuário já existe" });
        }
        res.json({ ok: true });
      }
    );
  } catch (err) {
    res.status(500).json({ erro: "Erro interno" });
  }
});

// =============================
// LOGIN
// =============================
app.post("/login", (req, res) => {
  const { usuario, senha } = req.body;

  db.get("SELECT * FROM usuarios WHERE usuario = ?", [usuario], async (err, user) => {

    if (!user) {
      return res.status(401).json({ erro: "Usuário inválido" });
    }

    const senhaValida = await bcrypt.compare(senha, user.senha);

    if (!senhaValida) {
      return res.status(401).json({ erro: "Senha inválida" });
    }

    const token = jwt.sign(
      {
        id: user.id,
        usuario: user.usuario,
        nivel: user.nivel
      },
      SECRET,
      { expiresIn: "30m" }
    );

    res.json({ token });
  });
});

// =============================
// PROTEGER ROTAS (exemplo)
// =============================
function autenticar(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader) return res.sendStatus(401);

  const token = authHeader.split(" ")[1];

  jwt.verify(token, SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
}

// Exemplo rota protegida
app.get("/perfil", autenticar, (req, res) => {
  res.json({ usuario: req.user.usuario, nivel: req.user.nivel });
});
app.get("/usuarios", autenticar, (req, res) => {
  if (req.user.nivel !== "admin") {
    return res.status(403).json({ erro: "Acesso negado" });
  }

  db.all("SELECT id, usuario, nivel FROM usuarios", [], (err, rows) => {
    res.json(rows);
  });
});

// =============================
// ROTA INICIAL
// =============================
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/login.html"));
});

// =============================
app.listen(3000, () => {
  console.log("Servidor rodando em http://localhost:3000");
});
