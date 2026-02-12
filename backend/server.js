require("dotenv").config();
const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");
const path = require("path");

const app = express();

app.use(cors());
app.use(express.json());

/* ================================
   🔐 CONTENT SECURITY POLICY
================================ */
app.use((req, res, next) => {
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; " +
    "style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; " +
    "font-src 'self' https://fonts.gstatic.com; " +
    "script-src 'self' 'unsafe-inline';"
  );
  next();
});

/* ================================
   📦 SERVIR FRONTEND
================================ */
app.use(express.static(path.join(__dirname, "../frontend")));

/* ================================
   🗄 CONEXÃO POSTGRES
================================ */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const SECRET = process.env.JWT_SECRET || "supersecretkey";

/* ================================
   🔐 MIDDLEWARE TOKEN
================================ */
function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) return res.status(401).json({ error: "Token não enviado" });

  jwt.verify(token, SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: "Token inválido ou expirado" });
    req.user = user;
    next();
  });
}

/* ================================
   👤 USERS
================================ */

pool.query(`
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(100) UNIQUE NOT NULL,
  password TEXT NOT NULL,
  role VARCHAR(20) DEFAULT 'user'
);
`);

app.post("/register", authenticateToken, async (req, res) => {
  try {
    const { username, password, role } = req.body;
    const hash = await bcrypt.hash(password, 10);

    await pool.query(
      "INSERT INTO users (username, password, role) VALUES ($1,$2,$3)",
      [username, hash, role || "user"]
    );

    res.json({ message: "Usuário criado" });
  } catch (err) {
    res.status(400).json({ error: "Usuário já existe" });
  }
});

app.post("/login", async (req, res) => {
  const { username, password } = req.body;

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
});

/* ================================
   🏢 FORNECEDORES
================================ */

pool.query(`
CREATE TABLE IF NOT EXISTS suppliers (
  id SERIAL PRIMARY KEY,
  nome VARCHAR(200) UNIQUE NOT NULL
);
`);

app.get("/suppliers", authenticateToken, async (req, res) => {
  const result = await pool.query("SELECT * FROM suppliers ORDER BY nome");
  res.json(result.rows);
});

app.post("/suppliers", authenticateToken, async (req, res) => {
  const { nome } = req.body;
  await pool.query("INSERT INTO suppliers (nome) VALUES ($1)", [nome]);
  res.json({ message: "Fornecedor criado" });
});

/* ================================
   📦 PRODUTOS
================================ */

pool.query(`
CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  codigo VARCHAR(100),
  nome VARCHAR(200),
  fornecedor VARCHAR(200),
  estoque INTEGER,
  preco_custo NUMERIC,
  preco_venda NUMERIC
);
`);

app.get("/products", authenticateToken, async (req, res) => {
  const busca = req.query.q || "";

  const result = await pool.query(
    "SELECT * FROM products WHERE nome ILIKE $1 ORDER BY id DESC",
    [`%${busca}%`]
  );

  res.json(result.rows);
});

app.post("/products", authenticateToken, async (req, res) => {
  const { codigo, nome, fornecedor, estoque, preco_custo, preco_venda } = req.body;

  await pool.query(
    `INSERT INTO products 
     (codigo,nome,fornecedor,estoque,preco_custo,preco_venda)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [codigo,nome,fornecedor,estoque,preco_custo,preco_venda]
  );

  res.json({ message: "Produto cadastrado" });
});

app.put("/products/:id", authenticateToken, async (req, res) => {
  const { codigo, nome, fornecedor, estoque, preco_custo, preco_venda } = req.body;

  await pool.query(
    `UPDATE products SET
     codigo=$1,nome=$2,fornecedor=$3,
     estoque=$4,preco_custo=$5,preco_venda=$6
     WHERE id=$7`,
    [codigo,nome,fornecedor,estoque,preco_custo,preco_venda,req.params.id]
  );

  res.json({ message: "Produto atualizado" });
});

app.delete("/products/:id", authenticateToken, async (req, res) => {
  await pool.query("DELETE FROM products WHERE id=$1", [req.params.id]);
  res.json({ message: "Produto excluído" });
});

/* ================================
   🌐 ROTA PRINCIPAL
================================ */

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/login.html"));
});

/* ================================
   🚀 START SERVER
================================ */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Servidor rodando na porta " + PORT);
});
