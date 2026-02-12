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

app.use(express.static(path.join(__dirname, "../frontend")));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const SECRET = process.env.JWT_SECRET || "supersecretkey";

/* ================= TOKEN ================= */

function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) return res.status(401).json({ error: "Token não enviado" });

  jwt.verify(token, SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: "Token inválido" });
    req.user = user;
    next();
  });
}

/* ================= USERS ================= */

pool.query(`
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(100) UNIQUE NOT NULL,
  password TEXT NOT NULL,
  role VARCHAR(20) DEFAULT 'user'
);
`);

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

/* ================= FORNECEDORES ================= */

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

/* ================= PRODUTOS ================= */

pool.query(`
CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  codigo VARCHAR(100),
  nome VARCHAR(200),
  fornecedor VARCHAR(200),
  sku VARCHAR(100),
  cor VARCHAR(100),
  tamanho VARCHAR(100),
  estoque INTEGER,
  preco_custo NUMERIC,
  preco_venda NUMERIC,
  variacao VARCHAR(50),
  barcode VARCHAR(100)
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

  const {
    codigo, nome, fornecedor,
    sku, cor, tamanho,
    estoque, preco_custo,
    preco_venda, variacao, barcode
  } = req.body;

  const result = await pool.query(`
    INSERT INTO products
    (codigo,nome,fornecedor,sku,cor,tamanho,
     estoque,preco_custo,preco_venda,variacao,barcode)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    RETURNING *
  `,
  [codigo,nome,fornecedor,sku,cor,tamanho,
   estoque,preco_custo,preco_venda,variacao,barcode]);

  res.json(result.rows[0]);
});

app.put("/products/:id", authenticateToken, async (req,res)=>{

  if(req.user.role !== "admin"){
    return res.status(403).json({error:"Apenas admin pode editar"});
  }

  const { id } = req.params;

  const {
    nome, fornecedor, sku,
    cor, tamanho, estoque,
    preco_custo, preco_venda,
    variacao, barcode
  } = req.body;

  await pool.query(`
    UPDATE products SET
    nome=$1,
    fornecedor=$2,
    sku=$3,
    cor=$4,
    tamanho=$5,
    estoque=$6,
    preco_custo=$7,
    preco_venda=$8,
    variacao=$9,
    barcode=$10
    WHERE id=$11
  `,
  [nome,fornecedor,sku,cor,tamanho,
   estoque,preco_custo,preco_venda,
   variacao,barcode,id]);

  res.json({success:true});
});

app.delete("/products/:id", authenticateToken, async (req,res)=>{
  await pool.query("DELETE FROM products WHERE id=$1",[req.params.id]);
  res.json({success:true});
});

/* ================= ROOT ================= */

app.get("/", (req,res)=>{
  res.sendFile(path.join(__dirname,"../frontend/login.html"));
});

/* ================= START ================= */

const PORT = process.env.PORT || 3000;

app.listen(PORT, ()=>{
  console.log("Servidor rodando na porta " + PORT);
});
