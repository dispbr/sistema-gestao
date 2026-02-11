const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const SECRET = "chave_super_secreta";
const db = new sqlite3.Database("banco.db");

// LOGIN
app.post("/login", (req, res) => {
  const { usuario, senha } = req.body;

  db.get("SELECT * FROM usuarios WHERE usuario = ?", [usuario], async (err, user) => {
    if (!user) return res.status(401).json({ erro: "Usuário inválido" });

    const senhaValida = await bcrypt.compare(senha, user.senha);

    if (!senhaValida)
      return res.status(401).json({ erro: "Senha inválida" });

    const token = jwt.sign(
      { id: user.id, usuario: user.usuario, nivel: user.nivel },
      SECRET,
      { expiresIn: "30m" } // expira em 30 minutos
    );

    res.json({ token });
  });
});

app.listen(3000, () =>
  console.log("Servidor rodando em http://localhost:3000")
);
