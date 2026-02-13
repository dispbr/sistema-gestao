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

  if (!token)
    return res.status(401).json({ error: "Token não enviado" });

  jwt.verify(token, SECRET, (err, user) => {
    if (err)
      return res.status(403).json({ error: "Token inválido" });

    req.user = user;
    next();
  });
}

/* ================= CRIAR TABELAS ================= */

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

  /* garante colunas novas */
  await pool.query(`
    ALTER TABLE products
    ADD COLUMN IF NOT EXISTS sku VARCHAR(100),
    ADD COLUMN IF NOT EXISTS cor VARCHAR(100),
    ADD COLUMN IF NOT EXISTS tamanho VARCHAR(100),
    ADD COLUMN IF NOT EXISTS variacao VARCHAR(50),
    ADD COLUMN IF NOT EXISTS barcode VARCHAR(100),
    ADD COLUMN IF NOT EXISTS ano INTEGER;
  `);

  console.log("Tabelas OK");
}

criarTabelas();

/* ================= LOGIN ================= */

app.post("/login", async (req, res) => {

  const { username, password } = req.body;

  const result = await pool.query(
    "SELECT * FROM users WHERE username=$1",
    [username]
  );

  if (!result.rows.length)
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

app.get("/suppliers", authenticateToken, async (req,res)=>{
  const result = await pool.query("SELECT * FROM suppliers ORDER BY nome");
  res.json(result.rows);
});

app.post("/suppliers", authenticateToken, async (req,res)=>{

  try{
    await pool.query(
      "INSERT INTO suppliers(nome) VALUES($1)",
      [req.body.nome]
    );

    res.json({success:true});

  }catch{
    res.status(400).json({error:"Fornecedor já existe"});
  }

});

app.delete("/suppliers/:id", authenticateToken, async(req,res)=>{
  await pool.query("DELETE FROM suppliers WHERE id=$1",[req.params.id]);
  res.json({success:true});
});

/* ================= PRODUTOS ================= */

app.get("/products", authenticateToken, async (req,res)=>{

  const busca = req.query.q || "";

  const result = await pool.query(
    "SELECT * FROM products WHERE nome ILIKE $1 ORDER BY id DESC",
    [`%${busca}%`]
  );

  res.json(result.rows);
});

/* próximo código */

app.get("/products/next-code", authenticateToken, async(req,res)=>{

  const result = await pool.query(`
    SELECT MAX(CAST(codigo AS INTEGER)) as ultimo
    FROM products
    WHERE codigo ~ '^[0-9]+$'
  `);

  const ultimo = result.rows[0].ultimo || 0;

  res.json({
    codigo: String(Number(ultimo)+1).padStart(4,"0")
  });
});

/* criar produto */

app.post("/products", authenticateToken, async(req,res)=>{

  try{

    const {
      codigo,nome,fornecedor,
      sku,cor,tamanho,
      estoque,preco_custo,
      preco_venda,variacao,
      barcode,ano
    } = req.body;

    const result = await pool.query(`
      INSERT INTO products
      (codigo,nome,fornecedor,sku,cor,tamanho,
       estoque,preco_custo,preco_venda,
       variacao,barcode,ano)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      RETURNING *
    `,[
      codigo||"",
      nome||"",
      fornecedor||"",
      sku||"",
      cor||"",
      tamanho||"",
      parseInt(estoque)||0,
      parseFloat(preco_custo)||0,
      parseFloat(preco_venda)||0,
      variacao||"",
      barcode||"",
      parseInt(ano)||null
    ]);

    res.json(result.rows[0]);

  }catch(err){
    console.log(err);
    res.status(500).json({error:"Erro ao salvar"});
  }
});

/* inline edit */

app.put("/products/:id/campo", authenticateToken, async(req,res)=>{

  if(req.user.role !== "admin")
    return res.status(403).json({error:"Somente admin"});

  const { campo, valor } = req.body;

  const camposPermitidos = [
  "nome",
  "fornecedor",
  "sku",
  "cor",
  "tamanho",
  "estoque",
  "preco_custo",
  "preco_venda",
  "barcode",
  "ano"      // 👈 ADICIONAR ESTA LINHA
];


  if(!camposPermitidos.includes(campo))
    return res.status(400).json({error:"Campo inválido"});

  await pool.query(
    `UPDATE products SET ${campo}=$1 WHERE id=$2`,
    [valor, req.params.id]
  );

  res.json({success:true});
});

/* delete */

app.delete("/products/:id", authenticateToken, async(req,res)=>{
  await pool.query("DELETE FROM products WHERE id=$1",[req.params.id]);
  res.json({success:true});
});

/* ROOT */

app.get("/",(req,res)=>{
  res.sendFile(path.join(__dirname,"../frontend/login.html"));
});

const multer = require("multer");
const XLSX = require("xlsx");

const upload = multer({ storage: multer.memoryStorage() });

app.post(
"/products/import-excel",
authenticateToken,
upload.single("file"),
async (req,res)=>{

  try{

    const workbook = XLSX.read(req.file.buffer,{type:"buffer"});
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const dados = XLSX.utils.sheet_to_json(sheet);

    for(const item of dados){

      const codigo = String(item.CODIGO || "").trim();
      if(!codigo) continue;

      const existe = await pool.query(
        "SELECT id FROM products WHERE codigo=$1",
        [codigo]
      );

      if(existe.rows.length){

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
          barcode=$9,
          ano=$10
          WHERE codigo=$11
        `,[
          item.NOME || "",
          item.FORNECEDOR || "",
          item.SKU || "",
          item.COR || "",
          item.TAMANHO || "",
          parseInt(item.ESTOQUE)||0,
          parseFloat(item.CUSTO)||0,
          parseFloat(item.VENDA)||0,
          item.NCM || "",
          parseInt(item.ANO)||null,
          codigo
        ]);

      }else{

        await pool.query(`
          INSERT INTO products
          (codigo,nome,fornecedor,sku,cor,tamanho,
          estoque,preco_custo,preco_venda,barcode,ano)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        `,[
          codigo,
          item.NOME || "",
          item.FORNECEDOR || "",
          item.SKU || "",
          item.COR || "",
          item.TAMANHO || "",
          parseInt(item.ESTOQUE)||0,
          parseFloat(item.CUSTO)||0,
          parseFloat(item.VENDA)||0,
          item.NCM || "",
          parseInt(item.ANO)||null
        ]);
      }
    }

    res.json({success:true});

  }catch(err){
    console.log(err);
    res.status(500).json({error:"Erro importar"});
  }

});



/* START */

const PORT = process.env.PORT || 3000;

app.listen(PORT, ()=>{
  console.log("Servidor rodando na porta "+PORT);
});
