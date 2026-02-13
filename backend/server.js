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
  if(!token) return res.status(401).json({error:"Token não enviado"});

  jwt.verify(token, SECRET,(err,user)=>{
    if(err) return res.status(403).json({error:"Token inválido"});
    req.user=user;
    next();
  });
}

/* ================= TABELAS ================= */

async function criarTabelas(){

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
}

criarTabelas();

/* ================= PRODUTOS ================= */

app.get("/products",authenticateToken, async(req,res)=>{
  const result = await pool.query("SELECT * FROM products ORDER BY id DESC");
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

  const p=req.body;

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
    parseFloat(p.preco_custo)||0,
    parseFloat(p.preco_venda)||0,
    p.variacao||"",
    p.barcode||"",
    parseInt(p.ano)||null
  ]);

  res.json(result.rows[0]);
});

/* INLINE UPDATE */

app.put("/products/:id/campo", authenticateToken, async(req,res)=>{

  const {campo,valor}=req.body;

  const camposPermitidos=[
    "nome","fornecedor","sku","cor","tamanho",
    "estoque","preco_custo","preco_venda",
    "barcode","ano"
  ];

  if(!camposPermitidos.includes(campo))
    return res.status(400).json({error:"Campo inválido"});

  await pool.query(
   `UPDATE products SET ${campo}=$1 WHERE id=$2`,
   [valor,req.params.id]
  );

  res.json({success:true});
});

/* DELETE */

app.delete("/products/:id",authenticateToken, async(req,res)=>{
  await pool.query("DELETE FROM products WHERE id=$1",[req.params.id]);
  res.json({success:true});
});

/* ================= EXCEL IMPORT ================= */

const upload = multer({ storage: multer.memoryStorage() });

app.post("/products/import-excel",
 authenticateToken,
 upload.single("file"),
 async(req,res)=>{

 try{

   const workbook = XLSX.read(req.file.buffer,{type:"buffer"});
   const sheet = workbook.Sheets[workbook.SheetNames[0]];
   const dados = XLSX.utils.sheet_to_json(sheet);

   for(const item of dados){

     const codigo = String(item.CODIGO||"").trim();
     if(!codigo) continue;

     const existe = await pool.query(
      "SELECT id FROM products WHERE codigo=$1",[codigo]
     );

     if(existe.rows.length){

       await pool.query(`
       UPDATE products SET
       nome=$1,fornecedor=$2,sku=$3,cor=$4,tamanho=$5,
       estoque=$6,preco_custo=$7,preco_venda=$8,
       barcode=$9,ano=$10
       WHERE codigo=$11
       `,[
        item.NOME||"",
        item.FORNECEDOR||"",
        item.SKU||"",
        item.COR||"",
        item.TAMANHO||"",
        parseInt(item.ESTOQUE)||0,
        parseFloat(item.CUSTO)||0,
        parseFloat(item.VENDA)||0,
        item.NCM||"",
        parseInt(item.ANO)||null,
        codigo
       ]);

     }else{

       await pool.query(`
       INSERT INTO products
       (codigo,nome,fornecedor,sku,cor,tamanho,
       estoque,preco_custo,preco_venda,barcode,ano)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       `,[
        codigo,
        item.NOME||"",
        item.FORNECEDOR||"",
        item.SKU||"",
        item.COR||"",
        item.TAMANHO||"",
        parseInt(item.ESTOQUE)||0,
        parseFloat(item.CUSTO)||0,
        parseFloat(item.VENDA)||0,
        item.NCM||"",
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

app.listen(process.env.PORT||3000,()=>{
 console.log("Servidor rodando");
});
