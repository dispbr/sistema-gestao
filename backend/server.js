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

/* ================= AUTH ================= */

function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) return res.status(401).json({ error: "Token não enviado" });

  jwt.verify(token, SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: "Token inválido" });
    req.user = user;
    next();
  });
}

/* ================= CRIAR / ATUALIZAR TABELAS ================= */

async function criarTabelas() {

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(100) UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role VARCHAR(20) DEFAULT 'user'
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS suppliers (
      id SERIAL PRIMARY KEY,
      nome VARCHAR(200) UNIQUE NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      codigo VARCHAR(100),
      nome VARCHAR(200),
      fornecedor VARCHAR(200),
      estoque INTEGER DEFAULT 0,
      preco_custo NUMERIC DEFAULT 0,
      preco_venda NUMERIC DEFAULT 0
    );
  `);

  /* GARANTE QUE AS COLUNAS EXISTEM */
  await pool.query(`
    ALTER TABLE products 
    ADD COLUMN IF NOT EXISTS sku VARCHAR(100);
  `);

  await pool.query(`
    ALTER TABLE products 
    ADD COLUMN IF NOT EXISTS cor VARCHAR(100);
  `);

  await pool.query(`
    ALTER TABLE products 
    ADD COLUMN IF NOT EXISTS tamanho VARCHAR(100);
  `);

  await pool.query(`
    ALTER TABLE products 
    ADD COLUMN IF NOT EXISTS variacao VARCHAR(50);
  `);

  await pool.query(`
    ALTER TABLE products 
    ADD COLUMN IF NOT EXISTS barcode VARCHAR(100);
  `);

  console.log("Tabelas verificadas ✔");
}

criarTabelas();

/* ================= LOGIN ================= */

app.post("/login", async (req, res) => {
  try {
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

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro no login" });
  }
});

/* ================= FORNECEDORES ================= */

app.get("/suppliers", authenticateToken, async (req, res) => {
  const result = await pool.query("SELECT * FROM suppliers ORDER BY nome");
  res.json(result.rows);
});

app.post("/suppliers", authenticateToken, async (req, res) => {
  try {
    const { nome } = req.body;
    await pool.query("INSERT INTO suppliers (nome) VALUES ($1)", [nome]);
    res.json({ success: true });
  } catch {
    res.status(400).json({ error: "Fornecedor já existe" });
  }
});

app.delete("/suppliers/:id", authenticateToken, async (req, res) => {
  const id = parseInt(req.params.id);
  await pool.query("DELETE FROM suppliers WHERE id=$1", [id]);
  res.json({ success: true });
});

/* ================= PRODUTOS ================= */

app.get("/products", authenticateToken, async (req, res) => {
  const busca = req.query.q || "";

  const result = await pool.query(
    "SELECT * FROM products WHERE nome ILIKE $1 ORDER BY id DESC",
    [`%${busca}%`]
  );

  res.json(result.rows);
});

/* GERAR PRÓXIMO CÓDIGO */
app.get("/products/next-code", authenticateToken, async (req, res) => {

  const result = await pool.query(`
    SELECT MAX(CAST(codigo AS INTEGER)) as ultimo 
    FROM products
    WHERE codigo ~ '^[0-9]+$'
  `);

  let ultimo = result.rows[0].ultimo || 0;
  let proximo = parseInt(ultimo) + 1;

  res.json({
    codigo: String(proximo).padStart(4, "0")
  });
});

/* CRIAR PRODUTO */
app.post("/products", authenticateToken, async (req, res) => {
  try {

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
    `, [
      codigo || "",
      nome || "",
      fornecedor || "",
      sku || "",
      cor || "",
      tamanho || "",
      parseInt(estoque) || 0,
      parseFloat(preco_custo) || 0,
      parseFloat(preco_venda) || 0,
      variacao || "",
      barcode || ""
    ]);

    res.json(result.rows[0]);

  } catch (err) {
    console.error("ERRO AO SALVAR:", err);
    res.status(500).json({ error: "Erro ao salvar produto" });
  }
});

/* INLINE UPDATE */
app.put("/products/:id/campo", authenticateToken, async (req, res) => {

  if (req.user.role !== "admin")
    return res.status(403).json({ error: "Somente admin pode editar" });

  const id = parseInt(req.params.id);
  const { campo, valor } = req.body;

  const camposPermitidos = [
    "nome","fornecedor","sku","cor",
    "tamanho","estoque",
    "preco_custo","preco_venda","barcode"
  ];

  if (!camposPermitidos.includes(campo))
    return res.status(400).json({ error: "Campo inválido" });

  let valorFinal = valor;

  if (campo === "estoque")
    valorFinal = parseInt(valor) || 0;

  if (campo === "preco_custo" || campo === "preco_venda")
    valorFinal = parseFloat(valor) || 0;

  await pool.query(
    `UPDATE products SET ${campo}=$1 WHERE id=$2`,
    [valorFinal, id]
  );

  res.json({ success: true });
});

/* DELETE PRODUTO */
app.delete("/products/:id", authenticateToken, async (req, res) => {
  const id = parseInt(req.params.id);
  await pool.query("DELETE FROM products WHERE id=$1", [id]);
  res.json({ success: true });
});

/* ROOT */
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/login.html"));
});

/* START */
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Servidor rodando na porta " + PORT);
});
