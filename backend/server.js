require("dotenv").config();
const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();
app.use(express.json());
app.use(cors());

const SECRET = process.env.SECRET || "super_chave_secreta";

// 🔹 ROTA RAIZ (evita Cannot GET /)
app.get("/", (req, res) => {
  res.send("API Sistema Gestão rodando 🚀");
});

// 🔹 Conexão PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// 🔹 Criar tabela automaticamente
pool.query(`
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(100) UNIQUE NOT NULL,
  password TEXT NOT NULL,
  role VARCHAR(20) DEFAULT 'user'
);
`)
.then(() => console.log("Tabela users pronta"))
.catch(err => console.error("Erro ao criar tabela:", err));


// 🔐 Middleware de autenticação
function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) return res.status(401).json({ error: "Token não fornecido" });

  jwt.verify(token, SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: "Token inválido" });
    req.user = user;
    next();
  });
}


// 🔥 ROTA TEMPORÁRIA PARA CRIAR PRIMEIRO ADMIN
app.get("/create-admin", async (req, res) => {
  const hashed = await bcrypt.hash("123456", 10);

  try {
    await pool.query(
      "INSERT INTO users (username, password, role) VALUES ($1,$2,$3)",
      ["admin", hashed, "admin"]
    );
    res.send("Admin criado com sucesso");
  } catch (err) {
    res.send("Admin já existe");
  }
});


// 🔐 LOGIN
app.post("/login", async (req, res) => {
  const { username, password } = req.body;

  try {
    const result = await pool.query(
      "SELECT * FROM users WHERE username=$1",
      [username]
    );

    if (result.rows.length === 0)
      return res.status(400).json({ error: "Usuário inválido" });

    const user = result.rows[0];

    const valid = await bcrypt.compare(password, user.password);
    if (!valid)
      return res.status(400).json({ error: "Senha inválida" });

    const token = jwt.sign(
      { id: user.id, role: user.role },
      SECRET,
      { expiresIn: "30m" }
    );

    res.json({ token, role: user.role });

  } catch (err) {
    res.status(500).json({ error: "Erro no servidor" });
  }
});


// 👥 CRIAR USUÁRIO (APENAS ADMIN)
app.post("/register", authenticateToken, async (req, res) => {

  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Apenas admin pode criar usuários" });
  }

  const { username, password, role } = req.body;

  const hashed = await bcrypt.hash(password, 10);

  try {
    await pool.query(
      "INSERT INTO users (username, password, role) VALUES ($1,$2,$3)",
      [username, hashed, role || "user"]
    );

    res.json({ message: "Usuário criado com sucesso" });

  } catch (err) {
    res.status(400).json({ error: "Usuário já existe" });
  }
});


// 📋 LISTAR USUÁRIOS (APENAS ADMIN)
app.get("/users", authenticateToken, async (req, res) => {

  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Apenas admin pode listar usuários" });
  }

  const result = await pool.query(
    "SELECT id, username, role FROM users"
  );

  res.json(result.rows);
});


// 🔄 RESETAR SENHA (APENAS ADMIN)
app.put("/reset-password/:id", authenticateToken, async (req, res) => {

  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Apenas admin pode resetar senha" });
  }

  const { password } = req.body;
  const hashed = await bcrypt.hash(password, 10);

  await pool.query(
    "UPDATE users SET password=$1 WHERE id=$2",
    [hashed, req.params.id]
  );

  res.json({ message: "Senha atualizada com sucesso" });
});


app.listen(3000, () => {
  console.log("Servidor rodando na porta 3000");
});
