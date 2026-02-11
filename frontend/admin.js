async function carregarUsuarios(){
  const token = localStorage.getItem("token");

  const res = await fetch("/usuarios",{
    headers:{
      "Authorization": "Bearer " + token
    }
  });

  if(res.status === 403){
    alert("Apenas admin pode acessar");
    return;
  }

  const data = await res.json();

  const lista = document.getElementById("lista");
  lista.innerHTML = "";

  data.forEach(u=>{
    const li = document.createElement("li");
    li.innerText = u.usuario + " (" + u.nivel + ")";
    lista.appendChild(li);
  });
}

function logout(){
  localStorage.removeItem("token");
  window.location.href="login.html";
}
