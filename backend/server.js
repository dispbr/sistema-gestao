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

const upload = multer({ storage: multer.memoryStorage() });

let importProgress = { total:0, atual:0, status:"idle" };
let lixeira = [];



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



/* ================= DATABASE ================= */

async function criarTabelas(){

await pool.query(`
CREATE SEQUENCE IF NOT EXISTS products_codigo_seq START 1;
`);

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

await pool.query(`
CREATE TABLE IF NOT EXISTS users(
 id SERIAL PRIMARY KEY,
 username VARCHAR(100) UNIQUE,
 password TEXT,
 role VARCHAR(20) DEFAULT 'admin'
);
`);

await pool.query(`
SELECT setval(
'products_codigo_seq',
COALESCE((SELECT MAX(codigo) FROM products),0)
);
`);

console.log("ERP DATABASE OK 🚀");
}

criarTabelas();



/* ================= LOGIN ================= */

app.post("/login", async(req,res)=>{

 const {username,password}=req.body;

 const r=await pool.query(
  "SELECT * FROM users WHERE username=$1",[username]
 );

 if(!r.rows.length)
  return res.status(400).json({error:"Usuário inválido"});

 const ok=await bcrypt.compare(password,r.rows[0].password);

 if(!ok)
  return res.status(400).json({error:"Senha inválida"});

 const token=jwt.sign(
  {id:r.rows[0].id, role:r.rows[0].role},
  SECRET,
  {expiresIn:"30m"}
 );

 res.json({token});
});



/* ================= PRODUTOS ================= */

app.get("/products",authenticateToken, async(req,res)=>{
 const r=await pool.query("SELECT * FROM products ORDER BY codigo DESC");
 res.json(r.rows);
});

app.get("/products/next-code",authenticateToken, async(req,res)=>{

 const r=await pool.query(`
 SELECT nextval('products_codigo_seq') as next
 `);

 res.json({
  codigo:String(r.rows[0].next).padStart(4,"0")
 });
});



/* CREATE */

app.post("/products",authenticateToken, async(req,res)=>{

 const p=req.body;

 const r=await pool.query(`
 INSERT INTO products
 (codigo,nome,fornecedor,sku,cor,tamanho,
  estoque,preco_custo,preco_venda,variacao,barcode,ano)
 VALUES(
  nextval('products_codigo_seq'),
  $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11
 ) RETURNING *
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

 const p=await pool.query(
 "SELECT * FROM products WHERE id=$1",[req.params.id]
 );

 if(p.rows.length) lixeira.push(p.rows[0]);

 await pool.query("DELETE FROM products WHERE id=$1",[req.params.id]);

 res.json({success:true});
});



/* UNDO */

app.post("/products/undo-delete",authenticateToken, async(req,res)=>{

 if(!lixeira.length)
  return res.status(400).json({error:"Nada"});

 const p=lixeira.pop();

 await pool.query(`
 INSERT INTO products
 (codigo,nome,fornecedor,sku,cor,tamanho,
 estoque,preco_custo,preco_venda,variacao,barcode,ano)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
 `,[
 p.codigo,p.nome,p.fornecedor,p.sku,p.cor,p.tamanho,
 p.estoque,p.preco_custo,p.preco_venda,
 p.variacao,p.barcode,p.ano
 ]);

 res.json({success:true});
});



/* EXCLUIR TUDO */

app.post("/products/delete-all",authenticateToken, async(req,res)=>{

 const {username,password}=req.body;

 const u=await pool.query(
 "SELECT * FROM users WHERE username=$1",[username]
 );

 if(!u.rows.length) return res.json({success:false});

 const ok=await bcrypt.compare(password,u.rows[0].password);

 if(!ok) return res.json({success:false});

 await pool.query("TRUNCATE products RESTART IDENTITY");
 await pool.query("ALTER SEQUENCE products_codigo_seq RESTART WITH 1");

 res.json({success:true});
});



/* ================= IMPORT EXCEL ERP ================= */

function parseMoney(v){
 if(!v) return 0;
 return parseFloat(
 String(v)
 .replace("R$","")
 .replace(/\./g,"")
 .replace(",",".")
 )||0;
}

function pick(obj,...names){
 for(const n of names){
  if(obj[n]!==undefined) return obj[n];
 }
 return "";
}

app.post("/products/import-excel",
 authenticateToken,
 upload.single("file"),
 async(req,res)=>{

 try{

  const workbook=XLSX.read(req.file.buffer,{type:"buffer"});
  const sheet=workbook.Sheets[workbook.SheetNames[0]];

  const dados=XLSX.utils.sheet_to_json(sheet,{defval:""});

  importProgress.total=dados.length;
  importProgress.atual=0;
  importProgress.status="running";

  for(const item of dados){

   const nome=pick(item,"NOME","Nome","nome");
   if(!nome) continue;

   await pool.query(`
   INSERT INTO products
   (codigo,nome,fornecedor,sku,cor,tamanho,
    estoque,preco_custo,preco_venda,barcode,ano)
   VALUES(
    nextval('products_codigo_seq'),
    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10
   )
   `,[
    nome,
    pick(item,"FORNECEDOR","Fornecedor"),
    pick(item,"SKU","Sku"),
    pick(item,"COR","Cor"),
    pick(item,"TAMANHO","Tamanho"),
    parseInt(pick(item,"ESTOQUE","Estoque"))||0,
    parseMoney(pick(item,"CUSTO","Preço Custo")),
    parseMoney(pick(item,"VENDA","Preço Venda")),
    pick(item,"NCM"),
    parseInt(pick(item,"ANO","Ano"))||null
   ]);

   importProgress.atual++;
  }

  importProgress.status="done";

  res.json({success:true});

 }catch(err){
  console.log(err);
  importProgress.status="error";
  res.status(500).json({error:"Erro importar"});
 }
});

app.get("/products/import-progress",authenticateToken,(req,res)=>{
 res.json(importProgress);
});



/* ================= FORNECEDORES ================= */

app.get("/suppliers",authenticateToken, async(req,res)=>{
 const r=await pool.query("SELECT * FROM suppliers ORDER BY nome");
 res.json(r.rows);
});

app.post("/suppliers",authenticateToken, async(req,res)=>{
 await pool.query("INSERT INTO suppliers(nome) VALUES($1)",[req.body.nome]);
 res.json({success:true});
});



/* ================= ROOT ================= */

app.get("/",(req,res)=>{
 res.sendFile(path.join(__dirname,"../frontend/login.html"));
});


/* ================= START ================= */

app.listen(process.env.PORT||3000,()=>{
 console.log("ERP MASTER PRO ONLINE 🚀");
});
