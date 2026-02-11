async function login() {
  const usuario = document.getElementById("usuario").value;
  const senha = document.getElementById("senha").value;
  const erro = document.getElementById("erro");
  const botao = document.querySelector(".btn-login");

  erro.style.display = "none";

  botao.disabled = true;
  setTimeout(() => botao.disabled = false, 3000);

  const res = await fetch("/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ usuario, senha })
  });

  const data = await res.json();

  if (data.token) {
    localStorage.setItem("token", data.token);
    window.location.href = "dashboard.html";
  } else {
    erro.style.display = "block";
    erro.textContent = data.erro || "Login inválido";
  }
}

function toggleSenha() {
  const input = document.getElementById("senha");
  input.type = input.type === "password" ? "text" : "password";
}
