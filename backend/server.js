require("dotenv").config();
const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");
const path = require("path");
const multer = require("multer");
const XLSX = require("xlsx");

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "../frontend")));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:{ rejectUnauthorized:false }
});

const SECRET = process.env.JWT_SECRET || "supersecretkey";

/* ================= AUTH ================= */

function authenticateToken(req,res,next){
  const token = req.headers.authorization?.split(" ")[1];

  if(!token)
    return res.status(401).json({error:"Token não enviado"});

  jwt.verify(token, SECRET,(err,user)=>{
    if(err)
      return res.status(403).json({error:"Token inválido"});

    req.user=user;
    next();
  });
}

/* ================= TABELAS ================= */

async function criarTabelas(){

  await pool.query(`
  CREATE TABLE IF NOT EXISTS users(
    id SERIAL PRIMARY KEY,
    username VARCHAR(100) UNIQUE,
    password TEXT,
    role VARCHAR(20) DEFAULT 'admin'
  );
  `);

  await pool.query(`
  CREATE TABLE IF NOT EXISTS products(
    id SERIAL PRIMARY KEY,
    codigo VARCHAR(100),
    nome VARCHAR(200),
    fornecedor VARCHAR(200),
    sku VARCHAR(100),
    cor VARCHAR(100),
    tamanho VARCHAR(100),
    estoque INTEGER DEFAULT 0,
    preco_custo NUMERIC DEFAULT 0,
    preco_venda NUMERIC DEFAULT 0,
    variacao VARCHAR(50),
    barcode VARCHAR(100),
    ano INTEGER
  );
  `);

  await pool.query(`
  CREATE TABLE IF NOT EXISTS suppliers(
    id SERIAL PRIMARY KEY,
    nome VARCHAR(200) UNIQUE
  );
  `);

  console.log("Tabelas OK");
}

criarTabelas();

/* ================= LOGIN ================= */

app.post("/login", async(req,res)=>{

  try{

    const {username,password} = req.body;

    const r = await pool.query(
      "SELECT * FROM users WHERE username=$1",
      [username]
    );

    if(!r.rows.length)
      return res.status(400).json({error:"Usuário inválido"});

    const user = r.rows[0];

    const ok = await bcrypt.compare(password,user.password);

    if(!ok)
      return res.status(400).json({error:"Senha inválida"});

    const token = jwt.sign(
      {id:user.id, role:user.role},
      SECRET,
      {expiresIn:"30m"}
    );

    res.json({token, role:user.role});

  }catch(err){
    console.log(err);
    res.status(500).json({error:"Erro login"});
  }
});

/* ================= PRODUTOS ================= */

app.get("/products",authenticateToken, async(req,res)=>{
  const result = await pool.query(
    "SELECT * FROM products ORDER BY id DESC"
  );
  res.json(result.rows);
});

app.get("/products/next-code",authenticateToken, async(req,res)=>{

  const r = await pool.query(`
  SELECT MAX(CAST(codigo AS INTEGER)) as ultimo
  FROM products WHERE codigo ~ '^[0-9]+$'
  `);

  const next = Number(r.rows[0].ultimo||0)+1;

  res.json({codigo:String(next).padStart(4,"0")});
});

/* CREATE */

app.post("/products", authenticateToken, async(req,res)=>{

  const p = req.body;

  const precoCusto = parseFloat(p.preco_custo) || 0;
  const precoVenda = parseFloat(p.preco_venda) || 0;

  // 🔥 VARIAÇÃO AUTOMÁTICA NO BACKEND
  let variacao = "0%";

  if(precoCusto > 0){
    variacao =
      (((precoVenda - precoCusto) / precoCusto) * 100)
      .toFixed(2) + "%";
  }

  const result = await pool.query(`
    INSERT INTO products
    (codigo,nome,fornecedor,sku,cor,tamanho,
    estoque,preco_custo,preco_venda,variacao,barcode,ano)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    RETURNING *
  `,[
    p.codigo||"",
    p.nome||"",
    p.fornecedor||"",
    p.sku||"",
    p.cor||"",
    p.tamanho||"",
    parseInt(p.estoque)||0,
    precoCusto,
    precoVenda,
    variacao,   // 🔥 agora vem automático
    p.barcode||"",
    parseInt(p.ano)||null
  ]);

  res.json(result.rows[0]);
});

