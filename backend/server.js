let importProgress = {
  total: 0,
  atual: 0,
  status: "idle"
};

let lixeira = [];



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
app.use(express.static(path.join(__dirname,"../frontend")));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:{ rejectUnauthorized:false }
});

const SECRET = process.env.JWT_SECRET || "supersecretkey";

/* ================= AUTH ================= */

function authenticateToken(req,res,next){
  const token = req.headers.authorization?.split(" ")[1];
  if(!token) return res.status(401).json({error:"Token não enviado"});

  jwt.verify(token,SECRET,(err,user)=>{
    if(err) return res.status(403).json({error:"Token inválido"});
    req.user=user;
    next();
  });
}

/* ================= TABELAS ERP ================= */

async function criarTabelas(){

await pool.query(`
CREATE TABLE IF NOT EXISTS products(
 id SERIAL PRIMARY KEY,
 codigo INTEGER UNIQUE,
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

console.log("ERP DATABASE OK");
}

criarTabelas();

/* ================= PRODUTOS ================= */

app.get("/products",authenticateToken, async(req,res)=>{
 const r = await pool.query("SELECT * FROM products ORDER BY codigo DESC");
 res.json(r.rows);
});

/* 🔥 código automático REAL */
app.get("/products/next-code",authenticateToken, async(req,res)=>{
 const r = await pool.query("SELECT COALESCE(MAX(codigo),0)+1 as next FROM products");
 res.json({codigo:String(r.rows[0].next).padStart(4,"0")});
});

/* CREATE */

app.post("/products",authenticateToken, async(req,res)=>{

 const p=req.body;

 const r = await pool.query(`
 INSERT INTO products
 (codigo,nome,fornecedor,sku,cor,tamanho,
 estoque,preco_custo,preco_venda,variacao,barcode,ano)
 VALUES(
 (SELECT COALESCE(MAX(codigo),0)+1 FROM products),
 $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11
 )
 RETURNING *
 `,[
  p.nome||"",
  p.fornecedor||"",
  p.sku||"",
  p.cor||"",
  p.tamanho||"",
  parseInt(p.estoque)||0,
  parseFloat(p.preco_custo)||0,
  parseFloat(p.preco_venda)||0,
  p.variacao||"",
  p.barcode||"",
  parseInt(p.ano)||null
 ]);

 res.json(r.rows[0]);
});

/* INLINE */

app.put("/products/:id/campo",authenticateToken, async(req,res)=>{

 const {campo,valor}=req.body;

 const permitidos=[
  "nome","fornecedor","sku","cor","tamanho",
  "estoque","preco_custo","preco_venda",
  "barcode","ano"
 ];

 if(!permitidos.includes(campo))
  return res.status(400).json({error:"Campo inválido"});

 await pool.query(
  `UPDATE products SET ${campo}=$1 WHERE id=$2`,
  [valor,req.params.id]
 );

 res.json({success:true});
});

/* DELETE */

app.delete("/products/:id",authenticateToken, async(req,res)=>{

  const produto = await pool.query(
    "SELECT * FROM products WHERE id=$1",
    [req.params.id]
  );

  if(produto.rows.length){
    lixeira.push(produto.rows[0]);

    if(lixeira.length > 20)
      lixeira.shift();
  }

  await pool.query("DELETE FROM products WHERE id=$1",[req.params.id]);

  res.json({success:true});
});

app.post("/products/undo-delete", authenticateToken, async(req,res)=>{

  if(!lixeira.length)
    return res.status(400).json({error:"Nada para restaurar"});

  const p = lixeira.pop();

  await pool.query(`
    INSERT INTO products
    (codigo,nome,fornecedor,sku,cor,tamanho,
     estoque,preco_custo,preco_venda,variacao,
     barcode,ano)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
  `,[
    p.codigo,p.nome,p.fornecedor,p.sku,p.cor,p.tamanho,
    p.estoque,p.preco_custo,p.preco_venda,
    p.variacao,p.barcode,p.ano
  ]);

  res.json({success:true});
});

/* ================= EXCLUIR TUDO PRO ================= */

app.post("/products/delete-all",authenticateToken, async(req,res)=>{

 const {username,password}=req.body;

 const u = await pool.query(
  "SELECT * FROM users WHERE username=$1",[username]
 );

 if(!u.rows.length)
  return res.status(400).json({error:"Usuário inválido"});

 const ok = await bcrypt.compare(password,u.rows[0].password);

 if(!ok)
  return res.status(400).json({error:"Senha inválida"});

 await pool.query("TRUNCATE products RESTART IDENTITY");

 res.json({success:true});
});

/* ================= FORNECEDORES ================= */

app.get("/suppliers",authenticateToken, async(req,res)=>{
 const r=await pool.query("SELECT * FROM suppliers ORDER BY nome");
 res.json(r.rows);
});

app.post("/suppliers",authenticateToken, async(req,res)=>{
 try{
  await pool.query("INSERT INTO suppliers(nome) VALUES($1)",[req.body.nome]);
  res.json({success:true});
 }catch{
  res.status(400).json({error:"Já existe"});
 }
});

app.delete("/suppliers/:id",authenticateToken, async(req,res)=>{
 await pool.query("DELETE FROM suppliers WHERE id=$1",[req.params.id]);
 res.json({success:true});
});

/* ================= IMPORT EXCEL ERP ================= */

const upload = multer({storage:multer.memoryStorage()});

app.post("/products/import-excel",
 authenticateToken,
 upload.single("file"),
 async (req,res)=>{

 try{

   if(!req.file)
     return res.status(400).json({error:"Arquivo não enviado"});

   const workbook = XLSX.read(req.file.buffer,{type:"buffer"});
   const sheet = workbook.Sheets[workbook.SheetNames[0]];

   const dados = XLSX.utils.sheet_to_json(sheet,{ defval:"" });

   importProgress.total = dados.length;
   importProgress.atual = 0;
   importProgress.status = "running";

   for(const item of dados){

     const r = await pool.query(`
       SELECT COALESCE(MAX(codigo),0)+1 as next
       FROM products
     `);

     const codigo = r.rows[0].next;

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

       parseFloat(
         String(item.CUSTO || item.Custo || 0)
           .replace("R$", "")
           .replace(/\./g,"")
           .replace(",", ".")
       ) || 0,

       parseFloat(
         String(item.VENDA || item.Venda || 0)
           .replace("R$", "")
           .replace(/\./g,"")
           .replace(",", ".")
       ) || 0,

       item.NCM || "",
       parseInt(item.ANO || item.Ano) || null
     ]);

     importProgress.atual++;
   }

   importProgress.status = "done";

   res.json({success:true});

 }catch(err){
   console.log(err);
   importProgress.status="error";
   res.status(500).json({error:"Erro importar"});
 }
});

app.get("/products/import-progress", authenticateToken, (req,res)=>{
  res.json(importProgress);
});


/* ================= ROOT ================= */

app.get("/",(req,res)=>{
 res.sendFile(path.join(__dirname,"../frontend/login.html"));
});

/* ================= LOGIN ================= */

app.post("/login", async (req,res)=>{

  try{

    const { username, password } = req.body;

    const result = await pool.query(
      "SELECT * FROM users WHERE username=$1",
      [username]
    );

    if(!result.rows.length){
      return res.status(400).json({error:"Usuário inválido"});
    }

    const user = result.rows[0];

    const valid = await bcrypt.compare(password, user.password);

    if(!valid){
      return res.status(400).json({error:"Senha inválida"});
    }

    const token = jwt.sign(
      { id:user.id, role:user.role },
      SECRET,
      { expiresIn:"30m" }
    );

    res.json({
      token,
      role:user.role
    });

  }catch(err){
    console.log(err);
    res.status(500).json({error:"Erro no login"});
  }
});

/* ================= START ================= */

app.listen(process.env.PORT||3000,()=>{
 console.log("ERP MASTER PRO ONLINE 🚀");
});