/* DELETE */

app.delete("/products/:id",authenticateToken, async(req,res)=>{
  await pool.query("DELETE FROM products WHERE id=$1",[req.params.id]);
  res.json({success:true});
});

/* ================= FORNECEDORES ================= */

app.get("/suppliers",authenticateToken, async(req,res)=>{
  const r = await pool.query(
    "SELECT * FROM suppliers ORDER BY nome"
  );
  res.json(r.rows);
});

app.post("/suppliers",authenticateToken, async(req,res)=>{
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

app.delete("/suppliers/:id",authenticateToken, async(req,res)=>{
  await pool.query(
    "DELETE FROM suppliers WHERE id=$1",
    [req.params.id]
  );
  res.json({success:true});
});

/* ================= EXCEL IMPORT ================= */

/* ================= EXCEL IMPORT ================= */

const upload = multer({ storage: multer.memoryStorage() });

app.post(
  "/products/import-excel",
  authenticateToken,
  upload.single("file"),
  async (req,res)=>{

  try{

    if(!req.file)
      return res.status(400).json({error:"Arquivo não enviado"});

    const workbook = XLSX.read(req.file.buffer,{type:"buffer"});
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const dados = XLSX.utils.sheet_to_json(sheet,{
  defval: ""
  
});


    // pega último código UMA VEZ só
    const r = await pool.query(`
      SELECT MAX(CAST(codigo AS INTEGER)) as ultimo
      FROM products
      WHERE codigo ~ '^[0-9]+$'
    `);

    let contador = Number(r.rows[0].ultimo || 0);

    for(const item of dados){

      contador++;
      const codigo = String(contador).padStart(4,"0");

      await pool.query(`
        INSERT INTO products
        (codigo,nome,fornecedor,sku,cor,tamanho,
        estoque,preco_custo,preco_venda,barcode,ano)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      `,[
        codigo,
        item.NOME || item.Nome || "",
        item.FORNECEDOR || item.Fornecedor || "",
        item.SKU || item.Sku || "",
        item.COR || item.Cor || "",
        item.TAMANHO || item.Tamanho || "",
        parseInt(item.ESTOQUE || item.Estoque) || 0,
        parseFloat(String(item.CUSTO || item.Custo || 0).replace(",",".")) || 0,
        parseFloat(String(item.VENDA || item.Venda || 0).replace(",",".")) || 0,
        item.NCM || "",
        parseInt(item.ANO || item.Ano) || null
      ]);

    }

    res.json({success:true});

  }catch(err){
    console.log(err);
    res.status(500).json({error:"Erro importar"});
  }

});


app.post("/products/delete-all", async (req, res) => {

  const { username, password } = req.body;

  if(!username || !password)
    return res.status(400).json({error:"Usuário e senha obrigatórios"});

  try {

    const r = await pool.query(
      "SELECT * FROM users WHERE username=$1",
      [username]
    );

    if(!r.rows.length)
      return res.status(401).json({error:"Usuário inválido"});

    const user = r.rows[0];

    const ok = await bcrypt.compare(password, user.password);

    if(!ok)
      return res.status(401).json({error:"Senha incorreta"});

    await pool.query("DELETE FROM products");

    res.json({success:true});

  } catch(err){
    console.log(err);
    res.status(500).json({error:"Erro ao excluir"});
  }
});


/* ================= ROOT ================= */

app.get("/", (req,res)=>{
  res.sendFile(path.join(__dirname,"../frontend/login.html"));
});

/* ================= START ================= */

app.listen(process.env.PORT||3000,()=>{
 console.log("Servidor rodando");
});
